import type { DevelopedImage } from '../engine/types'
import { developCpu } from './develop-cpu'
import { GlDeveloper } from './develop-gl'
import type { DevelopRequest, Timings } from './protocol'
import { unpackRaw } from './rawdata'

// Runs inside the worker (or on the main thread where workers are missing): reads the strip,
// decodes it, keeps the last photo's samples so a preview followed by a full develop decodes once.

let cached: { key: string; data: Uint16Array } | null = null
let gl: GlDeveloper | null | undefined

function glDeveloper(): GlDeveloper | null {
  if (gl !== undefined) return gl
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null
    gl = canvas ? new GlDeveloper(canvas) : null
  } catch (error) {
    console.warn('Raw development falls back to the CPU:', error)
    gl = null
  }
  return gl
}

export function release(key: string): void {
  if (cached?.key === key) {
    cached = null
    gl?.release()
  }
}

export async function develop(request: DevelopRequest): Promise<{ image: DevelopedImage; timings: Timings }> {
  const { meta, params, options, key } = request
  const t0 = performance.now()
  let readMs = 0
  let decodeMs = 0
  if (cached?.key !== key) {
    cached = null
    gl?.release()
    const strip = new Uint8Array(await request.file.slice(meta.stripOffset, meta.stripOffset + meta.stripLength).arrayBuffer())
    readMs = performance.now() - t0
    const t1 = performance.now()
    cached = { key, data: unpackRaw(meta, strip) }
    decodeMs = performance.now() - t1
  }
  const t2 = performance.now()
  const raw = { data: cached.data, width: meta.rawWidth, height: meta.rawHeight }
  const developer = glDeveloper()
  let image: DevelopedImage
  let gpu = false
  if (developer) {
    try {
      image = developer.develop(raw, params, key, options)
      gpu = true
    } catch (error) {
      console.warn('GPU development failed, using the CPU:', error)
      image = developCpu(raw.data, raw.width, params, options.longSide)
    }
  } else {
    image = developCpu(raw.data, raw.width, params, options.longSide)
  }
  return { image, timings: { readMs, decodeMs, developMs: performance.now() - t2, gpu } }
}
