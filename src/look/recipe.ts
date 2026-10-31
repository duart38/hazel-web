// LookSettings <-> look_recipe (look-engine/look.h) as bytes in WebAssembly memory. The offsets
// are checked against the C struct at build time: wasm/runtime.c has a _Static_assert for each
// group, so a change to look.h fails `pnpm run build:wasm` until this file follows.

import type { LookSettings } from '../engine/types'

export const RECIPE_SIZE = 228
export const MIX_BANDS = 8

/** The film names in look.c's order (LOOK_FILM_STANDARD, _MUTED, _SILVER). */
export const FILMS: readonly LookSettings['film'][] = ['standard', 'muted', 'silver']

type FloatKey = {
  [K in keyof LookSettings]: LookSettings[K] extends number ? K : never
}[keyof LookSettings]

/** The float fields from mono_red to grade_balance, in struct order, 4 bytes each from offset 8. */
const FLOATS: readonly Exclude<FloatKey, 'seed'>[] = [
  'monoRed', 'monoGreen', 'monoBlue',
  'contrast', 'shadows', 'highlights', 'saturation', 'shiftRed', 'shiftBlue', 'vignette', 'grain',
  'grainSize', 'sharpness', 'clarity', 'aberration', 'dynamicRange', 'colourDepth', 'blueDepth',
  'toneWarm', 'toneMagenta', 'noiseReduction', 'fade', 'brightness', 'vibrance', 'halation',
  'gradeShadowHue', 'gradeShadowAmount', 'gradeHighlightHue', 'gradeHighlightAmount', 'gradeBalance',
]

const OFFSET = {
  mono: 0,
  film: 4,
  floats: 8,
  mixHue: 128,
  mixSaturation: 160,
  mixLightness: 192,
  seed: 224,
} as const

// Little-endian, like WebAssembly memory.
export function writeRecipe(settings: LookSettings, view: DataView, at = 0): void {
  view.setInt32(at + OFFSET.mono, settings.mono ? 1 : 0, true)
  const film = FILMS.indexOf(settings.film)
  view.setInt32(at + OFFSET.film, film < 0 ? 0 : film, true)
  FLOATS.forEach((key, i) => view.setFloat32(at + OFFSET.floats + 4 * i, settings[key], true))
  for (let band = 0; band < MIX_BANDS; band++) {
    view.setFloat32(at + OFFSET.mixHue + 4 * band, settings.mixHue[band] ?? 0, true)
    view.setFloat32(at + OFFSET.mixSaturation + 4 * band, settings.mixSaturation[band] ?? 0, true)
    view.setFloat32(at + OFFSET.mixLightness + 4 * band, settings.mixLightness[band] ?? 0, true)
  }
  view.setUint32(at + OFFSET.seed, settings.seed >>> 0, true)
}

export function readRecipe(view: DataView, at = 0): LookSettings {
  const floats = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => view.getFloat32(at + offset + 4 * i, true))
  const values = floats(OFFSET.floats, FLOATS.length)
  const film = FILMS[view.getInt32(at + OFFSET.film, true)] ?? 'standard'
  const settings: LookSettings = {
    mono: view.getInt32(at + OFFSET.mono, true) !== 0,
    film,
    monoRed: 0, monoGreen: 0, monoBlue: 0, contrast: 0, shadows: 0, highlights: 0, saturation: 0,
    shiftRed: 0, shiftBlue: 0, vignette: 0, grain: 0, grainSize: 0, sharpness: 0, clarity: 0,
    aberration: 0, dynamicRange: 0, colourDepth: 0, blueDepth: 0, toneWarm: 0, toneMagenta: 0,
    noiseReduction: 0, fade: 0, brightness: 0, vibrance: 0, halation: 0, gradeShadowHue: 0,
    gradeShadowAmount: 0, gradeHighlightHue: 0, gradeHighlightAmount: 0, gradeBalance: 0,
    mixHue: floats(OFFSET.mixHue, MIX_BANDS),
    mixSaturation: floats(OFFSET.mixSaturation, MIX_BANDS),
    mixLightness: floats(OFFSET.mixLightness, MIX_BANDS),
    seed: view.getUint32(at + OFFSET.seed, true),
  }
  FLOATS.forEach((key, i) => { settings[key] = values[i] })
  return settings
}

export function recipeBytes(settings: LookSettings): Uint8Array {
  const bytes = new Uint8Array(RECIPE_SIZE)
  writeRecipe(settings, new DataView(bytes.buffer))
  return bytes
}

/** The two recipes are the same struct, byte for byte (what the Mac app compares). */
export function sameRecipe(a: LookSettings, b: LookSettings): boolean {
  const x = recipeBytes(a), y = recipeBytes(b)
  return x.every((byte, i) => byte === y[i])
}
