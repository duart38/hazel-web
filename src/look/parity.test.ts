// look.wasm against the native build of look.c: the recipe text, per-pixel colour, tables and
// the whole-image look, bit for bit. The expected values in testdata/ come from look.c compiled
// natively with clang -O2 -ffp-contract=off. Text is Apple's own build; the pictures use a native
// build whose powf, expf, sinf... are the correctly rounded ones JavaScript gives, because Apple's
// float maths is a little less exact (native/regenerate.sh rebuilds testdata/).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LookWasm } from './wasm'

interface FormatCase { name: string; input: string; output: string; recognised: number }
interface FloatCase { name: string; input: string; offset: number; floats: number }
interface ApplyCase extends FloatCase { width: number; height: number }
interface HashCase { name: string; input: string; width: number; height: number; fnv1a: number }
interface TableCase { name: string; input: string; n: number; fnv1a: number }

const read = (path: string) => readFileSync(new URL(path, import.meta.url))
const module = new WebAssembly.Module(read('./wasm/look.wasm'))
const look = new LookWasm(module)
const formatCases: FormatCase[] = JSON.parse(new TextDecoder().decode(read('./testdata/format.json')))
const manifest: { pixels: FloatCase[]; apply: ApplyCase[]; hashes: HashCase[]; tables: TableCase[] } = JSON.parse(
  new TextDecoder().decode(read('./testdata/native.json')),
)
const nativeBytes = read('./testdata/native.bin')
const native = (c: FloatCase) => new Float32Array(nativeBytes.buffer, nativeBytes.byteOffset + c.offset, c.floats)

/** The largest difference, and how many floats differ at all. */
function compare(a: Float32Array, b: Float32Array): { max: number; differing: number } {
  let max = 0, differing = 0
  for (let i = 0; i < a.length; i++) {
    if (Object.is(a[i], b[i])) continue
    differing++
    max = Math.max(max, Number.isNaN(a[i] - b[i]) ? Infinity : Math.abs(a[i] - b[i]))
  }
  return { max, differing }
}

function fnv1a(floats: Float32Array): number {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0
  return h
}

function synthetic(width: number, height: number): Float32Array {
  const rgb = new Float32Array(3 * width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = 3 * (y * width + x)
      rgb[p] = ((x * 37 + y * 11) % 257) / 256
      rgb[p + 1] = ((x * 5 + y * 29) % 257) / 256
      rgb[p + 2] = ((x * x + y * 3) % 257) / 256
    }
  return rgb
}

const grid = (n: number) => {
  const rgb = new Float32Array(3 * n * n * n)
  let i = 0
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        rgb[i++] = r / (n - 1)
        rgb[i++] = g / (n - 1)
        rgb[i++] = b / (n - 1)
      }
  return rgb
}

describe('recipe text', () => {
  it.each(formatCases.map((c) => [c.name, c]))('%s formats exactly like the native build', (_, c) => {
    const { settings, recognised } = look.parse(c.input)
    expect(look.format(settings)).toBe(c.output)
    expect(recognised).toBe(c.recognised)
  })

  it('settles after one trip through the text', () => {
    // Not always after zero: look.c keeps a shadow hue of 359.96, which prints as 360.0 and
    // reads back as 0.0 (the same colour).
    for (const c of formatCases) {
      const once = look.format(look.parse(c.input).settings)
      const twice = look.format(look.parse(once).settings)
      expect(look.format(look.parse(twice).settings)).toBe(twice)
    }
  })
})

describe('per-pixel look', () => {
  it.each(manifest.pixels.map((c) => [c.name, c]))('%s: look_pixel and a 5-point table', (_, c) => {
    const settings = look.parse(c.input).settings
    const expected = native(c)
    const pixels = look.pixels(settings, grid(5))
    const table = look.buildTable(settings, 5)
    expect(compare(pixels, expected.subarray(0, pixels.length))).toEqual({ max: 0, differing: 0 })
    expect(compare(table, expected.subarray(pixels.length))).toEqual({ max: 0, differing: 0 })
  })

  it.each(manifest.tables.map((c) => [c.name, c]))('%s: the 33-point table for the GPU', (_, c) => {
    expect(fnv1a(look.buildTable(look.parse(c.input).settings, c.n))).toBe(c.fnv1a)
  })
})

describe('whole image', () => {
  it.each(manifest.apply.map((c) => [c.name, c]))('%s: look_apply_image, 32×24', (_, c) => {
    const out = look.applyImage(look.parse(c.input).settings, synthetic(c.width, c.height), c.width, c.height)
    expect(compare(out, native(c))).toEqual({ max: 0, differing: 0 })
  })

  it.each(manifest.hashes.map((c) => [c.name, c]))('%s: look_apply_image, 400×600 with sharpness', (_, c) => {
    const out = look.applyImage(look.parse(c.input).settings, synthetic(c.width, c.height), c.width, c.height)
    expect(fnv1a(out)).toBe(c.fnv1a)
  })
})
