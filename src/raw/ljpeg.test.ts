import { describe, expect, it } from 'vitest'
import { buildHuffman, decodeHasselblad, parseLjpegHeader } from './ljpeg'

// Bit lengths 0..16 as Huffman symbols, the way Hasselblad's tables code them.
const COUNTS = [0, 0, 4, 4, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]

function codes(): Map<number, { code: number; length: number }> {
  const out = new Map<number, { code: number; length: number }>()
  let code = 0
  let v = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < COUNTS[len - 1]; i++) out.set(VALUES[v++], { code: code++, length: len })
    code <<= 1
  }
  return out
}

/** The inverse of decodeHasselblad, written from the same description, for round trips. */
function encode(pixels: Uint16Array, width: number, height: number, predictor: number): Uint8Array {
  const table = codes()
  const bits: number[] = []
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  const rows = [new Int32Array(width), new Int32Array(width), new Int32Array(width)]
  for (let row = 0; row < height; row++) {
    const twoUp = rows[(row + 1) % 3]
    const current = rows[row % 3]
    for (let col = 0; col < width; col += 2) {
      const diffs: number[] = []
      for (let s = col; s < col + 2; s++) {
        let pred = col ? current[s - 2] : 0x8000
        if (col && row > 1 && predictor === 11) pred += ((twoUp[s] / 2) | 0) - ((twoUp[s - 2] / 2) | 0)
        const value = pixels[row * width + s]
        diffs.push(value - pred)
        current[s] = value
      }
      const lens = diffs.map((d) => (d === 0 ? 0 : d === -32768 ? 16 : Math.floor(Math.log2(Math.abs(d))) + 1))
      for (const len of lens) {
        const c = table.get(len)
        if (!c) throw new Error('no code')
        put(c.code, c.length)
      }
      diffs.forEach((d, k) => {
        const len = lens[k]
        if (len === 0) return
        const v = d === -32768 ? 0xffff : d > 0 ? d : d + (1 << len) - 1
        put(v, len)
      })
    }
  }
  while (bits.length % 32) bits.push(0)
  const stream = new Uint8Array(bits.length / 8)
  for (let i = 0; i < stream.length; i++) {
    let b = 0
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]
    // the stream is little-endian 32-bit words
    stream[(i & ~3) + 3 - (i & 3)] = b
  }
  const dht = [0xff, 0xc4, 0, 3 + 16 + VALUES.length, 0x00, ...COUNTS, ...VALUES]
  const sof = [0xff, 0xc3, 0, 11, 16, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0x00, predictor, 0, 0]
  return new Uint8Array([0xff, 0xd8, ...dht, ...sof, ...sos, ...stream])
}

function picture(width: number, height: number, seed: number): Uint16Array {
  const out = new Uint16Array(width * height)
  let s = seed
  const random = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const smooth = 20000 + 15000 * Math.sin(x / 7) * Math.cos(y / 5)
      out[y * width + x] = Math.max(0, Math.min(65535, Math.round(smooth + (random() - 0.5) * 3000)))
    }
  }
  // a few extremes, so long codes and big jumps are exercised
  out[5] = 65535
  out[6] = 0
  out[width + 9] = 65535
  return out
}

describe('Hasselblad lossless JPEG', () => {
  it('builds a canonical Huffman lookup', () => {
    const { table, bits } = buildHuffman([0, 1, 2], [7, 8, 9])
    expect(bits).toBe(3)
    // codes: 7 → 00, 8 → 010, 9 → 011
    expect(table[0b000] >> 8).toBe(2)
    expect(table[0b001] & 0xff).toBe(7)
    expect(table[0b010]).toBe((3 << 8) | 8)
    expect(table[0b011]).toBe((3 << 8) | 9)
  })

  it('reads the predictor and where the scan starts', () => {
    const data = encode(picture(8, 4, 1), 8, 4, 11)
    const header = parseLjpegHeader(data)
    expect(header.predictor).toBe(11)
    expect(data[header.dataStart - 10]).toBe(0xff)
    expect(data[header.dataStart - 9]).toBe(0xda)
  })

  for (const predictor of [1, 11]) {
    it(`round-trips a picture with predictor ${predictor}`, () => {
      const width = 64, height = 23
      const pixels = picture(width, height, predictor)
      const out = new Uint16Array(width * height)
      decodeHasselblad(encode(pixels, width, height, predictor), width, height, out)
      expect(Array.from(out)).toEqual(Array.from(pixels))
    })
  }

  it('rejects data that is not a JPEG', () => {
    expect(() => parseLjpegHeader(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })
})
