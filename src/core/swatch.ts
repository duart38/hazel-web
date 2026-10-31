// Small pictures of what a recipe does, read from the table the look engine builds
// (look_build_rgb_table), so what they show is the recipe's own colour. The grading and mixer
// colours are drawing colours only, worked out the way look.c's look_grade_colour and
// look_mix_band_colour do, since the engine contract doesn't carry those two.

export type RGB = [number, number, number]

/** Everyday colours a recipe is judged by: skin, sky, foliage, a red, a yellow, and three greys. */
export const REFERENCE_COLOURS: RGB[] = [
  [0.85, 0.64, 0.52],
  [0.45, 0.62, 0.85],
  [0.36, 0.52, 0.28],
  [0.78, 0.2, 0.18],
  [0.92, 0.78, 0.25],
  [0.12, 0.12, 0.12],
  [0.5, 0.5, 0.5],
  [0.88, 0.88, 0.88],
]

/** A colour through a look table: n points per axis, RGB floats, red fastest. Trilinear. */
export function lookUp(table: Float32Array, n: number, rgb: RGB): RGB {
  const scaled = rgb.map((c) => Math.min(Math.max(c, 0), 1) * (n - 1))
  const lo = scaled.map((s) => Math.min(Math.floor(s), n - 2))
  const f = scaled.map((s, i) => s - lo[i])
  const out: RGB = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const dr = corner & 1
    const dg = (corner >> 1) & 1
    const db = (corner >> 2) & 1
    const weight = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2])
    if (weight === 0) continue
    const index = ((lo[2] + db) * n * n + (lo[1] + dg) * n + (lo[0] + dr)) * 3
    for (let c = 0; c < 3; c++) out[c] += weight * table[index + c]
  }
  return out
}

export function cssColour([r, g, b]: RGB): string {
  const byte = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255)
  return `rgb(${byte(r)} ${byte(g)} ${byte(b)})`
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

function linearToOklab([r, g, b]: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinear([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function colourOfLab(a: number, b: number): RGB {
  const lin = oklabToLinear([0.72, a, b])
  return lin.map((c) => linearToSrgb(Math.min(Math.max(c, 0), 1))) as RGB
}

/** The colour a grading tint adds, for a hue in degrees (0 red, 120 green, 240 blue). */
export function gradeColour(hue: number): RGB {
  let h = (hue % 360) / 60
  if (h < 0) h += 6
  const x = 1 - Math.abs((h % 2) - 1)
  const sector = Math.floor(h)
  const rgb: RGB =
    sector === 0 ? [1, x, 0] : sector === 1 ? [x, 1, 0] : sector === 2 ? [0, 1, x] : sector === 3 ? [0, x, 1] : sector === 4 ? [x, 0, 1] : [1, 0, x]
  const lab = linearToOklab(rgb.map(srgbToLinear) as RGB)
  const length = Math.hypot(lab[1], lab[2])
  return colourOfLab((0.12 * lab[1]) / length, (0.12 * lab[2]) / length)
}

/** The Oklab hue of each mixer band, as in look.c's MIX_BANDS. */
const BAND_HUES = [29.2, 53, 109.8, 142.5, 194.8, 264.1, 293.9, 328.4]

/** A colour mixer band's own colour. */
export function mixBandColour(band: number): RGB {
  const hue = (BAND_HUES[band] ?? BAND_HUES[0]) / 57.29578
  return colourOfLab(0.13 * Math.cos(hue), 0.13 * Math.sin(hue))
}
