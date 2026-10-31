// look-threads.wasm on four threads gives the native build's pictures, bit for bit, like
// look.wasm on one (parity.test.ts). Helpers are Node worker threads here, Workers in the browser.
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'
import { LookThreads, type Helper, type HelperStart } from './threads'

interface HashCase { name: string; input: string; width: number; height: number; fnv1a: number }

const read = (path: string) => readFileSync(new URL(path, import.meta.url))
const module = new WebAssembly.Module(read('./wasm/look-threads.wasm'))
const manifest: { hashes: HashCase[] } = JSON.parse(new TextDecoder().decode(read('./testdata/native.json')))

// runHelper (threads.ts) in plain JavaScript, for a Node worker thread
const HELPER = `
const { workerData, parentPort } = require('node:worker_threads')
const math = { pow: Math.pow, exp: Math.exp, cbrt: Math.cbrt, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, fmod: (x, y) => x % y }
const { exports } = new WebAssembly.Instance(workerData.module, { math, env: { memory: workerData.memory } })
exports.__stack_pointer.value = workerData.stackTop
parentPort.postMessage('ready')
exports.hz_helper_main()
`

function spawn(start: HelperStart): Helper {
  const worker = new Worker(HELPER, { eval: true, workerData: start })
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return { ready, terminate: () => void worker.terminate() }
}

function synthetic(width: number, height: number): Float32Array {
  const rgb = new Float32Array(3 * width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = 3 * (y * width + x)
      rgb[p] = ((x * 37 + y * 11) % 257) / 256
      rgb[p + 1] = ((x * 5 + y * 29) % 257) / 256
      rgb[p + 2] = ((x * x + y * 3) % 257) / 256
    }
  return rgb
}

function fnv1a(floats: Float32Array): number {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0
  return h
}

describe('look-threads.wasm', async () => {
  const pool = await LookThreads.start(module, 4, spawn)
  afterAll(() => pool.dispose())

  it('starts its helpers', () => {
    expect(pool.threads).toBe(4)
  })

  it.each(manifest.hashes.map((c) => [c.name, c]))('%s: look_apply_image, 400×600, four threads', (_, c) => {
    const { look } = pool
    const out = look.applyImage(look.parse(c.input).settings, synthetic(c.width, c.height), c.width, c.height)
    expect(fnv1a(out)).toBe(c.fnv1a)
  })
})
