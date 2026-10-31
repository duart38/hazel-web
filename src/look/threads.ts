// look-threads.wasm on several threads: the look worker's own instance plus helper threads,
// every one an instance of the same module on one shared memory. look.c hands photo work out in
// bands of 16 rows through dispatch_apply_f (wasm/threads.c); a helper that never starts only
// means fewer hands, never a different picture.

import { LookWasm, lookImports, type HelperExports } from './wasm'

/** Each helper's stack: as large as the first thread's (wasm/build.sh). */
export const HELPER_STACK = 2 ** 20

/** Threads in all at most. A 12 MP picture is 188 bands; past this the gain is small. */
export const MAX_THREADS = 16

/** Whether this page or worker can share WebAssembly memory between threads: it needs
 *  cross-origin isolation: the COOP and COEP headers, from vercel.json and vite.config.ts. */
export function threadsPossible(): boolean {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true
}

/** How many threads to use here, the first one included. */
export function threadCount(): number {
  const cores = typeof navigator === 'object' ? navigator.hardwareConcurrency || 1 : 1
  return Math.max(1, Math.min(cores, MAX_THREADS))
}

/** The memory look-threads.wasm imports: 4 MB to start, up to 4 GB like look.wasm. */
export function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true })
}

/** What a helper is sent, once. */
export interface HelperStart {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  /** The top of its stack in the shared memory (stacks grow down). */
  stackTop: number
}

/** A helper thread, as its starter sees it. */
export interface Helper {
  /** Resolves once the helper is waiting for work. */
  ready: Promise<void>
  terminate(): void
}

function isHelperExports(exports: WebAssembly.Exports): exports is WebAssembly.Exports & HelperExports {
  return exports.__stack_pointer instanceof WebAssembly.Global && typeof exports.hz_helper_main === 'function'
}

/** A helper thread's whole life, on that thread: its own instance with its own stack, then
 *  look.c's work whenever there is some. Calls `ready` and never returns. */
export function runHelper(start: HelperStart, ready: () => void): void {
  const { exports } = new WebAssembly.Instance(start.module, lookImports(start.memory))
  if (!isHelperExports(exports)) throw new Error('look-threads.wasm is missing its helper exports')
  exports.__stack_pointer.value = start.stackTop
  ready()
  exports.hz_helper_main()
}

export class LookThreads {
  readonly look: LookWasm
  private readonly helpers: Helper[]
  private started = 0

  private constructor(look: LookWasm, helpers: Helper[]) {
    this.look = look
    this.helpers = helpers
  }

  /** look-threads.wasm on `threads` threads, the caller's included: the helpers come from
   *  `spawn` (a Worker in the browser). Waits up to `wait` ms for them to start; the ones that
   *  haven't by then join whenever they do. */
  static async start(
    module: WebAssembly.Module,
    threads: number,
    spawn: (start: HelperStart) => Helper,
    wait = 5000,
  ): Promise<LookThreads> {
    const memory = sharedMemory()
    const look = new LookWasm(module, memory)
    const helpers: Helper[] = []
    const pool = new LookThreads(look, helpers)
    try {
      for (let i = 1; i < threads; i++) {
        const stack = look.reserve(HELPER_STACK + 16)
        const stackTop = Math.floor((stack + HELPER_STACK) / 16) * 16
        const helper = spawn({ module, memory, stackTop })
        helpers.push(helper)
        helper.ready.then(() => pool.started++, () => undefined)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(helpers.map((h) => h.ready)),
        new Promise((resolve) => (timer = setTimeout(resolve, wait))),
      ])
      clearTimeout(timer)
    } catch (error) {
      pool.dispose()
      throw error
    }
    return pool
  }

  /** Threads working on a picture: this one and the helpers that have started. */
  get threads(): number {
    return 1 + this.started
  }

  dispose(): void {
    for (const helper of this.helpers.splice(0)) helper.terminate()
  }
}
