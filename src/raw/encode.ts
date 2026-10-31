import type { DevelopedImage, ShootingInfo } from '../engine/types'
import { canvasBlob, context2d, makeCanvas } from './canvas'

// Writers for developed pictures: JPEG through the browser's canvas encoder (with the shooting
// info copied into an EXIF block), and 16-bit PNG and TIFF written here, a band of rows at a
// time so a 50-megapixel picture never needs a second full-size buffer.

const BAND_ROWS = 64

function clamp16(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535)
}

// ---- EXIF ---------------------------------------------------------------------------------

interface ExifField { tag: number; type: 2 | 3 | 4 | 5 | 10; values: number[] | string }

function ratio(value: number, signed: boolean): [number, number] {
  if (value === 0) return [0, 1]
  if (!signed && value > 0 && value < 1 && Math.abs(1 / value - Math.round(1 / value)) < 1e-6) return [1, Math.round(1 / value)]
  const den = 1000
  return [Math.round(value * den), den]
}

function exifDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}:${p(date.getMonth() + 1)}:${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function writeIfd(fields: ExifField[], start: number, view: DataView, next = 0): number {
  // fields sorted; values that don't fit in 4 bytes go right after the IFD
  fields.sort((a, b) => a.tag - b.tag)
  let extra = start + 2 + fields.length * 12 + 4
  view.setUint16(start, fields.length, true)
  fields.forEach((f, i) => {
    const e = start + 2 + i * 12
    const bytes: number[] = []
    let count: number
    if (typeof f.values === 'string') {
      for (const ch of f.values) bytes.push(ch.charCodeAt(0) & 0x7f)
      bytes.push(0)
      count = bytes.length
    } else {
      count = f.type === 5 || f.type === 10 ? f.values.length / 2 : f.values.length
      const local = new DataView(new ArrayBuffer(f.values.length * 4))
      f.values.forEach((v, k) => {
        if (f.type === 3) local.setUint16(k * 2, v, true)
        else if (f.type === 10) local.setInt32(k * 4, v, true)
        else local.setUint32(k * 4, v, true)
      })
      const size = f.type === 3 ? f.values.length * 2 : f.values.length * 4
      for (let k = 0; k < size; k++) bytes.push(local.getUint8(k))
    }
    view.setUint16(e, f.tag, true)
    view.setUint16(e + 2, f.type, true)
    view.setUint32(e + 4, count, true)
    if (bytes.length <= 4) {
      bytes.forEach((b, k) => view.setUint8(e + 8 + k, b))
    } else {
      view.setUint32(e + 8, extra, true)
      bytes.forEach((b, k) => view.setUint8(extra + k, b))
      extra += bytes.length + (bytes.length & 1)
    }
  })
  view.setUint32(start + 2 + fields.length * 12, next, true)
  return extra
}

/** An EXIF APP1 segment (marker included) carrying the shooting info, or null when there's none. */
export function exifSegment(info: ShootingInfo): Uint8Array | null {
  const ifd0: ExifField[] = [{ tag: 0x112, type: 3, values: [1] }]
  const exif: ExifField[] = []
  if (info.camera) {
    const make = info.camera.split(' ')[0]
    ifd0.push({ tag: 0x10f, type: 2, values: make }, { tag: 0x110, type: 2, values: info.camera })
  }
  if (info.taken) {
    ifd0.push({ tag: 0x132, type: 2, values: exifDate(info.taken) })
    exif.push({ tag: 0x9003, type: 2, values: exifDate(info.taken) })
  }
  if (info.shutterSeconds) exif.push({ tag: 0x829a, type: 5, values: ratio(info.shutterSeconds, false) })
  if (info.aperture) exif.push({ tag: 0x829d, type: 5, values: ratio(info.aperture, false) })
  if (info.iso) exif.push({ tag: 0x8827, type: 3, values: [Math.min(65535, Math.round(info.iso))] })
  if (info.exposureCompensation !== undefined) exif.push({ tag: 0x9204, type: 10, values: ratio(info.exposureCompensation, true) })
  if (info.focalLength) exif.push({ tag: 0x920a, type: 5, values: ratio(info.focalLength, false) })
  if (info.lens) exif.push({ tag: 0xa434, type: 2, values: info.lens })
  if (exif.length === 0 && !info.camera) return null
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, values: [0] })

  const buffer = new ArrayBuffer(4096)
  const view = new DataView(buffer)
  const tiff = 10 // TIFF header starts after FF E1, length, "Exif\0\0"
  const t = new DataView(buffer, tiff)
  t.setUint16(0, 0x4949, true)
  t.setUint16(2, 42, true)
  t.setUint32(4, 8, true)
  let end = writeIfd(ifd0, 8, t)
  if (exif.length) {
    const pointer = ifd0.findIndex((f) => f.tag === 0x8769)
    t.setUint32(8 + 2 + pointer * 12 + 8, end, true)
    end = writeIfd(exif, end, t)
  }
  const length = tiff + end
  view.setUint16(0, 0xffe1)
  view.setUint16(2, length - 2)
  new Uint8Array(buffer, 4, 6).set([0x45, 0x78, 0x69, 0x66, 0, 0])
  return new Uint8Array(buffer, 0, length)
}

// ---- JPEG ---------------------------------------------------------------------------------

/** 8-bit sRGB JPEG. With `info`, its shooting info goes into an EXIF block. */
export async function encodeJpeg(image: DevelopedImage, options: { quality?: number; info?: ShootingInfo } = {}): Promise<Blob> {
  const { width, height, rgb } = image
  const canvas = makeCanvas(width, height)
  const ctx = context2d(canvas)
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - top)
    const band = ctx.createImageData(width, rows)
    const out = band.data
    for (let i = top * width * 3, j = 0; j < out.length; i += 3, j += 4) {
      out[j] = rgb[i] * 255 + 0.5
      out[j + 1] = rgb[i + 1] * 255 + 0.5
      out[j + 2] = rgb[i + 2] * 255 + 0.5
      out[j + 3] = 255
    }
    ctx.putImageData(band, 0, top)
  }
  const jpeg = await canvasBlob(canvas, 'image/jpeg', options.quality ?? 0.92)
  const exif = options.info ? exifSegment(options.info) : null
  if (!exif) return jpeg
  return new Blob([jpeg.slice(0, 2), exif as Uint8Array<ArrayBuffer>, jpeg.slice(2)], { type: 'image/jpeg' })
}

// ---- PNG ----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0)
  return out
}

/** 16-bit RGB PNG, sRGB. */
export async function encodePng16(image: DevelopedImage): Promise<Blob> {
  const { width, height, rgb } = image
  const stride = width * 6
  const compressor = new CompressionStream('deflate')
  const compressed = new Response(compressor.readable).arrayBuffer()
  const writer = compressor.writable.getWriter()
  const prev = new Uint8Array(stride)
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - top)
    const band = new Uint8Array(rows * (stride + 1))
    for (let r = 0; r < rows; r++) {
      const row = band.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1))
      band[r * (stride + 1)] = 2 // filter: Up
      let i = (top + r) * width * 3
      for (let x = 0; x < stride; x += 2, i++) {
        const v = clamp16(rgb[i])
        const hi = v >> 8, lo = v & 0xff
        row[x] = (hi - prev[x]) & 0xff
        row[x + 1] = (lo - prev[x + 1]) & 0xff
        prev[x] = hi
        prev[x + 1] = lo
      }
    }
    await writer.write(band)
  }
  await writer.close()
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([16, 2, 0, 0, 0], 8)
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new Blob([
    signature,
    chunk('IHDR', header),
    chunk('sRGB', new Uint8Array([0])),
    chunk('IDAT', new Uint8Array(await compressed)),
    chunk('IEND', new Uint8Array(0)),
  ], { type: 'image/png' })
}

// ---- TIFF ---------------------------------------------------------------------------------

/** Uncompressed 16-bit RGB TIFF, little-endian, in strips of 64 rows. */
export function encodeTiff16(image: DevelopedImage): Blob {
  const { width, height, rgb } = image
  const strips = Math.ceil(height / BAND_ROWS)
  const entries = 13
  const ifdSize = 2 + entries * 12 + 4
  const bitsAt = 8 + ifdSize
  const resolutionAt = bitsAt + 6
  const offsetsAt = resolutionAt + 16
  const countsAt = offsetsAt + strips * 4
  const dataAt = countsAt + strips * 4
  const header = new ArrayBuffer(dataAt)
  const v = new DataView(header)
  v.setUint16(0, 0x4949, true)
  v.setUint16(2, 42, true)
  v.setUint32(4, 8, true)
  v.setUint16(8, entries, true)
  const entry = (i: number, tag: number, type: number, count: number, value: number) => {
    const e = 10 + i * 12
    v.setUint16(e, tag, true)
    v.setUint16(e + 2, type, true)
    v.setUint32(e + 4, count, true)
    if (type === 3 && count === 1) v.setUint16(e + 8, value, true)
    else v.setUint32(e + 8, value, true)
  }
  const single = strips === 1
  entry(0, 0x100, 4, 1, width)
  entry(1, 0x101, 4, 1, height)
  entry(2, 0x102, 3, 3, bitsAt)
  entry(3, 0x103, 3, 1, 1)
  entry(4, 0x106, 3, 1, 2)
  entry(5, 0x111, 4, strips, single ? dataAt : offsetsAt)
  entry(6, 0x112, 3, 1, 1)
  entry(7, 0x115, 3, 1, 3)
  entry(8, 0x116, 4, 1, BAND_ROWS)
  entry(9, 0x117, 4, strips, single ? width * height * 6 : countsAt)
  entry(10, 0x11a, 5, 1, resolutionAt)
  entry(11, 0x11b, 5, 1, resolutionAt + 8)
  entry(12, 0x11c, 3, 1, 1)
  v.setUint32(10 + entries * 12, 0, true)
  for (let k = 0; k < 3; k++) v.setUint16(bitsAt + 2 * k, 16, true)
  v.setUint32(resolutionAt, 72, true)
  v.setUint32(resolutionAt + 4, 1, true)
  v.setUint32(resolutionAt + 8, 72, true)
  v.setUint32(resolutionAt + 12, 1, true)
  const parts: BlobPart[] = [header]
  let offset = dataAt
  for (let s = 0; s < strips; s++) {
    const rows = Math.min(BAND_ROWS, height - s * BAND_ROWS)
    const samples = rows * width * 3
    v.setUint32(offsetsAt + s * 4, offset, true)
    v.setUint32(countsAt + s * 4, samples * 2, true)
    const strip = new Uint16Array(samples)
    const base = s * BAND_ROWS * width * 3
    for (let i = 0; i < samples; i++) strip[i] = clamp16(rgb[base + i])
    parts.push(strip)
    offset += samples * 2
  }
  return new Blob(parts, { type: 'image/tiff' })
}
