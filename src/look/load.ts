// Fetching and compiling a look engine build: look.wasm, or look-threads.wasm in the worker.

import lookWasmUrl from './wasm/look.wasm?url'

/** Fetches and compiles look.wasm (about 53 kB), or the build at `url`. */
export async function loadLookModule(url: string = lookWasmUrl): Promise<WebAssembly.Module> {
  const response = fetch(url)
  try {
    return await WebAssembly.compileStreaming(response)
  } catch {
    // a server that doesn't say application/wasm
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer())
  }
}
