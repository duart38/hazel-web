import type { DevelopedImage } from '../engine/types'

/** Copies `src` (w × h, `channels` floats a pixel, rows top first) into an upright RGB image,
 *  turned and mirrored as EXIF `orientation` says, clamped to 0..1. */
export function orientToRgb(src: Float32Array, channels: number, w: number, h: number, orientation: number,
  dst?: Float32Array, rowOffset = 0, rows = h, fullHeight = h): DevelopedImage {
  const swap = orientation >= 5 && orientation <= 8
  const outW = swap ? fullHeight : w
  const outH = swap ? w : fullHeight
  const out = dst ?? new Float32Array(outW * outH * 3)
  // where source pixel (x, y) lands: start + x * dx + y * dy, in pixels
  let start = 0, dx = 1, dy = outW
  switch (orientation) {
    case 2: start = outW - 1; dx = -1; dy = outW; break
    case 3: start = outW * outH - 1; dx = -1; dy = -outW; break
    case 4: start = (outH - 1) * outW; dx = 1; dy = -outW; break
    case 5: start = 0; dx = outW; dy = 1; break
    case 6: start = outW - 1; dx = outW; dy = -1; break
    case 7: start = outW * outH - 1; dx = -outW; dy = -1; break
    case 8: start = (outH - 1) * outW; dx = -outW; dy = 1; break
  }
  for (let y = 0; y < rows; y++) {
    const sy = y + rowOffset
    let d = start + sy * dy
    let s = y * w * channels
    for (let x = 0; x < w; x++, d += dx, s += channels) {
      const o = d * 3
      const r = src[s], g = src[s + 1], b = src[s + 2]
      out[o] = r < 0 ? 0 : r > 1 ? 1 : r
      out[o + 1] = g < 0 ? 0 : g > 1 ? 1 : g
      out[o + 2] = b < 0 ? 0 : b > 1 ? 1 : b
    }
  }
  return { width: outW, height: outH, rgb: out }
}
