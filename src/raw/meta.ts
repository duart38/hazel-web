import type { ShootingInfo } from '../engine/types'
import { allIfds, num, nums, str, Tag, type Ifd, type Tiff } from './tiff'

export interface Rect { x: number; y: number; width: number; height: number }

export type PreviewLocation =
  | { kind: 'jpeg'; offset: number; length: number }
  | { kind: 'rgb'; offset: number; length: number; width: number; height: number; littleEndian: boolean }

/** Everything needed to decode and develop the raw strip, plus what the camera wrote about the shot. */
export interface RawMeta {
  rawWidth: number
  rawHeight: number
  bitsPerSample: number
  compression: number
  stripOffset: number
  stripLength: number
  littleEndian: boolean
  /** The picture area inside the strip (DefaultCrop); the rest is the sensor's border. */
  crop: Rect
  /** Colour (0 red, 1 green, 2 blue) of the 2x2 CFA cell at strip (0,0), (1,0), (0,1), (1,1). */
  cfa: [number, number, number, number]
  /** Per CFA cell, same order as `cfa`. */
  black: [number, number, number, number]
  white: number
  /** DNG ColorMatrix1: XYZ to camera, row major. */
  colorMatrix: number[]
  /** Camera RGB of a neutral grey under the shot's light (DNG AsShotNeutral). */
  asShotNeutral: [number, number, number]
  /** EXIF orientation 1..8. */
  orientation: number
  preview: PreviewLocation | null
  info: ShootingInfo
}

/** XYZ→camera for the X1D-50c, from LibRaw's adobe_coeff table ("Hasselblad X1D",
 *  { 4932,-835,141,-4878,11868,3437,-1138,1961,7067 }), the same numbers Adobe's DNG converter
 *  uses. X1D firmware 1.25 also writes them into the file as ColorMatrix1. */
export const X1D_COLOR_MATRIX = [0.4932, -0.0835, 0.0141, -0.4878, 1.1868, 0.3437, -0.1138, 0.1961, 0.7067]

const CFA_COLOURS: Record<string, [number, number, number, number]> = {
  RGGB: [0, 1, 1, 2],
  BGGR: [2, 1, 1, 0],
  GRBG: [1, 0, 2, 1],
  GBRG: [1, 2, 0, 1],
}

function pickRawIfd(ifds: Ifd[], hasselblad: boolean): Ifd | undefined {
  let best: Ifd | undefined
  let bestScore = 0
  for (const ifd of ifds) {
    const w = num(ifd, Tag.ImageWidth) ?? 0
    const h = num(ifd, Tag.ImageLength) ?? 0
    const spp = num(ifd, Tag.SamplesPerPixel) ?? 1
    const bps = num(ifd, Tag.BitsPerSample) ?? 0
    const cfa = num(ifd, Tag.Photometric) === 32803
    if (spp !== 1 || bps < 10 || !ifd.entries.has(Tag.StripOffsets) || !(cfa || hasselblad)) continue
    const score = w * h * (cfa ? 2 : 1)
    if (score > bestScore) { best = ifd; bestScore = score }
  }
  return best
}

function jpegSize(bytes: Uint8Array, offset: number): number {
  // looks for an SOF marker to learn the JPEG's pixel count; 0 when it's out of reach
  let p = offset + 2
  while (p + 9 < bytes.length) {
    if (bytes[p] !== 0xff) return 0
    const marker = bytes[p + 1]
    const len = (bytes[p + 2] << 8) | bytes[p + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return ((bytes[p + 5] << 8) | bytes[p + 6]) * ((bytes[p + 7] << 8) | bytes[p + 8])
    }
    p += 2 + len
  }
  return 0
}

function pickPreview(ifds: Ifd[], raw: Ifd | undefined, head: Uint8Array, littleEndian: boolean): PreviewLocation | null {
  let best: PreviewLocation | null = null
  let bestPixels = 0
  const consider = (location: PreviewLocation, pixels: number) => {
    if (pixels > bestPixels) { best = location; bestPixels = pixels }
  }
  for (const ifd of ifds) {
    if (ifd === raw) continue
    const jpegOffset = num(ifd, Tag.JpegOffset)
    const jpegLength = num(ifd, Tag.JpegLength)
    if (jpegOffset && jpegLength) {
      consider({ kind: 'jpeg', offset: jpegOffset, length: jpegLength }, jpegSize(head, jpegOffset) || jpegLength * 8)
    }
    const w = num(ifd, Tag.ImageWidth) ?? 0
    const h = num(ifd, Tag.ImageLength) ?? 0
    const compression = num(ifd, Tag.Compression) ?? 1
    const offsets = nums(ifd, Tag.StripOffsets)
    const counts = nums(ifd, Tag.StripByteCounts)
    if (!offsets || !counts || offsets.length !== 1 || !w || !h) continue
    if ((compression === 6 || compression === 7) && (num(ifd, Tag.BitsPerSample) ?? 8) === 8) {
      consider({ kind: 'jpeg', offset: offsets[0], length: counts[0] }, w * h)
    } else if (compression === 1 && num(ifd, Tag.SamplesPerPixel) === 3 && num(ifd, Tag.BitsPerSample) === 8
      && num(ifd, Tag.Photometric) === 2 && counts[0] >= w * h * 3) {
      consider({ kind: 'rgb', offset: offsets[0], length: counts[0], width: w, height: h, littleEndian }, w * h)
    }
  }
  return best
}

function exifDate(text: string | undefined): Date | undefined {
  const m = text?.match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  if (!y || !mo || !d) return undefined
  return new Date(y, mo - 1, d, h, mi, s)
}

function cameraName(make: string | undefined, model: string | undefined): string | undefined {
  if (!model) return make
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model
  return `${make} ${model}`
}

function exposureMode(program: number | undefined): ShootingInfo['mode'] {
  switch (program) {
    case 1: return 'Manual'
    case 2: return 'Program'
    case 3: return 'Aperture priority'
    case 4: return 'Shutter priority'
    default: return undefined
  }
}

export function shootingInfo(ifd0: Ifd | undefined, exif: Ifd | undefined): ShootingInfo {
  const info: ShootingInfo = {}
  const camera = cameraName(str(ifd0, Tag.Make), str(ifd0, Tag.Model))
  if (camera) info.camera = camera
  const lens = str(exif, Tag.LensModel)
  if (lens) info.lens = lens
  const focal = num(exif, Tag.FocalLength)
  if (focal) info.focalLength = focal
  const equivalent = num(exif, Tag.FocalLengthIn35mmFilm)
  if (equivalent) info.focalLength35mm = equivalent
  const mode = exposureMode(num(exif, Tag.ExposureProgram))
  if (mode) info.mode = mode
  const aperture = num(exif, Tag.FNumber)
  if (aperture) info.aperture = aperture
  const shutter = num(exif, Tag.ExposureTime)
  if (shutter) info.shutterSeconds = shutter
  const iso = num(exif, Tag.Iso)
  if (iso) info.iso = iso
  const bias = num(exif, Tag.ExposureBias)
  if (bias !== undefined) info.exposureCompensation = bias
  const taken = exifDate(str(exif, Tag.DateTimeOriginal) ?? str(ifd0, Tag.DateTime))
  if (taken) info.taken = taken
  return info
}

export function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8
}

/** Reads the raw's layout and the shooting info. `head` is the start of the file the TIFF
 *  structure was parsed from (used only to size an embedded JPEG). */
export function rawMeta(tiff: Tiff, head: Uint8Array): RawMeta {
  const ifds = allIfds(tiff)
  const ifd0 = tiff.ifds[0]
  const raw = pickRawIfd(ifds, /hasselblad/i.test(str(ifd0, Tag.Make) ?? ''))
  if (!raw) throw new Error('no raw image in this file')
  const rawWidth = num(raw, Tag.ImageWidth) ?? 0
  const rawHeight = num(raw, Tag.ImageLength) ?? 0
  const offsets = nums(raw, Tag.StripOffsets) ?? []
  const counts = nums(raw, Tag.StripByteCounts) ?? []
  if (offsets.length !== 1) throw new Error('raws split into several strips are not supported')
  const exif = ifds.map((i) => i.exif).find((e) => e !== undefined)
  const find = (tag: number) => [raw, ...ifds].find((i) => i.entries.has(tag))

  const cropOrigin = nums(find(Tag.DefaultCropOrigin), Tag.DefaultCropOrigin) ?? [0, 0]
  const cropSize = nums(find(Tag.DefaultCropSize), Tag.DefaultCropSize) ?? [rawWidth, rawHeight]
  const crop = { x: Math.round(cropOrigin[0]), y: Math.round(cropOrigin[1]), width: Math.round(cropSize[0]), height: Math.round(cropSize[1]) }
  if (crop.x + crop.width > rawWidth || crop.y + crop.height > rawHeight) {
    Object.assign(crop, { x: 0, y: 0, width: rawWidth, height: rawHeight })
  }

  let cfa: [number, number, number, number] = CFA_COLOURS.RGGB
  const pattern = raw.entries.get(Tag.CfaPattern)?.value
  const dims = nums(raw, Tag.CfaRepeatPatternDim)
  if (pattern instanceof Uint8Array && pattern.length === 4 && (!dims || (dims[0] === 2 && dims[1] === 2))) {
    cfa = [pattern[0], pattern[1], pattern[2], pattern[3]].map((c) => Math.min(c, 2)) as [number, number, number, number]
  }

  const bitsPerSample = num(raw, Tag.BitsPerSample) ?? 16
  const blackValues = nums(raw, Tag.BlackLevel) ?? [0]
  const blackDims = nums(raw, Tag.BlackLevelRepeatDim) ?? [1, 1]
  const black: [number, number, number, number] = [0, 1, 2, 3].map((i) => {
    if (blackValues.length >= 4 && blackDims[0] === 2 && blackDims[1] === 2) return blackValues[i]
    return blackValues[0]
  }) as [number, number, number, number]
  const white = num(raw, Tag.WhiteLevel) ?? (1 << bitsPerSample) - 1

  const matrix = nums(find(Tag.ColorMatrix1), Tag.ColorMatrix1)
  const colorMatrix = matrix && matrix.length === 9 ? matrix : X1D_COLOR_MATRIX
  const neutral = nums(find(Tag.AsShotNeutral), Tag.AsShotNeutral)
  const asShotNeutral: [number, number, number] = neutral && neutral.length === 3 && neutral.every((v) => v > 0)
    ? [neutral[0], neutral[1], neutral[2]]
    : [0.387, 1, 0.712]

  const orientation = num(ifd0, Tag.Orientation) ?? 1
  const info = shootingInfo(ifd0, exif)
  const swap = swapsAxes(orientation)
  info.width = swap ? crop.height : crop.width
  info.height = swap ? crop.width : crop.height

  return {
    rawWidth,
    rawHeight,
    bitsPerSample,
    compression: num(raw, Tag.Compression) ?? 1,
    stripOffset: offsets[0],
    stripLength: counts[0] ?? 0,
    littleEndian: tiff.littleEndian,
    crop,
    cfa,
    black,
    white,
    colorMatrix,
    asShotNeutral,
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
    preview: pickPreview(ifds, raw, head, tiff.littleEndian),
    info,
  }
}
