// The LookEngine (engine/types.ts): look.wasm on the main thread for the quick calls, and a
// worker with its own instance for look_apply_image.

import type { DevelopedImage, LookEngine, LookSettings } from '../engine/types'
import type { FromWorker, ToWorker } from './protocol'
import { sameRecipe } from './recipe'
import { LookWasm, LookOutOfMemory } from './wasm'
import { loadLookModule } from './load'

export { LookOutOfMemory, loadLookModule }

/** The look engine, ready to use. Pictures go through a worker, on several threads when the page
 *  is cross-origin isolated (worker.ts); where workers aren't available (tests in Node) they are
 *  done on this thread instead. */
export async function createLookEngine(): Promise<LookEngine> {
  return lookEngineFromModule(await loadLookModule())
}

export function lookEngineFromModule(
  module: WebAssembly.Module,
  options: { worker?: boolean } = {},
): LookEngine {
  const look = new LookWasm(module)
  const defaults = look.defaults()
  const useWorker = (options.worker ?? true) && typeof Worker !== 'undefined'
  const applier: Applier = useWorker ? new WorkerApplier(module) : new ThreadApplier(module)
  const mixBandNames = Object.freeze(look.mixBandNames())

  return {
    defaults: () => structuredClone(defaults),
    parse: (text) => look.parse(text).settings,
    format: (settings) => look.format(settings),
    applyImage: (settings, image) => applier.apply(structuredClone(settings), image),
    buildTable: (settings, n) => look.buildTable(settings, n),
    isMono: (settings) => look.isMono(settings),
    recognises: (line) => look.parse(line).recognised > 0,
    changesPicture: (settings) => !sameRecipe({ ...settings, seed: defaults.seed }, defaults),
    mixBandNames,
    gradeColour: (hue) => look.gradeColour(hue),
    mixBandColour: (band) => look.mixBandColour(band),
    cancelPending: () => applier.cancelPending(),
    dispose: () => applier.dispose(),
  }
}

interface Applier {
  apply(settings: LookSettings, image: DevelopedImage): Promise<DevelopedImage>
  cancelPending(): void
  dispose(): void
}

interface Job {
  settings: LookSettings
  image: DevelopedImage
  resolve(image: DevelopedImage): void
  reject(error: Error): void
}

const aborted = () => new DOMException('A newer picture was asked for', 'AbortError')

function checkImage(image: DevelopedImage): void {
  const { width, height, rgb } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError(`A ${width}×${height} picture`)
  if (rgb.length !== 3 * width * height) throw new RangeError(`${rgb.length} floats for a ${width}×${height} picture`)
}

/** One picture at a time, in order; calls waiting their turn can be cancelled. */
abstract class QueueApplier implements Applier {
  private readonly queue: Job[] = []
  private running = false

  apply(settings: LookSettings, image: DevelopedImage): Promise<DevelopedImage> {
    return new Promise((resolve, reject) => {
      checkImage(image)
      this.queue.push({ settings, image, resolve, reject })
      this.pump()
    })
  }

  cancelPending(): void {
    for (const job of this.queue.splice(0)) job.reject(aborted())
  }

  dispose(): void {
    this.cancelPending()
  }

  protected abstract run(job: Job): Promise<Float32Array>

  private pump(): void {
    if (this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = true
    this.run(job)
      .then((rgb) => job.resolve({ width: job.image.width, height: job.image.height, rgb }), job.reject)
      .finally(() => {
        this.running = false
        this.pump()
      })
  }
}

class ThreadApplier extends QueueApplier {
  private readonly module: WebAssembly.Module

  constructor(module: WebAssembly.Module) {
    super()
    this.module = module
  }

  protected async run(job: Job): Promise<Float32Array> {
    // its own instance, dropped afterwards, so a big picture's memory doesn't stay
    const look = new LookWasm(this.module)
    return look.applyImage(job.settings, job.image.rgb, job.image.width, job.image.height)
  }
}

class WorkerApplier extends QueueApplier {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve(rgb: Float32Array): void; reject(error: Error): void }>()
  // The worker keeps a copy of the last picture; pictures are known by their pixel array, which
  // a DevelopedImage never changes.
  private readonly sourceIds = new WeakMap<Float32Array, number>()
  private nextSourceId = 1
  private workerSourceId = 0
  private readonly module: WebAssembly.Module

  constructor(module: WebAssembly.Module) {
    super()
    this.module = module
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.type === 'done') {
        waiting.resolve(message.rgb)
      } else {
        this.workerSourceId = 0
        const error = new Error(message.message)
        error.name = message.name
        waiting.reject(error)
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      this.fail(new Error(`The look worker stopped: ${event.message || 'out of memory?'}`))
    }
    const init: ToWorker = { type: 'init', module: this.module }
    worker.postMessage(init)
    this.worker = worker
    this.workerSourceId = 0
    return worker
  }

  private fail(error: Error): void {
    this.worker?.terminate()
    this.worker = null
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }

  protected run(job: Job): Promise<Float32Array> {
    const worker = this.start()
    const { image } = job
    let sourceId = this.sourceIds.get(image.rgb)
    if (sourceId === undefined) {
      sourceId = this.nextSourceId++
      this.sourceIds.set(image.rgb, sourceId)
    }
    const id = this.nextId++
    const message: ToWorker = {
      type: 'apply',
      id,
      settings: job.settings,
      width: image.width,
      height: image.height,
      sourceId,
    }
    const transfer: Transferable[] = []
    if (sourceId !== this.workerSourceId) {
      message.source = image.rgb.slice()
      transfer.push(message.source.buffer)
      this.workerSourceId = sourceId
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage(message, transfer)
    })
  }

  dispose(): void {
    super.dispose()
    this.fail(new DOMException('The look engine was closed', 'AbortError'))
  }
}
