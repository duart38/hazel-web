// A small TIFF reader: enough of the structure to find a raw strip, its tags, the EXIF block and
// the maker note. Values are decoded eagerly but arrays are capped, so a huge tag costs nothing.

export class OutOfRange extends Error {
  readonly needed: number
  constructor(needed: number) {
    super(`TIFF data at byte ${needed} is past what was read`)
    this.needed = needed
  }
}

export type TagValue = number[] | string | Uint8Array

export interface TiffEntry {
  tag: number
  type: number
  count: number
  /** Where the value lives in the file (inline values point into the entry itself). */
  offset: number
  value: TagValue
}

export interface Ifd {
  offset: number
  entries: Map<number, TiffEntry>
  subIfds: Ifd[]
  exif?: Ifd
}

export interface Tiff {
  littleEndian: boolean
  ifds: Ifd[]
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }
const MAX_ARRAY = 4096

export const Tag = {
  NewSubfileType: 0xfe,
  ImageWidth: 0x100,
  ImageLength: 0x101,
  BitsPerSample: 0x102,
  Compression: 0x103,
  Photometric: 0x106,
  Make: 0x10f,
  Model: 0x110,
  StripOffsets: 0x111,
  Orientation: 0x112,
  SamplesPerPixel: 0x115,
  RowsPerStrip: 0x116,
  StripByteCounts: 0x117,
  PlanarConfiguration: 0x11c,
  DateTime: 0x132,
  SubIfds: 0x14a,
  JpegOffset: 0x201,
  JpegLength: 0x202,
  CfaRepeatPatternDim: 0x828d,
  CfaPattern: 0x828e,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ExifIfd: 0x8769,
  ExposureProgram: 0x8822,
  Iso: 0x8827,
  DateTimeOriginal: 0x9003,
  ExposureBias: 0x9204,
  FocalLength: 0x920a,
  MakerNote: 0x927c,
  FocalLengthIn35mmFilm: 0xa405,
  LensMake: 0xa433,
  LensModel: 0xa434,
  BlackLevelRepeatDim: 0xc619,
  BlackLevel: 0xc61a,
  WhiteLevel: 0xc61d,
  DefaultCropOrigin: 0xc61f,
  DefaultCropSize: 0xc620,
  ColorMatrix1: 0xc621,
  AsShotNeutral: 0xc628,
  BaselineExposure: 0xc62a,
} as const

export class ByteReader {
  readonly view: DataView
  /** File offset of view byte 0. */
  readonly base: number
  readonly littleEndian: boolean

  constructor(bytes: Uint8Array, littleEndian: boolean, base = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.base = base
    this.littleEndian = littleEndian
  }

  private at(offset: number, size: number): number {
    const local = offset - this.base
    if (local < 0 || local + size > this.view.byteLength) throw new OutOfRange(offset + size)
    return local
  }
  u8(o: number): number { return this.view.getUint8(this.at(o, 1)) }
  u16(o: number): number { return this.view.getUint16(this.at(o, 2), this.littleEndian) }
  u32(o: number): number { return this.view.getUint32(this.at(o, 4), this.littleEndian) }
  i32(o: number): number { return this.view.getInt32(this.at(o, 4), this.littleEndian) }
  f32(o: number): number { return this.view.getFloat32(this.at(o, 4), this.littleEndian) }
  f64(o: number): number { return this.view.getFloat64(this.at(o, 8), this.littleEndian) }
  bytes(o: number, n: number): Uint8Array {
    const local = this.at(o, n)
    return new Uint8Array(this.view.buffer, this.view.byteOffset + local, n)
  }
}

function readValue(r: ByteReader, type: number, count: number, offset: number): TagValue {
  if (type === 2) {
    const raw = r.bytes(offset, Math.min(count, MAX_ARRAY))
    let end = raw.indexOf(0)
    if (end < 0) end = raw.length
    return new TextDecoder('latin1').decode(raw.subarray(0, end)).trim()
  }
  if (type === 7 || type === 1 || type === 6) return r.bytes(offset, Math.min(count, 1 << 20))
  const n = Math.min(count, MAX_ARRAY)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 3: out.push(r.u16(offset + 2 * i)); break
      case 8: out.push((r.u16(offset + 2 * i) << 16) >> 16); break
      case 4: case 13: out.push(r.u32(offset + 4 * i)); break
      case 9: out.push(r.i32(offset + 4 * i)); break
      case 5: { const d = r.u32(offset + 8 * i + 4); out.push(d ? r.u32(offset + 8 * i) / d : 0); break }
      case 10: { const d = r.i32(offset + 8 * i + 4); out.push(d ? r.i32(offset + 8 * i) / d : 0); break }
      case 11: out.push(r.f32(offset + 4 * i)); break
      case 12: out.push(r.f64(offset + 8 * i)); break
      default: return r.bytes(offset, Math.min(count, MAX_ARRAY))
    }
  }
  return out
}

export function readIfd(r: ByteReader, offset: number, depth = 0, seen = new Set<number>()): Ifd {
  seen.add(offset)
  const n = r.u16(offset)
  const entries = new Map<number, TiffEntry>()
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + 12 * i
    const tag = r.u16(e)
    const type = r.u16(e + 2)
    const count = r.u32(e + 4)
    const size = (TYPE_SIZE[type] ?? 1) * count
    const valueOffset = size <= 4 ? e + 8 : r.u32(e + 8)
    let value: TagValue
    try {
      value = readValue(r, type, count, valueOffset)
    } catch (error) {
      // a large value outside what was read (a maker note blob, say) is skipped, not fatal
      if (error instanceof OutOfRange && size > 4096) value = new Uint8Array(0)
      else throw error
    }
    entries.set(tag, { tag, type, count, offset: valueOffset, value })
  }
  const ifd: Ifd = { offset, entries, subIfds: [] }
  if (depth < 4) {
    const subs = entries.get(Tag.SubIfds)?.value
    if (Array.isArray(subs)) {
      for (const o of subs) if (o && !seen.has(o)) ifd.subIfds.push(readIfd(r, o, depth + 1, seen))
    }
    const exif = entries.get(Tag.ExifIfd)?.value
    if (Array.isArray(exif) && exif[0] && !seen.has(exif[0])) ifd.exif = readIfd(r, exif[0], depth + 1, seen)
  }
  return ifd
}

export function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  const ii = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0
  const mm = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42
  return ii || mm
}

/** Parses the IFD chain. `bytes` is the start of the file; throws OutOfRange when the structure
 *  reaches past it, so the caller can read more and try again. */
export function parseTiff(bytes: Uint8Array): Tiff {
  if (!isTiff(bytes)) throw new Error('not a TIFF file')
  const littleEndian = bytes[0] === 0x49
  const r = new ByteReader(bytes, littleEndian)
  const ifds: Ifd[] = []
  const seen = new Set<number>()
  let next = r.u32(4)
  while (next && !seen.has(next) && ifds.length < 16) {
    const ifd = readIfd(r, next, 0, seen)
    ifds.push(ifd)
    const n = r.u16(next)
    next = r.u32(next + 2 + 12 * n)
  }
  return { littleEndian, ifds }
}

export function allIfds(tiff: Tiff): Ifd[] {
  const out: Ifd[] = []
  const walk = (ifd: Ifd) => {
    out.push(ifd)
    ifd.subIfds.forEach(walk)
  }
  tiff.ifds.forEach(walk)
  return out
}

export function num(ifd: Ifd | undefined, tag: number, index = 0): number | undefined {
  const v = ifd?.entries.get(tag)?.value
  return Array.isArray(v) && v.length > index ? v[index] : undefined
}

export function nums(ifd: Ifd | undefined, tag: number): number[] | undefined {
  const v = ifd?.entries.get(tag)?.value
  return Array.isArray(v) ? v : undefined
}

export function str(ifd: Ifd | undefined, tag: number): string | undefined {
  const v = ifd?.entries.get(tag)?.value
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
