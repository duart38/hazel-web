// Everything a recipe can set, as the Studio edits it. Converts to recipe text here and from it
// through the look engine's own reader (LookEngine.parse), so the app and the camera never disagree.

import type { LookSettings } from '../engine/types'
import { MIX_BAND_NAMES, recipeNotes } from './recipe'

/** One setting as the Studio shows it. Values are continuous over the engine's own range; the
 *  display maps that onto a familiar ±4 scale, so "+2.5 shadows" reads like a camera menu. */
export interface SettingInfo {
  key: string
  name: string
  help: string
  min: number
  max: number
  /** live view leaves it out (under a pixel at screen size), so it shows in photos only */
  photosOnly: boolean
}

/** the displayed number: ±4 for two-sided settings, 0…4 for one-sided ones */
export function displayValue(info: SettingInfo, value: number): string {
  const shown = value * 4
  if (Math.abs(shown) < 0.05) return '0'
  const text = shown.toFixed(1)
  return info.min < 0 && shown > 0 ? `+${text}` : text
}

function setting(key: string, name: string, help: string, min: number, max: number, photosOnly = false): SettingInfo {
  return { key, name, help, min, max, photosOnly }
}

export type Film = 'standard' | 'muted' | 'silver'

export const FILMS: { id: Film; name: string; help: string }[] = [
  { id: 'standard', name: 'Standard', help: "The camera's own colour" },
  {
    id: 'muted',
    name: 'Muted',
    help: "Quiet colour, olive greens, cyan-leaning blues, harder shadows. Inspired by Fujifilm's Classic Chrome",
  },
  { id: 'silver', name: 'Silver', help: "Black and white with deep blacks and bright highlights. Inspired by Fujifilm's Acros" },
]

export type Mix = readonly [number, number, number]

export const MONO_FILTERS: { id: string; name: string; mix: Mix }[] = [
  { id: 'neutral', name: 'Neutral', mix: [0.35, 0.55, 0.1] },
  { id: 'yellow', name: 'Yellow', mix: [0.45, 0.5, 0.05] },
  { id: 'orange', name: 'Orange', mix: [0.58, 0.39, 0.03] },
  { id: 'red', name: 'Red', mix: [0.7, 0.28, 0.02] },
  { id: 'green', name: 'Green', mix: [0.2, 0.75, 0.05] },
  { id: 'blue', name: 'Blue', mix: [0.15, 0.35, 0.5] },
]

export const TONE: SettingInfo[] = [
  setting('brightness', 'Brightness', 'Brighter or darker midtones, about a stop either way; black and white stay put', -1, 1),
  setting('contrast', 'Contrast', 'Steeper or flatter tones overall', -1, 1),
  setting('highlights', 'Highlights', 'Brighten or hold back the bright end', -1, 1),
  setting('shadows', 'Shadows', 'Lift or deepen the dark end', -1, 1),
  setting('dynamic_range', 'Dynamic range', 'Hold the brightest tones back, for bright skies and white clothes', 0, 1),
  setting(
    'fade',
    'Fade',
    'A matte print: blacks lifted to a soft grey and the brightest whites softened, like an old photo or a washed-out slide',
    0,
    1,
  ),
]
export const SATURATION = setting('saturation', 'Colour', 'How strong colours are', -1, 1)
export const VIBRANCE = setting(
  'vibrance',
  'Vibrance',
  "Like Colour, but mostly for weak colours, so strong ones don't overdo it and skin stays natural",
  -1,
  1,
)

export interface GradeTint {
  amount: SettingInfo
  /** degrees on the usual colour wheel: 0 red, 60 yellow, 120 green, 240 blue */
  hueKey: string
  recipeKey: string
}
export const GRADE_TINTS: GradeTint[] = [
  {
    amount: setting('grade_shadow_amount', 'Shadows', 'How strongly the shadows take the tint', 0, 1),
    hueKey: 'grade_shadow_hue',
    recipeKey: 'grade_shadows',
  },
  {
    amount: setting('grade_highlight_amount', 'Highlights', 'How strongly the highlights take the tint', 0, 1),
    hueKey: 'grade_highlight_hue',
    recipeKey: 'grade_highlights',
  },
]
export const GRADE_BALANCE = setting(
  'grade_balance',
  'Balance',
  'Give more of the picture to the shadow tint (−) or the highlight tint (+)',
  -1,
  1,
)

export interface MixBand {
  index: number
  /** the recipe's name for it: `mix_<band> = hue, saturation, lightness` */
  band: string
  name: string
  hue: SettingInfo
  saturation: SettingInfo
  lightness: SettingInfo
  settings: SettingInfo[]
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

export const MIX_BANDS: MixBand[] = MIX_BAND_NAMES.map((band, index) => {
  const count = MIX_BAND_NAMES.length
  const next = MIX_BAND_NAMES[(index + 1) % count]
  const before = MIX_BAND_NAMES[(index + count - 1) % count]
  const hue = setting(`mix_${band}_hue`, 'Hue', `Turn ${band} towards ${before} (−) or ${next} (+)`, -1, 1)
  const saturation = setting(`mix_${band}_saturation`, 'Saturation', `Less (−) or more (+) colour in ${band}; −4 makes it grey`, -1, 1)
  const lightness = setting(`mix_${band}_lightness`, 'Lightness', `Darker (−) or lighter (+) ${band}`, -1, 1)
  return { index, band, name: capitalised(band), hue, saturation, lightness, settings: [hue, saturation, lightness] }
})

export const DEPTH: SettingInfo[] = [
  setting('colour_depth', 'Colour depth', 'Deeper, denser strong colours, so they keep their detail', 0, 1),
  setting('blue_depth', 'Blue depth', 'The same for blues only: deeper skies', 0, 1),
]
export const TONING: SettingInfo[] = [
  setting('tone_warm', 'Warm ↔ cool', 'Tint the greys warm (+) or cool (−)', -1, 1),
  setting('tone_magenta', 'Magenta ↔ green', 'Tint the greys magenta (+) or green (−)', -1, 1),
]
export const SHIFT_RED = setting('shift_red', 'Red ↔ cyan', 'White-balance shift towards red or cyan', -1, 1)
export const SHIFT_BLUE = setting('shift_blue', 'Blue ↔ yellow', 'White-balance shift towards blue or yellow', -1, 1)
export const TEXTURE: SettingInfo[] = [
  setting('clarity', 'Clarity', 'Grit: local contrast in the midtones', 0, 1),
  setting('grain', 'Grain', 'How much film grain', 0, 1),
  setting('grain_size', 'Grain size', 'Fine to coarse', 0, 1),
  setting('vignette', 'Vignette', 'Darken (+) or brighten (−) the corners', -1, 1),
  setting('halation', 'Halation', 'A red glow around blown-out lights, like film without its anti-halation layer', 0, 1),
  setting('sharpness', 'Sharpness', 'Crisper or softer edges', -1, 1, true),
  setting('aberration', 'Colour fringing', 'Old-lens colour fringes towards the corners', 0, 1, true),
  setting(
    'noise_reduction',
    'Noise reduction',
    "Less (−) or more (+) smoothing of high-ISO sensor noise, done before any grain; live view keeps the camera's",
    -1,
    1,
    true,
  ),
]

/** the settings written as one `key = value` line each; the grading tints and the mixer bands
 *  have lines of their own */
export const ONE_LINE_SETTINGS: SettingInfo[] = [
  ...TONE,
  SATURATION,
  VIBRANCE,
  SHIFT_RED,
  SHIFT_BLUE,
  ...DEPTH,
  ...TONING,
  GRADE_BALANCE,
  ...TEXTURE,
]

const ALL_INFOS: SettingInfo[] = [
  ...ONE_LINE_SETTINGS,
  ...GRADE_TINTS.map((t) => t.amount),
  ...MIX_BANDS.flatMap((b) => b.settings),
]
const INFO_BY_KEY = new Map(ALL_INFOS.map((info) => [info.key, info]))

export function settingInfo(key: string): SettingInfo | undefined {
  return INFO_BY_KEY.get(key)
}

/** A recipe's settings, in the Studio's terms. Treat as immutable: edits make a new one. */
export interface FilmSettings {
  film: Film
  mono: boolean
  /** black-and-white filter: how much red, green and blue light count */
  monoMix: Mix
  values: Readonly<Record<string, number>>
  seed: number
  /** the recipe's `#` lines after its name: what it's inspired by, how to set the camera */
  notes: readonly string[]
}

/** the engine's defaults (look_defaults): everything neutral, grain size 0.3 */
export function defaultValue(key: string): number {
  return key === 'grain_size' ? 0.3 : 0
}

export function neutralSettings(): FilmSettings {
  return { film: 'standard', mono: false, monoMix: MONO_FILTERS[0].mix, values: {}, seed: 1, notes: [] }
}

export function isBlackAndWhite(settings: FilmSettings): boolean {
  return settings.mono || settings.film === 'silver'
}

export function value(settings: FilmSettings, key: string): number {
  return settings.values[key] ?? defaultValue(key)
}

export function withValue(settings: FilmSettings, key: string, newValue: number): FilmSettings {
  const info = settingInfo(key)
  const clamped = info ? Math.min(Math.max(newValue, info.min), info.max) : newValue
  return { ...settings, values: { ...settings.values, [key]: clamped } }
}

/** a grading tint's hue, in degrees, kept within 0..<360 */
export function withHue(settings: FilmSettings, tint: GradeTint, hue: number): FilmSettings {
  const wrapped = hue % 360
  return { ...settings, values: { ...settings.values, [tint.hueKey]: wrapped < 0 ? wrapped + 360 : wrapped } }
}

export function isBandAdjusted(settings: FilmSettings, band: MixBand): boolean {
  return band.settings.some((info) => Math.abs(value(settings, info.key)) >= 0.0005)
}

/** the named filter this mix is (nearly) equal to, if any */
export function monoFilter(settings: FilmSettings): (typeof MONO_FILTERS)[number] | undefined {
  return MONO_FILTERS.find((f) => Math.hypot(f.mix[0] - settings.monoMix[0], f.mix[1] - settings.monoMix[1], f.mix[2] - settings.monoMix[2]) < 0.02)
}

/** The engine's settings for a recipe, read by the engine, with the recipe's notes. */
export function filmSettingsFrom(look: LookSettings, text: string): FilmSettings {
  const film: Film = look.film
  const values: Record<string, number> = {
    contrast: look.contrast,
    highlights: look.highlights,
    shadows: look.shadows,
    saturation: look.saturation,
    shift_red: look.shiftRed,
    shift_blue: look.shiftBlue,
    clarity: look.clarity,
    grain: look.grain,
    grain_size: look.grainSize,
    vignette: look.vignette,
    sharpness: look.sharpness,
    aberration: look.aberration,
    dynamic_range: look.dynamicRange,
    colour_depth: look.colourDepth,
    blue_depth: look.blueDepth,
    tone_warm: look.toneWarm,
    tone_magenta: look.toneMagenta,
    noise_reduction: look.noiseReduction,
    fade: look.fade,
    brightness: look.brightness,
    vibrance: look.vibrance,
    halation: look.halation,
    grade_shadow_hue: look.gradeShadowHue,
    grade_shadow_amount: look.gradeShadowAmount,
    grade_highlight_hue: look.gradeHighlightHue,
    grade_highlight_amount: look.gradeHighlightAmount,
    grade_balance: look.gradeBalance,
  }
  for (const band of MIX_BANDS) {
    values[band.hue.key] = look.mixHue[band.index] ?? 0
    values[band.saturation.key] = look.mixSaturation[band.index] ?? 0
    values[band.lightness.key] = look.mixLightness[band.index] ?? 0
  }
  return {
    film,
    // Silver is black and white by itself, and its recipes don't say mono, so a read-back matches
    mono: look.mono && film !== 'silver',
    monoMix: [look.monoRed, look.monoGreen, look.monoBlue],
    values,
    seed: look.seed,
    notes: recipeNotes(text),
  }
}

/** C's %.3f and %.1f, without "-0.000" */
function fixed(n: number, digits: number): string {
  const text = n.toFixed(digits)
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text
}

/** The recipe text: a first `#` line with the name, the notes, then only the settings that
 *  differ from neutral, so recipes stay short and readable. */
export function recipeText(name: string, settings: FilmSettings): string {
  const lines = [`# ${name.replace(/\n/g, ' ')}`]
  for (const note of settings.notes) lines.push(`# ${note.replace(/\n/g, ' ')}`)
  if (settings.film !== 'standard') lines.push(`film = ${settings.film}`)
  if (isBlackAndWhite(settings)) {
    if (settings.film !== 'silver') lines.push('mono = 1')
    if (monoFilter(settings)?.id !== 'neutral') {
      lines.push(`mono_mix = ${settings.monoMix.map((m) => fixed(m, 3)).join(', ')}`)
    }
  }
  for (const info of ONE_LINE_SETTINGS) {
    const v = value(settings, info.key)
    if (Math.abs(v - defaultValue(info.key)) >= 0.0005) lines.push(`${info.key} = ${fixed(v, 3)}`)
  }
  // one line per tint and per band, so a recipe with everything set still fits the photo's sidecar
  for (const tint of GRADE_TINTS) {
    const amount = value(settings, tint.amount.key)
    if (amount >= 0.0005) lines.push(`${tint.recipeKey} = ${fixed(value(settings, tint.hueKey), 1)}, ${fixed(amount, 3)}`)
  }
  for (const band of MIX_BANDS) {
    if (!isBandAdjusted(settings, band)) continue
    const parts = band.settings.map((info) => fixed(value(settings, info.key), 3))
    lines.push(`mix_${band.band} = ${parts.join(', ')}`)
  }
  return lines.join('\n') + '\n'
}

/** Same recipe, ignoring how its values were stored (a missing value is its default). */
export function sameSettings(a: FilmSettings, b: FilmSettings): boolean {
  if (a.film !== b.film || a.mono !== b.mono || a.seed !== b.seed) return false
  if (a.monoMix.some((m, i) => Math.abs(m - b.monoMix[i]) > 1e-6)) return false
  if (a.notes.length !== b.notes.length || a.notes.some((n, i) => n !== b.notes[i])) return false
  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)])
  for (const key of keys) if (Math.abs(value(a, key) - value(b, key)) > 1e-6) return false
  return true
}

/** The recipe on another film; Silver brings its own black and white. */
export function withFilm(settings: FilmSettings, film: Film): FilmSettings {
  return { ...settings, film, mono: film === 'silver' ? false : settings.mono }
}

/** Silver is black and white by itself: switching black and white off leaves it for Standard. */
export function withBlackAndWhite(settings: FilmSettings, on: boolean): FilmSettings {
  const film: Film = !on && settings.film === 'silver' ? 'standard' : settings.film
  return { ...settings, film, mono: on && film !== 'silver' }
}

/** LookSettings for the engine, from the Studio's settings (no text round trip while dragging). */
export function lookSettings(settings: FilmSettings, defaults: LookSettings): LookSettings {
  const v = (key: string) => value(settings, key)
  return {
    ...defaults,
    mono: settings.mono,
    film: settings.film,
    monoRed: settings.monoMix[0],
    monoGreen: settings.monoMix[1],
    monoBlue: settings.monoMix[2],
    contrast: v('contrast'),
    shadows: v('shadows'),
    highlights: v('highlights'),
    saturation: v('saturation'),
    shiftRed: v('shift_red'),
    shiftBlue: v('shift_blue'),
    vignette: v('vignette'),
    grain: v('grain'),
    grainSize: v('grain_size'),
    sharpness: v('sharpness'),
    clarity: v('clarity'),
    aberration: v('aberration'),
    dynamicRange: v('dynamic_range'),
    colourDepth: v('colour_depth'),
    blueDepth: v('blue_depth'),
    toneWarm: v('tone_warm'),
    toneMagenta: v('tone_magenta'),
    noiseReduction: v('noise_reduction'),
    fade: v('fade'),
    brightness: v('brightness'),
    vibrance: v('vibrance'),
    halation: v('halation'),
    gradeShadowHue: v('grade_shadow_hue'),
    gradeShadowAmount: v('grade_shadow_amount'),
    gradeHighlightHue: v('grade_highlight_hue'),
    gradeHighlightAmount: v('grade_highlight_amount'),
    gradeBalance: v('grade_balance'),
    mixHue: MIX_BANDS.map((b) => v(b.hue.key)),
    mixSaturation: MIX_BANDS.map((b) => v(b.saturation.key)),
    mixLightness: MIX_BANDS.map((b) => v(b.lightness.key)),
    seed: settings.seed,
  }
}

/** Applied while a raw is decoded, not by the engine. In steps of 1/8, so a slider being dragged
 *  asks for a new decode at most 16 times over its whole range. */
export function noiseReductionStep(settings: FilmSettings): number {
  return Math.round(value(settings, 'noise_reduction') * 8) / 8
}
