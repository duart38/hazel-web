import type { DevelopedImage } from '../engine/types'
import { tone, type DevelopParams } from './colour'
import { orientToRgb } from './orient'

/** Size of the developed picture before orientation, for a long side limit. */
export function outputSize(cropWidth: number, cropHeight: number, longSide?: number): { width: number; height: number } {
  const long = Math.max(cropWidth, cropHeight)
  if (!longSide || longSide >= long) return { width: cropWidth, height: cropHeight }
  const scale = Math.max(1, longSide) / long
  return { width: Math.max(1, Math.round(cropWidth * scale)), height: Math.max(1, Math.round(cropHeight * scale)) }
}

/** dcraw's highlight blend, as the GPU's pass A does it: where a white-balanced channel passed 1
 *  (the level every channel can reach) the pixel keeps its brightness and hue but only as much
 *  colour as its clipped version has. `saturation` is the highest nearby sample as a fraction of
 *  its channel's white point; next to the white point the other channels are lifted towards the
 *  clipped one. Works in place on rgb[0..2]. */
export function blendHighlights(rgb: Float64Array | number[], saturation: number): void {
  const t = Math.min(1, Math.max(0, (saturation - 0.9) / 0.1))
  if (t > 0) {
    const lift = t * t * (3 - 2 * t)
    const top = Math.max(rgb[0], rgb[1], rgb[2])
    for (let c = 0; c < 3; c++) rgb[c] += (top - rgb[c]) * lift
  }
  const [r, g, b] = rgb
  if (Math.max(r, g, b) <= 1) return
  const cr = Math.min(r, 1), cg = Math.min(g, 1), cb = Math.min(b, 1)
  let a1 = 1.7320508 * (r - g), a2 = 2 * b - r - g
  const length = Math.hypot(a1, a2)
  const ratio = length > 0 ? Math.hypot(1.7320508 * (cr - cg), 2 * cb - cr - cg) / length : 0
  a1 *= ratio
  a2 *= ratio
  const l = r + g + b
  rgb[0] = (l + 0.8660254 * a1 - 0.5 * a2) / 3
  rgb[1] = (l - 0.8660254 * a1 - 0.5 * a2) / 3
  rgb[2] = (l + a2) / 3
}

/** The fallback when WebGL2 (or rendering to float textures) is missing. Same colour, tone and
 *  highlight handling as the GPU path, but no noise reduction or sharpening. Up to half size every
 *  2×2 CFA cell becomes one pixel; larger sizes are demosaiced (Malvar-He-Cutler, bilinear next to
 *  clipped samples) at full resolution, a few seconds for a whole X1D frame. */
export function developCpu(raw: Uint16Array, rawWidth: number, p: DevelopParams, longSide?: number): DevelopedImage {
  const full = outputSize(p.crop.width, p.crop.height, longSide)
  const binned = full.width * 2 <= p.crop.width && full.height * 2 <= p.crop.height
  const srcW = binned ? p.crop.width >> 1 : p.crop.width
  const srcH = binned ? p.crop.height >> 1 : p.crop.height
  const target = binned ? outputSize(srcW, srcH, longSide ? Math.min(longSide, Math.max(srcW, srcH)) : undefined) : full
  const sx = target.width / srcW
  const sy = target.height / srcH
  const sum = new Float32Array(target.width * target.height * 3)
  const weight = new Float32Array(target.width * target.height)
  const scale = [0, 1, 2, 3].map((i) => p.wb[p.cfa[i]] / (p.white - p.black[i]))
  const ceiling = [0, 1, 2, 3].map((i) => p.wb[p.cfa[i]])
  const m = p.matrix
  const ox = p.crop.x, oy = p.crop.y
  const cw = p.crop.width, ch = p.crop.height
  const rgb = new Float64Array(3)
  let saturation = 0
  let nearClip = false

  /** White-balanced level of crop pixel (x, y), mirrored at the edges, clipped at its white point. */
  const level = (x: number, y: number): number => {
    x = Math.abs(x)
    y = Math.abs(y)
    if (x >= cw) x = 2 * (cw - 1) - x
    if (y >= ch) y = 2 * (ch - 1) - y
    const ax = ox + x, ay = oy + y
    const i = (ay & 1) * 2 + (ax & 1)
    const v = (raw[ay * rawWidth + ax] - p.black[i]) * scale[i]
    const fraction = v / ceiling[i]
    if (fraction > saturation) saturation = fraction
    if (fraction >= 0.995) nearClip = true
    return v < 0 ? 0 : v > ceiling[i] ? ceiling[i] : v
  }
  const colourAt = (x: number, y: number) => p.cfa[(((oy + y) & 1) * 2 + ((ox + x) & 1))]

  const add = (x: number, y: number) => {
    const tx = Math.min(target.width - 1, Math.floor(x * sx))
    const ty = Math.min(target.height - 1, Math.floor(y * sy))
    const t = ty * target.width + tx
    const r = rgb[0], g = rgb[1], b = rgb[2]
    sum[t * 3] += m[0] * r + m[1] * g + m[2] * b
    sum[t * 3 + 1] += m[3] * r + m[4] * g + m[5] * b
    sum[t * 3 + 2] += m[6] * r + m[7] * g + m[8] * b
    weight[t]++
  }

  const count = [0, 0, 0]
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      saturation = 0
      nearClip = false
      if (binned) {
        rgb[0] = rgb[1] = rgb[2] = 0
        count[0] = count[1] = count[2] = 0
        for (let k = 0; k < 4; k++) {
          const qx = 2 * x + (k & 1), qy = 2 * y + (k >> 1)
          const c = colourAt(qx, qy)
          rgb[c] += level(qx, qy)
          count[c]++
        }
        for (let c = 0; c < 3; c++) rgb[c] /= count[c] || 1
      } else {
        const C = level(x, y)
        const N = level(x, y - 1), S = level(x, y + 1), E = level(x + 1, y), W = level(x - 1, y)
        const diag = level(x + 1, y - 1) + level(x - 1, y - 1) + level(x + 1, y + 1) + level(x - 1, y + 1)
        const N2 = level(x, y - 2), S2 = level(x, y + 2), E2 = level(x + 2, y), W2 = level(x - 2, y)
        const k = nearClip ? 0 : 1
        const c = colourAt(x, y)
        if (c === 1) {
          const alongRow = 0.5 * (E + W) + k * (0.625 * C - 0.125 * (E2 + W2 + diag) + 0.0625 * (N2 + S2))
          const alongCol = 0.5 * (N + S) + k * (0.625 * C - 0.125 * (N2 + S2 + diag) + 0.0625 * (E2 + W2))
          const rowIsRed = colourAt(x > 0 ? x - 1 : x + 1, y) === 0
          rgb[0] = rowIsRed ? alongRow : alongCol
          rgb[1] = C
          rgb[2] = rowIsRed ? alongCol : alongRow
        } else {
          const cross2 = N2 + S2 + E2 + W2
          const g = 0.25 * (N + S + E + W) + k * (0.5 * C - 0.125 * cross2)
          const other = 0.25 * diag + k * (0.75 * C - 0.1875 * cross2)
          rgb[c] = C
          rgb[1] = g
          rgb[2 - c] = other
        }
        for (let i = 0; i < 3; i++) if (rgb[i] < 0) rgb[i] = 0
      }
      blendHighlights(rgb, saturation)
      add(x, y)
    }
  }
  for (let t = 0; t < weight.length; t++) {
    const w = weight[t] || 1
    for (let c = 0; c < 3; c++) sum[t * 3 + c] = tone(sum[t * 3 + c] / w - p.shadowShift)
  }
  return orientToRgb(sum, 3, target.width, target.height, p.orientation)
}
