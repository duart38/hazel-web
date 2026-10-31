// A look as text: the same "key = value" lines the camera reads for recipes and writes in each
// photo's `.look` sidecar. The first `#` line is the recipe's name; later `#` lines are its notes.

/** The text after a `#` line's leading `#`s and spaces, trimmed. */
function commentText(line: string): string {
  return line.replace(/^[# ]+/, '').trim()
}

/** The first `#` line, which every recipe starts with ("Gritty black and white"). */
export function recipeSummary(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.length > 0 && l.startsWith('#'))
  return line === undefined ? undefined : commentText(line)
}

/** The `#` lines after the first, without their `#`. */
export function recipeNotes(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0 && l.startsWith('#'))
    .slice(1)
    .map(commentText)
    .filter((l) => l.length > 0)
}

/** Room for a recipe in the record the camera keeps with every photo (sidecar.sh, in
 *  Hazel-firmware): 1024 bytes, less up to 110 of the camera's own lines. */
export const STORED_ROOM = 1024 - 110

const encoder = new TextEncoder()

/** The bytes the camera keeps of this recipe: the name line and the settings, not the other notes. */
export function storedSize(text: string): number {
  return text
    .split('\n')
    .filter((line, index) => index === 0 || !line.startsWith('#'))
    .reduce((sum, line) => sum + encoder.encode(line).length + 1, 0)
}

export const MIX_BAND_NAMES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const

export const FILM_NAMES = ['standard', 'muted', 'silver'] as const

/** The single-number keys look_parse reads (FLOAT_KEYS in look.c). */
export const FLOAT_KEYS = [
  'contrast', 'shadows', 'highlights', 'saturation', 'shift_red', 'shift_blue', 'vignette', 'grain',
  'grain_size', 'sharpness', 'clarity', 'aberration', 'dynamic_range', 'colour_depth', 'blue_depth',
  'tone_warm', 'tone_magenta', 'noise_reduction', 'fade', 'brightness', 'vibrance', 'halation', 'grade_balance',
] as const

function numbers(value: string, count: number): number[] | null {
  const parts = value.split(',').map((p) => p.trim())
  if (parts.length < count) return null
  const values = parts.slice(0, count).map((p) => Number.parseFloat(p))
  return values.every((v) => Number.isFinite(v)) ? values : null
}

/** Would look_parse take this `key = value` line? Mirrors its rules, so the app can say which
 *  settings a recipe made for a newer Hazel has that this one skips. */
export function isRecognisedLine(line: string): boolean {
  const equals = line.indexOf('=')
  if (equals < 0 || line.startsWith('#')) return false
  const key = line.slice(0, equals).trim()
  const value = line.slice(equals + 1)
  if (key === 'mono' || key === 'seed') return true
  if (key === 'mono_mix') {
    const mix = numbers(value, 3)
    return mix !== null && mix[0] + mix[1] + mix[2] > 0
  }
  if (key === 'film') return (FILM_NAMES as readonly string[]).includes(value.trim().split(/\s+/)[0] ?? '')
  if (key === 'grade_shadows' || key === 'grade_highlights') return numbers(value, 2) !== null
  if (key.startsWith('mix_')) {
    return (MIX_BAND_NAMES as readonly string[]).includes(key.slice(4)) && numbers(value, 3) !== null
  }
  return (FLOAT_KEYS as readonly string[]).includes(key)
}

/** Settings this engine doesn't take: a key from a newer version, or a value it can't read. */
export function unsupportedSettings(text: string, recognises: (line: string) => boolean = isRecognisedLine): string[] {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.includes('=') && !recognises(line))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
}

export type SidecarLook = 'recipe' | 'mono' | 'none'

/** What the camera's sidecar says live view was showing when the photo was taken. */
export interface Sidecar {
  /** the whole sidecar text, which is a recipe with some lines of the camera's own */
  text: string
  look: SidecarLook
}

export function parseSidecar(raw: string): Sidecar {
  // the camera pads the file with blank lines and sometimes NULs
  const text = raw.replace(/\0/g, '').replace(/\n{2,}$/, '\n')
  const line = text.split('\n').find((l) => l.startsWith('look'))
  const value = line?.split('=').slice(1).join('=').trim()
  const look: SidecarLook = value === 'mono' || value === 'none' || value === 'recipe' ? value : 'recipe'
  return { text, look }
}

export const PLAIN_BLACK_AND_WHITE = '# Black and white\nmono = 1\n'

/** The recipe that reproduces what the camera showed, or null when the look was off. The
 *  camera's plain black and white only drops colour, which the engine's black and white with its
 *  default filter comes closest to. */
export function sidecarRecipe(sidecar: Sidecar): string | null {
  switch (sidecar.look) {
    case 'recipe':
      return sidecar.text
    case 'mono':
      return PLAIN_BLACK_AND_WHITE
    case 'none':
      return null
  }
}

/** For the photo list: what the camera showed. */
export function sidecarLabel(sidecar: Sidecar): string {
  switch (sidecar.look) {
    case 'recipe': {
      const summary = recipeSummary(sidecar.text)
      return summary === undefined ? 'Film look' : `Film look: ${summary}`
    }
    case 'mono':
      return 'Black and white'
    case 'none':
      return 'No look'
  }
}
