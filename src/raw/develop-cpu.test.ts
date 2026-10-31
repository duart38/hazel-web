import { describe, expect, it } from 'vitest'
import { tone, type DevelopParams } from './colour'
import { blendHighlights, developCpu } from './develop-cpu'

const W = 40
const H = 30

function params(): DevelopParams {
  return {
    crop: { x: 2, y: 2, width: 32, height: 24 },
    cfa: [0, 1, 1, 2],
    black: [256, 256, 256, 256],
    white: 65535,
    wb: [2, 1, 1.5],
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    orientation: 1,
    iso: 100,
    shadowShift: 0,
  }
}

/** A raw of one neutral grey: each channel's sample is `level` before white balance. */
function flatRaw(level: number, p: DevelopParams): Uint16Array {
  const raw = new Uint16Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y & 1) * 2 + (x & 1)
      raw[y * W + x] = Math.round(p.black[i] + (level / p.wb[p.cfa[i]]) * (p.white - p.black[i]))
    }
  }
  return raw
}

describe('developCpu', () => {
  it('develops a flat grey to the tone curve value, binned and demosaiced alike', () => {
    const p = params()
    const raw = flatRaw(0.18, p)
    const expected = tone(0.18)
    for (const longSide of [16, 32]) {
      const image = developCpu(raw, W, p, longSide)
      expect(image.width).toBe(longSide === 32 ? 32 : 16)
      for (const v of image.rgb) expect(v).toBeCloseTo(expected, 2)
    }
  })

  it('turns an evenly clipped area white, not pink', () => {
    const p = params()
    const raw = new Uint16Array(W * H).fill(65535)
    const image = developCpu(raw, W, p, 32)
    for (const v of image.rgb) expect(v).toBe(1)
  })
})

describe('blendHighlights', () => {
  it('leaves colours below the clip level alone', () => {
    const rgb = [0.5, 0.4, 0.2]
    blendHighlights(rgb, 0.5)
    expect(rgb).toEqual([0.5, 0.4, 0.2])
  })

  it('keeps the brightness of a clipped pixel but only the colour its clipped version has', () => {
    const rgb = [2, 1, 1.5]
    blendHighlights(rgb, 0.5)
    expect(rgb[0] + rgb[1] + rgb[2]).toBeCloseTo(4.5, 6)
    // the clipped version (1, 1, 1) has no colour at all
    expect(rgb[0]).toBeCloseTo(1.5, 6)
    expect(rgb[1]).toBeCloseTo(1.5, 6)
    expect(rgb[2]).toBeCloseTo(1.5, 6)
  })

  it('lifts the other channels next to a sample at the white point', () => {
    const rgb = [0.8, 1, 1]
    blendHighlights(rgb, 1)
    expect(rgb).toEqual([1, 1, 1])
  })
})
