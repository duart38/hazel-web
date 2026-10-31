import { describe, expect, it } from 'vitest'
import { crc32, encodePng16, encodeTiff16, exifSegment } from './encode'
import { shootingInfo } from './meta'
import { ByteReader, num, nums, parseTiff, Tag } from './tiff'

function gradient(width: number, height: number) {
  const rgb = new Float32Array(width * height * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 7919) % 1000) / 999
  rgb[0] = -0.2
  rgb[1] = 1.3
  return { width, height, rgb }
}
const expected = (v: number) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535))

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('encoders', () => {
  it('computes the PNG CRC', () => {
    expect((crc32(new TextEncoder().encode('IEND')) ^ 0xffffffff) >>> 0).toBe(0xae426082)
  })

  it('writes a 16-bit PNG that inflates back to the picture', async () => {
    const image = gradient(37, 70)
    const png = new Uint8Array(await (await encodePng16(image)).arrayBuffer())
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47])
    const view = new DataView(png.buffer)
    let p = 8
    const idat: number[] = []
    let ihdr: Uint8Array | null = null
    while (p < png.length) {
      const len = view.getUint32(p)
      const type = new TextDecoder().decode(png.subarray(p + 4, p + 8))
      const body = png.subarray(p + 8, p + 8 + len)
      expect(view.getUint32(p + 8 + len)).toBe((crc32(png.subarray(p + 4, p + 8 + len)) ^ 0xffffffff) >>> 0)
      if (type === 'IHDR') ihdr = body
      if (type === 'IDAT') idat.push(...body)
      p += 12 + len
    }
    expect(ihdr && Array.from(ihdr.subarray(8))).toEqual([16, 2, 0, 0, 0])
    const raw = await inflate(new Uint8Array(idat))
    const stride = image.width * 6
    const prev = new Uint8Array(stride)
    for (let y = 0; y < image.height; y++) {
      const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1))
      expect(row[0]).toBe(2)
      for (let x = 0; x < stride; x++) prev[x] = (row[x + 1] + prev[x]) & 0xff
      for (let i = 0; i < image.width * 3; i++) {
        expect((prev[2 * i] << 8) | prev[2 * i + 1]).toBe(expected(image.rgb[y * image.width * 3 + i]))
      }
    }
  })

  it('writes a 16-bit TIFF our own reader understands', async () => {
    const image = gradient(20, 150)
    const bytes = new Uint8Array(await encodeTiff16(image).arrayBuffer())
    const tiff = parseTiff(bytes)
    const ifd = tiff.ifds[0]
    expect(num(ifd, Tag.ImageWidth)).toBe(20)
    expect(num(ifd, Tag.ImageLength)).toBe(150)
    expect(nums(ifd, Tag.BitsPerSample)).toEqual([16, 16, 16])
    const offsets = nums(ifd, Tag.StripOffsets) ?? []
    const counts = nums(ifd, Tag.StripByteCounts) ?? []
    expect(offsets.length).toBe(3)
    const r = new ByteReader(bytes, true)
    let i = 0
    offsets.forEach((offset, s) => {
      for (let k = 0; k < counts[s]; k += 2, i++) expect(r.u16(offset + k)).toBe(expected(image.rgb[i]))
    })
    expect(i).toBe(image.rgb.length)
  })

  it('writes EXIF that reads back as the same shooting info', () => {
    const info = {
      camera: 'Hasselblad X1D', lens: 'XCD 45P', focalLength: 45, aperture: 6.3, shutterSeconds: 1 / 50,
      iso: 400, exposureCompensation: -2 / 3, taken: new Date(2026, 8, 12, 14, 56, 5),
    }
    const segment = exifSegment(info)
    expect(segment).not.toBeNull()
    const bytes = segment as Uint8Array
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xe1)
    expect((bytes[2] << 8) | bytes[3]).toBe(bytes.length - 2)
    const tiff = parseTiff(bytes.subarray(10))
    const back = shootingInfo(tiff.ifds[0], tiff.ifds[0].exif)
    expect(back.camera).toBe('Hasselblad X1D')
    expect(back.lens).toBe('XCD 45P')
    expect(back.iso).toBe(400)
    expect(back.shutterSeconds).toBeCloseTo(1 / 50)
    expect(back.aperture).toBeCloseTo(6.3)
    expect(back.exposureCompensation).toBeCloseTo(-2 / 3, 2)
    expect(back.taken?.getTime()).toBe(info.taken.getTime())
  })
})
