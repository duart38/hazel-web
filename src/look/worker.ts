// The worker that runs look_apply_image, so a 50 MP picture never blocks the page. When the page
// is cross-origin isolated it runs look-threads.wasm on helper threads too (threads.ts); when it
// isn't, or the threads can't start, look.wasm on this thread alone. Same picture either way.

import { LookWasm } from './wasm'
import { loadLookModule } from './load'
import { LookThreads, threadCount, threadsPossible, type Helper, type HelperStart } from './threads'
import type { FromWorker, ToWorker } from './protocol'
import lookThreadsWasmUrl from './wasm/look-threads.wasm?url'

interface WorkerScope {
  postMessage(message: FromWorker, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope

// WebAssembly memory never shrinks. After a big picture the instance (and its helpers) is
// dropped, so its memory can be collected, and the next call makes a fresh one (quick: the
// modules are compiled once).
const KEEP_MEMORY_BELOW = 512 * 2 ** 20

interface Engine {
  look: LookWasm
  threads: number
  dispose(): void
}

let module: WebAssembly.Module | null = null
let threadedModule: Promise<WebAssembly.Module> | null = null
let threadsFailed = false
let reported = false
let engine: Engine | null = null
let source: { id: number; pixels: Float32Array } | null = null

function spawnHelper(start: HelperStart): Helper {
  const worker = new Worker(new URL('./helper.ts', import.meta.url), { type: 'module', name: 'look helper' })
  const ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve()
    worker.onerror = (event) => {
      event.preventDefault()
      reject(new Error(event.message || 'a look helper failed to start'))
    }
  })
  worker.postMessage(start)
  return { ready, terminate: () => worker.terminate() }
}

async function startEngine(single: WebAssembly.Module): Promise<Engine> {
  if (!threadsFailed && threadsPossible() && threadCount() > 1) {
    try {
      threadedModule ??= loadLookModule(lookThreadsWasmUrl)
      const pool = await LookThreads.start(await threadedModule, threadCount(), spawnHelper)
      if (!reported) console.info(`Hazel look engine: ${pool.threads} threads`)
      reported = true
      return { look: pool.look, threads: pool.threads, dispose: () => pool.dispose() }
    } catch (error) {
      threadsFailed = true
      console.warn('Hazel look engine: no threads, one thread instead', error)
    }
  }
  return { look: new LookWasm(single), threads: 1, dispose: () => undefined }
}

async function handle(message: ToWorker): Promise<void> {
  if (message.type === 'init') {
    module = message.module
    return
  }
  const { id, settings, width, height } = message
  try {
    if (message.source) source = { id: message.sourceId, pixels: message.source }
    if (!source || source.id !== message.sourceId) throw new Error('The look worker lost the picture')
    if (!module) throw new Error('The look worker has no look.wasm')
    engine ??= await startEngine(module)
    const start = performance.now()
    const rgb = engine.look.applyImage(settings, source.pixels, width, height)
    const milliseconds = performance.now() - start
    scope.postMessage({ type: 'done', id, rgb, milliseconds, threads: engine.threads }, [rgb.buffer])
  } catch (error) {
    const { name, message: text } = error instanceof Error ? error : new Error(String(error))
    if (error instanceof RangeError || name === 'LookOutOfMemory') source = null
    scope.postMessage({ type: 'error', id, name, message: text }, [])
  } finally {
    if (engine && engine.look.memoryBytes > KEEP_MEMORY_BELOW) {
      engine.dispose()
      engine = null
    }
  }
}

// one message at a time, in order: starting the threads is the only wait
let queue = Promise.resolve()
scope.onmessage = (event) => {
  queue = queue.then(() => handle(event.data))
}
