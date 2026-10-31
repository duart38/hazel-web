import { describe, expect, it } from 'vitest'
import { developParams } from './colour'
import { developCpu } from './develop-cpu'
import { rawMeta } from './meta'
import { unpackRaw } from './rawdata'
import { allIfds, num, parseTiff, str, Tag } from './tiff'
import { cardFile } from './card.test-helper'

function tinyTiff(): Uint8Array {
  // II, one IFD: width 3, height 2, Make "Test", Orientation 6, a rational and an EXIF pointer
  const b = new Uint8Array(256)
  const v = new DataView(b.buffer)
  v.setUint16(0, 0x4949, true); v.setUint16(2, 42, true); v.setUint32(4, 8, true)
  const entries: [number, number, number, number][] = [
    [0x100, 3, 1, 3], [0x101, 3, 1, 2], [0x10f, 2, 5, 100], [0x112, 3, 1, 6], [0x8769, 4, 1, 120],
  ]
  v.setUint16(8, entries.length, true)
  entries.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12
    v.setUint16(e, tag, true); v.setUint16(e + 2, type, true); v.setUint32(e + 4, count, true)
    if (type === 3) v.setUint16(e + 8, value, true)
    else v.setUint32(e + 8, value, true)
  })
  b.set([0x54, 0x65, 0x73, 0x74, 0], 100)
  v.setUint16(120, 1, true)
  v.setUint16(122, 0x829d, true); v.setUint16(124, 5, true); v.setUint32(126, 1, true); v.setUint32(130, 200, true)
  v.setUint32(200, 28, true); v.setUint32(204, 10, true)
  return b
}

describe('TIFF', () => {
  it('reads tags, strings, rationals and the EXIF block', () => {
    const tiff = parseTiff(tinyTiff())
    const ifd = tiff.ifds[0]
    expect(num(ifd, Tag.ImageWidth)).toBe(3)
    expect(num(ifd, Tag.Orientation)).toBe(6)
    expect(str(ifd, Tag.Make)).toBe('Test')
    expect(num(ifd.exif, Tag.FNumber)).toBeCloseTo(2.8)
  })

  it('rejects other files', () => {
    expect(() => parseTiff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toThrow()
  })
})

describe('X1D raw on the card', async () => {
  const file = await cardFile('B0000001.3FR')
  it.skipIf(!file)('finds the raw strip, the crop, levels and the shooting info', () => {
    const bytes = file as Uint8Array<ArrayBuffer>
    const head = bytes.subarray(0, 1 << 20)
    const tiff = parseTiff(head)
    expect(allIfds(tiff).length).toBeGreaterThan(1)
    const meta = rawMeta(tiff, head)
    expect(meta).toMatchObject({
      rawWidth: 8384, rawHeight: 6304, bitsPerSample: 16, compression: 1, stripOffset: 4673536,
      crop: { x: 50, y: 100, width: 8272, height: 6200 }, cfa: [0, 1, 1, 2], black: [256, 256, 256, 256], white: 65535,
      orientation: 1,
    })
    expect(meta.colorMatrix[0]).toBeCloseTo(0.493206)
    expect(meta.asShotNeutral[0]).toBeCloseTo(65536 / 169278)
    expect(meta.preview).toMatchObject({ kind: 'rgb', width: 1440, height: 1080 })
    expect(meta.info).toMatchObject({ camera: 'Hasselblad X1D', lens: 'XCD 45P', focalLength: 45, focalLength35mm: 35, mode: 'Manual', iso: 400, width: 8272, height: 6200 })
    expect(meta.info.aperture).toBeCloseTo(6.3)
    expect(meta.info.shutterSeconds).toBeCloseTo(1 / 50)
    expect(meta.info.exposureCompensation).toBeCloseTo(2 / 3)
    expect(meta.info.taken?.getFullYear()).toBe(2026)
  })

  it.skipIf(!file)('develops on the CPU at preview size', () => {
    const bytes = file as Uint8Array<ArrayBuffer>
    const meta = rawMeta(parseTiff(bytes.subarray(0, 1 << 20)), bytes)
    const raw = unpackRaw(meta, bytes.subarray(meta.stripOffset, meta.stripOffset + meta.stripLength))
    const image = developCpu(raw, meta.rawWidth, developParams(meta), 1034)
    expect(image.width).toBe(1034)
    expect(image.height).toBe(775)
    let sum = 0
    for (const v of image.rgb) sum += v
    const mean = sum / image.rgb.length
    expect(mean).toBeGreaterThan(0.15)
    expect(mean).toBeLessThan(0.85)
  })
})

describe('X1D portrait raw on the card', async () => {
  const file = await cardFile('B0000013.3FR')
  it.skipIf(!file)('is turned upright', () => {
    const head = (file as Uint8Array<ArrayBuffer>).subarray(0, 1 << 20)
    const meta = rawMeta(parseTiff(head), head)
    expect(meta.orientation).toBe(8)
    expect(meta.info.width).toBe(6200)
    expect(meta.info.height).toBe(8272)
  })
})
