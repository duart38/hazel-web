import type { RawMeta } from './meta'

export type Matrix3 = [number, number, number, number, number, number, number, number, number]

/** linear sRGB (D65) → XYZ */
const XYZ_FROM_SRGB: Matrix3 = [0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227]

/** A correction measured against Apple's raw developer (CIRAWFilter, decoder 7) on Duart's 40
 *  X1D raws, least squares in linear light with each pixel's error relative to its brightness (so
 *  dark, warm night scenes count as much as bright ones): Apple's X1D colour is a little more
 *  saturated in red and renders saturated orange more yellow than the plain DNG matrix. Fitted on
 *  half the photos it cuts the error on the other half by a sixth. */
const APPLE_CORRECTION: Matrix3 = [1.0537, -0.2089, 0.181, -0.0303, 1.0826, -0.04, -0.0232, -0.0087, 1.0449]

/** Apple's default rendering of a raw (its "boost" curve and baseline exposure), measured on the
 *  same photos: linear sRGB in, sRGB-encoded out. Samples at log2(x) = -14 + 14·i/112. */
export const TONE_LOG2_MIN = -14
export const TONE_CURVE = new Float32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0.001, 0.0026, 0.0057, 0.009, 0.0126, 0.0166, 0.021, 0.0261, 0.0318, 0.0381, 0.045, 0.0518, 0.0589, 0.066,
  0.0733, 0.0812, 0.0893, 0.0979, 0.1068, 0.1162, 0.126, 0.1363, 0.1472, 0.1586, 0.1708, 0.1837, 0.1971, 0.2116, 0.2266,
  0.2426, 0.2596, 0.2773, 0.2965, 0.3163, 0.337, 0.3584, 0.3804, 0.4037, 0.4275, 0.4524, 0.4775, 0.5027, 0.5284, 0.5547,
  0.5814, 0.6083, 0.6355, 0.6618, 0.6883, 0.7129, 0.7377, 0.7614, 0.7843, 0.8071, 0.8278, 0.8483, 0.8672, 0.8853, 0.9031,
  0.9189, 0.9347, 0.9487, 0.9611, 0.9723, 0.9817, 0.9902, 0.9947, 1,
])

export function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9).fill(0) as Matrix3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  }
  return out
}

export function invert(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('colour matrix is singular')
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

/** Camera RGB (white balanced) → linear sRGB, the way dcraw does it: rows of camera←sRGB scaled
 *  to sum to 1 so white stays white, inverted; then Apple's correction. */
export function cameraToSrgb(colorMatrix: number[]): Matrix3 {
  const camFromSrgb = multiply(colorMatrix.slice(0, 9) as Matrix3, XYZ_FROM_SRGB)
  for (let r = 0; r < 3; r++) {
    const sum = camFromSrgb[r * 3] + camFromSrgb[r * 3 + 1] + camFromSrgb[r * 3 + 2]
    for (let c = 0; c < 3; c++) camFromSrgb[r * 3 + c] /= sum
  }
  return multiply(APPLE_CORRECTION, invert(camFromSrgb))
}

/** What the developer needs, free of the file: plain numbers that can cross to a worker. */
export interface DevelopParams {
  crop: { x: number; y: number; width: number; height: number }
  cfa: [number, number, number, number]
  black: [number, number, number, number]
  white: number
  /** White balance multipliers, the smallest 1. */
  wb: [number, number, number]
  matrix: Matrix3
  orientation: number
  iso: number
  /** Subtracted from linear sRGB before the tone curve; see `shadowShift`. */
  shadowShift: number
}

/** Apple's shadows behave as if its black point were set before its baseline exposure: on a file
 *  whose white level is below full scale (the X1D's ISO 6400, one stop down) the curve's black
 *  point lands that much higher in the normalised picture. Without it ISO 6400 shadows come out
 *  lifted and, blue being the weakest channel in warm light, bluer by 5–7/255 (neutrals agree
 *  within 2/255 either way). Fitted on that one photo; 0 at every other ISO. */
export const SHADOW_SHIFT_PER_STOP = 0.0015
export function shadowShift(white: number, black: number): number {
  const push = (65535 - black) / Math.max(1, white - black)
  return push > 1.01 ? SHADOW_SHIFT_PER_STOP * (push - 1) : 0
}

export function developParams(meta: RawMeta): DevelopParams {
  const inv = meta.asShotNeutral.map((v) => 1 / v)
  const least = Math.min(...inv)
  return {
    crop: meta.crop,
    cfa: meta.cfa,
    black: meta.black,
    white: meta.white,
    wb: [inv[0] / least, inv[1] / least, inv[2] / least],
    matrix: cameraToSrgb(meta.colorMatrix),
    orientation: meta.orientation,
    iso: meta.info.iso ?? 100,
    shadowShift: shadowShift(meta.white, Math.min(...meta.black)),
  }
}

/** The tone curve as a function, for the CPU path and tests. */
export function tone(linear: number): number {
  if (!(linear > 0)) return 0
  const t = ((Math.log2(linear) - TONE_LOG2_MIN) / -TONE_LOG2_MIN) * (TONE_CURVE.length - 1)
  if (t <= 0) return TONE_CURVE[0]
  if (t >= TONE_CURVE.length - 1) return 1
  const i = Math.floor(t)
  return TONE_CURVE[i] + (TONE_CURVE[i + 1] - TONE_CURVE[i]) * (t - i)
}

/** Shot-noise strength in the square-root domain, relative to a 0..1 signal. Grows with ISO;
 *  the X1D's ISO 6400 halves the white level, which the normalisation already accounts for. */
export function noiseSigma(iso: number): number {
  return 0.0035 * Math.sqrt(Math.max(iso, 50) / 100)
}

/** How hard each stage of the developer works, for one photo and noise reduction setting. */
export interface DevelopTuning {
  /** Noise of one developed pixel, square-root domain. */
  sigma: number
  /** Noise of one raw sample, for the hot-pixel test. */
  rawSigma: number
  lumaAmount: number
  /** Range of the luma bilateral filter, square-root domain. */
  lumaRange: number
  chromaAmount: number
  chromaRange: number
  /** Strength of the wide colour noise reduction on the small picture (0 = off). */
  lowAmount: number
  lowSigma: number
  /** Chroma range of that filter, in multiples of lowSigma. */
  lowChromaRange: number
  /** How far colour close to the smoothed small picture's is replaced by it (0..1), not only
   *  corrected by its wide change: at ISO 6400 the blotches a few pixels across are left
   *  otherwise. */
  lowReplace: number
  /** Unsharp mask of the square-root luma (0 = off), its Gaussian radius in pixels and the
   *  largest change it may make. */
  sharpenAmount: number
  sharpenRadius: number
  sharpenLimit: number
}

/** `noiseReduction` runs from -1 (none) through 0 (like Apple's default) to +1 (strong).
 *  Measured against Apple's raw developer at 100 %: it smooths the finest luma noise in flat areas
 *  noticeably (its grain is coarser than a pixel) and then sharpens with a radius of about
 *  1.7 pixels; previews are binned and already match its detail, so they are not sharpened. */
export function developTuning(iso: number, noiseReduction: number, binned: boolean): DevelopTuning {
  const nr = Math.max(-1, Math.min(1, noiseReduction))
  const more = Math.max(0, nr)
  const rawSigma = noiseSigma(iso)
  const sigma = rawSigma * (binned ? 0.5 : 1)
  // Apple's luma smoothing gets relatively stronger above ISO 400
  const lumaRangeScale = 1.7 + 0.25 * Math.max(0, Math.log2(iso / 400))
  const lumaAmount = binned
    ? (nr >= 0 ? 0.3 + 0.7 * nr : 0.3 * (1 + nr))
    : (nr >= 0 ? 0.87 + 0.13 * nr : 0.87 * (1 + nr))
  const lumaRange = binned ? sigma * (1 + 2 * lumaAmount) : sigma * lumaRangeScale * (1 + 1.5 * more)
  const chroma = Math.min(1, 1 + nr)
  return {
    sigma,
    rawSigma,
    lumaAmount,
    lumaRange,
    // Apple's previews keep some pixel-scale colour; half strength matches them best
    chromaAmount: binned ? 0.5 * chroma : chroma,
    chromaRange: sigma * (6 + 6 * more),
    // below ISO 800 there are no blotches to remove, only faint real colour it would flatten;
    // in a binned preview the blotches are a pixel or two and Apple's previews keep that colour
    lowAmount: (binned ? 0 : 1) * chroma * Math.min(1, Math.max(0, Math.log2(iso / 400) / 2) + more),
    // a 4×4 block holds 4 samples of red or blue
    lowSigma: rawSigma / 2,
    lowChromaRange: 4 * (1 + more),
    lowReplace: 0.7 * Math.min(1, Math.max(0, Math.log2(iso / 1600) / 2 + more)),
    sharpenAmount: binned ? 0 : 0.9,
    sharpenRadius: 1.7,
    sharpenLimit: 0.04,
  }
}
