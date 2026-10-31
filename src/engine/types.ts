// The contract between the web app's parts. The raw decoder (src/raw), the look engine
// (src/look) and the app (src/app, src/core) are built separately and meet here only.

/** A developed picture: sRGB-encoded floats 0..1, RGB interleaved, rows top to bottom.
 *  Same meaning as DevelopedImage in the Mac app, which is what look.c expects. */
export interface DevelopedImage {
  width: number
  height: number
  rgb: Float32Array
}

/** What the camera wrote about the shot, for the shooting info bar. Missing fields are absent. */
export interface ShootingInfo {
  camera?: string
  lens?: string
  focalLength?: number
  /** what the focal length would be on a 35 mm camera */
  focalLength35mm?: number
  mode?: 'Manual' | 'Program' | 'Aperture priority' | 'Shutter priority'
  aperture?: number
  shutterSeconds?: number
  iso?: number
  exposureCompensation?: number
  taken?: Date
  width?: number
  height?: number
}

/** A raw (.3FR) or ordinary picture file, opened. */
export interface PhotoSource {
  /** The camera's own JPEG preview, for thumbnails and the contact sheet. Null when absent. */
  preview(): Promise<Blob | null>
  info(): ShootingInfo
  /** The picture developed with neutral settings (white balance as shot). `longSide` limits
   *  the size for previews; undefined is full size. `noiseReduction` is the recipe's -1..1. */
  develop(options?: { longSide?: number; noiseReduction?: number }): Promise<DevelopedImage>
}

/** The recipe settings, mirroring look_recipe in look-engine/look.h field for field. */
export interface LookSettings {
  mono: boolean
  film: 'standard' | 'muted' | 'silver'
  monoRed: number
  monoGreen: number
  monoBlue: number
  contrast: number
  shadows: number
  highlights: number
  saturation: number
  shiftRed: number
  shiftBlue: number
  vignette: number
  grain: number
  grainSize: number
  sharpness: number
  clarity: number
  aberration: number
  dynamicRange: number
  colourDepth: number
  blueDepth: number
  toneWarm: number
  toneMagenta: number
  noiseReduction: number
  fade: number
  brightness: number
  vibrance: number
  halation: number
  gradeShadowHue: number
  gradeShadowAmount: number
  gradeHighlightHue: number
  gradeHighlightAmount: number
  gradeBalance: number
  mixHue: number[]
  mixSaturation: number[]
  mixLightness: number[]
  seed: number
}

/** The look engine (look.c compiled to WebAssembly). Text in and out is the camera's own
 *  "key = value" format, so a recipe file never passes through a second parser. */
export interface LookEngine {
  defaults(): LookSettings
  parse(text: string): LookSettings
  format(settings: LookSettings): string
  /** look_apply_image: the whole look, spatial effects included, in place. Runs off the main thread. */
  applyImage(settings: LookSettings, image: DevelopedImage): Promise<DevelopedImage>
  /** look_build_rgb_table: n per axis, red fastest, RGB floats, for the GPU preview. */
  buildTable(settings: LookSettings, n: number): Float32Array
  /** look_is_mono: the mono switch, or a black and white film (Silver). */
  isMono(settings: LookSettings): boolean
  /** Does look_parse take this "key = value" line? False for unknown keys, a mixer or grading
   *  line it can't read, a film it doesn't know: the lines a recipe would silently lose. */
  recognises(line: string): boolean
  /** Different from defaults() in anything but the grain seed, compared as look.c's struct
   *  byte for byte (like the Mac app). */
  changesPicture(settings: LookSettings): boolean
  /** The colour mixer's bands, in look.c's order (mixHue[0] is 'red'); `mix_<name>` in recipe text. */
  readonly mixBandNames: readonly string[]
  /** look_grade_colour: the tint a grading hue (degrees) adds, sRGB 0..1, for drawing the wheel. */
  gradeColour(hue: number): [number, number, number]
  /** look_mix_band_colour: a mixer band's own colour, sRGB 0..1. */
  mixBandColour(band: number): [number, number, number]
  /** applyImage calls run one at a time, in order. This rejects the ones that haven't started
   *  yet with an AbortError DOMException (call it before asking for a newer picture). */
  cancelPending(): void
  /** Stops the worker; pending applyImage calls reject. */
  dispose(): void
}
