import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookEngineFromModule } from './engine'
import { RECIPE_SIZE, readRecipe, recipeBytes } from './recipe'

const module = new WebAssembly.Module(readFileSync(new URL('./wasm/look.wasm', import.meta.url)))
const engine = lookEngineFromModule(module, { worker: false })

describe('look engine', () => {
  it('starts from look_defaults', () => {
    const d = engine.defaults()
    expect(d).toEqual(engine.parse(''))
    expect(d.mono).toBe(false)
    expect(d.film).toBe('standard')
    expect(d.monoRed).toBeCloseTo(0.35, 6)
    expect(d.grainSize).toBeCloseTo(0.3, 6)
    expect(d.seed).toBe(1)
    expect(d.mixHue).toHaveLength(8)
  })

  it('marshals every field both ways', () => {
    const s = engine.parse(
      'film = muted\nmono = 1\ncontrast = 0.25\ngrade_shadows = 200, 0.5\nmix_aqua = 0.5, -0.5, 0.25\nseed = 3000000000\n',
    )
    expect(s).toMatchObject({ film: 'muted', mono: true, contrast: 0.25, gradeShadowHue: 200, gradeShadowAmount: 0.5 })
    expect(s.mixHue[4]).toBe(0.5)
    expect(s.mixSaturation[4]).toBe(-0.5)
    expect(s.mixLightness[4]).toBe(0.25)
    expect(s.seed).toBe(3000000000)
    const bytes = recipeBytes(s)
    expect(bytes).toHaveLength(RECIPE_SIZE)
    expect(readRecipe(new DataView(bytes.buffer))).toEqual(s)
    expect(engine.parse(engine.format(s))).toEqual(s)
  })

  it('knows black and white', () => {
    expect(engine.isMono(engine.defaults())).toBe(false)
    expect(engine.isMono(engine.parse('mono = 1'))).toBe(true)
    expect(engine.isMono(engine.parse('film = silver'))).toBe(true)
  })

  it('recognises the lines look_parse takes', () => {
    expect(engine.recognises('contrast = 0.3')).toBe(true)
    expect(engine.recognises('  film = silver')).toBe(true)
    expect(engine.recognises('mix_red = 0.1, 0.2, 0.3')).toBe(true)
    expect(engine.recognises('future_setting = 1')).toBe(false)
    expect(engine.recognises('film = Chrome')).toBe(false)
    expect(engine.recognises('mix_red = 0.1, 0.2')).toBe(false)
    expect(engine.recognises('# contrast = 0.3')).toBe(false)
    expect(engine.recognises('contrast')).toBe(false)
  })

  it('says whether a recipe changes the picture, ignoring the seed', () => {
    expect(engine.changesPicture(engine.defaults())).toBe(false)
    expect(engine.changesPicture({ ...engine.defaults(), seed: 99 })).toBe(false)
    expect(engine.changesPicture(engine.parse('contrast = 0.1'))).toBe(true)
    expect(engine.changesPicture(engine.parse('mix_blue = 0, 0, 0.1'))).toBe(true)
  })

  it('names the mixer bands and their colours', () => {
    expect(engine.mixBandNames).toEqual(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'])
    const [r, g, b] = engine.mixBandColour(0)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    const blue = engine.gradeColour(240)
    expect(blue[2]).toBeGreaterThan(blue[0])
  })

  it('builds tables of n³ colours', () => {
    expect(engine.buildTable(engine.defaults(), 33)).toHaveLength(3 * 33 ** 3)
    expect(() => engine.buildTable(engine.defaults(), 1)).toThrow(RangeError)
  })

  it('applies to a copy and leaves the picture alone', async () => {
    const rgb = new Float32Array(3 * 8 * 6).map((_, i) => (i % 17) / 16)
    const before = rgb.slice()
    const out = await engine.applyImage(engine.parse('contrast = 0.5\ngrain = 0.5'), { width: 8, height: 6, rgb })
    expect(out.width).toBe(8)
    expect(out.height).toBe(6)
    expect(out.rgb).not.toBe(rgb)
    expect(rgb).toEqual(before)
    expect(out.rgb).not.toEqual(before)
  })

  it('refuses a picture whose size and pixels disagree', async () => {
    await expect(engine.applyImage(engine.defaults(), { width: 4, height: 4, rgb: new Float32Array(5) })).rejects.toThrow(
      RangeError,
    )
  })

  it('cancels calls that have not started', async () => {
    const image = { width: 16, height: 16, rgb: new Float32Array(3 * 256).fill(0.5) }
    const first = engine.applyImage(engine.defaults(), image)
    const second = engine.applyImage(engine.parse('contrast = 0.2'), image)
    engine.cancelPending()
    await expect(first).resolves.toMatchObject({ width: 16 })
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  })
})
