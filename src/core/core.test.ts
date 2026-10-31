import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookEngineFromModule } from '../look/engine'
import { readCardSlots, writeCardSlots, CARD_README, photoFolders, isCard, sameSlotRecipe } from './card'
import { isCollectionFile, mergedIncluded, RecipeCollection, sha256Hex } from './collection'
import { MemoryFolder } from './folder'
import { daysLeft, formatSlots, INCLUDED, libraryFileName, parseSlots, RecipeLibrary, STARTER_NAMES } from './library'
import { exportName, isPhotoName, listPhotos } from './photos'
import { proposalFileName, proposalProblems, proposalRecipe, proposalUrl } from './proposal'
import {
  parseSidecar,
  recipeNotes,
  recipeSummary,
  sidecarLabel,
  sidecarRecipe,
  STORED_ROOM,
  storedSize,
  unsupportedSettings,
} from './recipe'
import {
  displayValue,
  filmSettingsFrom,
  neutralSettings,
  recipeText,
  sameSettings,
  SATURATION,
  TONE,
  withBlackAndWhite,
  withFilm,
  withHue,
  withValue,
  GRADE_TINTS,
  type FilmSettings,
} from './settings'
import { shutterText, stopsText, infoHelp, infoParts, trimmed } from './shootingInfo'
import { MemoryStore } from './storage'
import { gradeColour, lookUp, mixBandColour } from './swatch'
import { crc32, zip } from './zip'

const look = lookEngineFromModule(new WebAssembly.Module(readFileSync(new URL('../look/wasm/look.wasm', import.meta.url))), { worker: false })
const read = (text: string): FilmSettings => filmSettingsFrom(look.parse(text), text)

describe('recipe text', () => {
  it('reads the name and notes from # lines', () => {
    const text = '# Gold 200\n# Warm colour.\n#\n# On the camera: daylight.\ncontrast = 0.1\n'
    expect(recipeSummary(text)).toBe('Gold 200')
    expect(recipeNotes(text)).toEqual(['Warm colour.', 'On the camera: daylight.'])
    expect(recipeSummary('contrast = 1\n')).toBeUndefined()
  })

  it('counts the bytes the camera keeps: name line and settings, not other notes', () => {
    const text = '# Ab\n# a long note that the camera drops\nmono = 1\n'
    // "# Ab\n" + "mono = 1\n" + the empty line after the last newline
    expect(storedSize(text)).toBe(5 + 9 + 1)
    expect(STORED_ROOM).toBe(914)
  })

  it('names settings a newer Hazel would have', () => {
    expect(unsupportedSettings('# x\ncontrast = 0.2\nsparkle = 1\nmix_teal = 0, 0, 0\nfilm = velvia\n')).toEqual([
      'sparkle',
      'mix_teal',
      'film',
    ])
    for (const included of INCLUDED) expect(unsupportedSettings(included.text)).toEqual([])
  })

  it('round-trips every included recipe through the settings', () => {
    for (const included of INCLUDED) {
      const settings = read(included.text)
      const again = read(recipeText(included.name, settings))
      expect(sameSettings(settings, again)).toBe(true)
      expect(recipeSummary(recipeText(included.name, settings))).toBe(included.name)
    }
  })

  it('writes only what differs from neutral, in the Mac app format', () => {
    let settings = withValue(neutralSettings(), 'contrast', 0.4)
    settings = withValue(settings, 'grain_size', 0.3)
    settings = withHue(settings, GRADE_TINTS[0], -20)
    settings = withValue(settings, 'grade_shadow_amount', 0.3)
    settings = withValue(settings, 'mix_blue_saturation', 0.45)
    expect(recipeText('Test', settings)).toBe(
      '# Test\ncontrast = 0.400\ngrade_shadows = 340.0, 0.300\nmix_blue = 0.000, 0.450, 0.000\n',
    )
    const silver = withFilm(withBlackAndWhite(neutralSettings(), true), 'silver')
    expect(recipeText('S', silver)).toBe('# S\nfilm = silver\n')
    const red = { ...withBlackAndWhite(neutralSettings(), true), monoMix: [0.7, 0.28, 0.02] as const }
    expect(recipeText('R', red)).toBe('# R\nmono = 1\nmono_mix = 0.700, 0.280, 0.020\n')
    expect(withBlackAndWhite(silver, false).film).toBe('standard')
  })

  it('clamps values to their range and shows them on the ±4 scale', () => {
    expect(withValue(neutralSettings(), 'grain', 3).values.grain).toBe(1)
    expect(displayValue(SATURATION, 0.25)).toBe('+1.0')
    expect(displayValue(TONE[4], 0.5)).toBe('2.0')
    expect(displayValue(SATURATION, 0.001)).toBe('0')
    expect(displayValue(SATURATION, -0.5)).toBe('-2.0')
  })

  it('reads sidecars, including the camera’s plain black and white', () => {
    const recipe = parseSidecar('x1d-look = 1\nlook = recipe\n# warm: test\ncontrast = 0.4\n\n\n\n')
    expect(recipe.look).toBe('recipe')
    expect(sidecarLabel(recipe)).toBe('Film look: warm: test')
    const mono = parseSidecar('look = mono\n')
    expect(sidecarRecipe(mono)).toContain('mono = 1')
    expect(sidecarLabel(mono)).toBe('Black and white')
    expect(sidecarRecipe(parseSidecar('look = none\n'))).toBeNull()
  })
})

describe('library', () => {
  it('starts with the seven starters in the slots, and renames, deletes and restores', async () => {
    const library = new RecipeLibrary(new MemoryStore(), read)
    const recipes = await library.load()
    expect(recipes.map((r) => r.name).sort()).toEqual([...STARTER_NAMES].sort())
    const slots = await library.loadSlots()
    expect(slots.C1).toBe('Gritty black and white')
    expect(slots.C7).toBe('Neutral')

    const gold = recipes.find((r) => r.name === 'Gold 200')!
    const renamed = await library.save('Gold 400', gold.settings, gold)
    expect(renamed.file).toBe('Gold 400.txt')
    expect((await library.load()).some((r) => r.name === 'Gold 200')).toBe(false)

    const now = Date.UTC(2026, 9, 1)
    await library.delete(renamed, now)
    const deleted = await library.deleted(now + 86_400_000)
    expect(deleted.map((d) => d.name)).toEqual(['Gold 400'])
    expect(daysLeft(deleted[0], now + 86_400_000)).toBe(29)
    expect(await library.deleted(now + 31 * 86_400_000)).toEqual([])
  })

  it('restores a deleted recipe under a given name', async () => {
    const library = new RecipeLibrary(new MemoryStore(), read)
    const [first] = await library.load()
    await library.delete(first)
    const [gone] = await library.deleted()
    const back = await library.restore(gone, `${first.name} 2`)
    expect(back.name).toBe(`${first.name} 2`)
    expect(await library.deleted()).toEqual([])
  })

  it('makes file names any card accepts', () => {
    expect(libraryFileName('Warm / cool: 1')).toBe('Warm - cool- 1')
    expect(libraryFileName('   ')).toBe('Recipe')
    expect(libraryFileName('x'.repeat(80))).toHaveLength(60)
  })

  it('writes and reads slots.txt', () => {
    const text = formatSlots({ C1: 'Neutral', C3: 'Gold 200' })
    expect(text).toBe('C1 = Neutral\nC2 = \nC3 = Gold 200\nC4 = \nC5 = \nC6 = \nC7 = \n')
    expect(parseSlots(text)).toEqual({ C1: 'Neutral', C3: 'Gold 200' })
    expect(parseSlots('C9 = x\nC2=Silver = screen\n')).toEqual({ C2: 'Silver = screen' })
  })
})

describe('card', () => {
  it('writes C1..C7 and the README, removing emptied slots', async () => {
    const card = new MemoryFolder('Untitled')
    await writeCardSlots(card, { C1: '# A\n', C2: '# B\n' })
    expect(await readCardSlots(card)).toEqual({ C1: '# A\n', C2: '# B\n' })
    await writeCardSlots(card, { C2: '# B2\n' })
    expect(await readCardSlots(card)).toEqual({ C2: '# B2\n' })
    const paths = card.allFiles().map(([p]) => p).sort()
    expect(paths).toEqual(['HAZEL/README.txt', 'HAZEL/recipes/C2.txt'])
    expect(await card.allFiles().find(([p]) => p === 'HAZEL/README.txt')![1].text()).toBe(CARD_README)
    expect(await isCard(card)).toBe(true)
  })

  it('finds the camera’s photo folders and the photos in them, with sidecars', async () => {
    const card = new MemoryFolder('Untitled')
    const dcim = (await card.folder('DCIM', true)) as MemoryFolder
    const folder = (await dcim.folder('100HASBL', true)) as MemoryFolder
    await dcim.folder('MISC', true)
    await folder.writeFile('B0000002.3FR', 'raw')
    await folder.writeFile('B0000002.look', 'look = mono\n')
    await folder.writeFile('B0000001.3FR', 'raw')
    await folder.writeFile('._B0000001.3FR', 'apple double')
    await folder.writeFile('B0000001-film.jpg', 'export')
    expect(await photoFolders(card)).toEqual(['100HASBL'])
    const photos = await listPhotos(folder)
    expect(photos.map((p) => p.name)).toEqual(['B0000001.3FR', 'B0000002.3FR'])
    expect(photos[0].sidecar).toBeNull()
    expect(photos[1].sidecar?.look).toBe('mono')
    expect(isPhotoName('x.HEIC')).toBe(true)
    expect(exportName('B0000001.3FR', 'tiff')).toBe('B0000001-film.tiff')
  })
})

describe('sharing a recipe', () => {
  const settings = read(INCLUDED.find((r) => r.name === 'Gold 200')!.text)

  it('names the file as the collection does', () => {
    expect(proposalFileName('Gold 200')).toBe('gold-200.txt')
    expect(proposalFileName('  Rêve: été! ')).toBe('r-ve-t.txt')
    expect(proposalFileName('!!!')).toBe('.txt')
  })

  it('puts the description first among the notes', () => {
    const text = proposalRecipe(' Honey ', settings, '  Warm and golden.  ')
    expect(text.split('\n').slice(0, 3)).toEqual(['# Honey', '# Warm and golden.', settings.notes[1] ? `# ${settings.notes[1]}` : text.split('\n')[2]])
    expect(proposalRecipe('Plain', neutralSettings(), 'Nothing at all.')).toBe('# Plain\n# Nothing at all.\n')
  })

  it('checks the collection’s rules', () => {
    expect(proposalProblems(proposalRecipe('Honey', neutralSettings(), 'Warm.'), ['Gold 200'])).toEqual([])
    const problems = proposalProblems(proposalRecipe('Kodak gold', neutralSettings(), ''), ['Kodak Gold'])
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('company name')
    expect(problems[1]).toContain('description')
    expect(problems[2]).toContain('already has')
    expect(proposalProblems('# ?\n# d\n', [])[0]).toContain('letters or numbers')
    const long = proposalRecipe('Long', { ...neutralSettings(), values: {} }, 'x') + 'x'.repeat(1000)
    expect(proposalProblems(long, []).some((p) => p.includes('bytes'))).toBe(true)
  })

  it('opens GitHub with the recipe filled in, + & = # encoded', () => {
    const url = proposalUrl('# A+B & C\n# d = e #1\n')
    expect(url).toBe(
      'https://github.com/duart38/Hazel-film-recipes/new/main/recipes?filename=a-b-c.txt&value=%23%20A%2BB%20%26%20C%0A%23%20d%20%3D%20e%20%231%0A',
    )
  })
})

describe('recipe collection', () => {
  const gold = INCLUDED.find((r) => r.name === 'Gold 200')!
  const bytes = (text: string) => new TextEncoder().encode(text)

  function server(files: Record<string, string | number>): typeof fetch {
    return async (input) => {
      const path = String(input).replace('https://example.test/c/', '')
      const body = files[path]
      if (body === undefined) return new Response('nope', { status: 404 })
      if (typeof body === 'number') return new Response('err', { status: body })
      return new Response(bytes(body), { status: 200 })
    }
  }

  it('keeps recipes whose file matches the index and skips the rest, with why', async () => {
    const goodHash = await sha256Hex(bytes(gold.text))
    const tooLong = '# Long\n' + 'contrast = 0.1\n'.repeat(80)
    const index = {
      recipes: [
        { name: 'Gold 200', file: 'recipes/gold-200.txt', sha256: goodHash.toUpperCase() },
        { name: 'Tampered', file: 'recipes/tampered.txt', sha256: goodHash },
        { name: 'Escape', file: 'recipes/../../x.txt', sha256: goodHash },
        { name: 'Other', file: 'recipes/other.txt', sha256: await sha256Hex(bytes('# Different\n')) },
        { name: 'Long', file: 'recipes/long.txt', sha256: await sha256Hex(bytes(tooLong)) },
        { name: 'Missing', file: 'recipes/missing.txt', sha256: goodHash },
      ],
    }
    const store = new MemoryStore()
    const collection = new RecipeCollection(
      store,
      'https://example.test/c',
      server({
        'index.json': JSON.stringify(index),
        'recipes/gold-200.txt': gold.text,
        'recipes/tampered.txt': gold.text + '# extra\n',
        'recipes/other.txt': '# Different\n',
        'recipes/long.txt': tooLong,
      }),
    )
    const fetched = await collection.refresh()
    expect(fetched.recipes.map((r) => r.name)).toEqual(['Gold 200'])
    expect(fetched.skipped).toEqual([
      'Tampered: not the file the index describes',
      "Escape: its file isn't in the collection",
      'Other: the file has another name in it',
      'Long: too long for the camera',
      "Missing: not found (a private collection can't be read)",
    ])
    expect((await collection.cached()).map((r) => r.name)).toEqual(['Gold 200'])
  })

  it('throws when the index can’t be had, and keeps last time’s copy of a recipe that fails', async () => {
    const store = new MemoryStore()
    await store.set('recipe-collection.json', [gold])
    await expect(new RecipeCollection(store, 'https://example.test/c', server({ 'index.json': 500 })).refresh()).rejects.toThrow(
      'the server answered 500',
    )
    const index = { recipes: [{ name: 'Gold 200', file: 'recipes/gold-200.txt', sha256: '00' }] }
    const fetched = await new RecipeCollection(store, 'https://example.test/c', server({ 'index.json': JSON.stringify(index), 'recipes/gold-200.txt': 'x' })).refresh()
    expect(fetched.recipes).toEqual([gold])
  })

  it('checks paths and merges with the built-in recipes', () => {
    expect(isCollectionFile('recipes/a.txt')).toBe(true)
    expect(isCollectionFile('recipes//a.txt')).toBe(false)
    expect(isCollectionFile('other/a.txt')).toBe(false)
    const merged = mergedIncluded(
      [
        { name: 'A', text: '# A\n' },
        { name: 'B', text: '# B\n' },
      ],
      [
        { name: 'C', text: '# C\n' },
        { name: 'B', text: '# B\ncontrast = 1\n' },
      ],
    )
    expect(merged.map((r) => r.text)).toEqual(['# A\n', '# B\ncontrast = 1\n', '# C\n'])
  })
})

describe('shooting info', () => {
  it('writes shutter speeds and compensation the way cameras do', () => {
    expect(shutterText(1 / 125)).toBe('1/125 s')
    expect(shutterText(0.5)).toBe('0.5 s')
    expect(shutterText(2)).toBe('2 s')
    expect(stopsText(1 / 3)).toBe('+1/3 EV')
    expect(stopsText(-5 / 3)).toBe('−1 2/3 EV')
    expect(stopsText(0.05)).toBeUndefined()
    expect(trimmed(3.5)).toBe('3.5')
    expect(infoParts({ shutterSeconds: 1 / 60, aperture: 4, iso: 400, focalLength: 45, lens: 'XCD 45' })).toEqual([
      '1/60 s',
      'f/4',
      'ISO 400',
      '45 mm',
      'XCD 45',
    ])
  })

  it('says in the tooltip only what the photo has', () => {
    expect(infoHelp({ shutterSeconds: 1 / 60 })).toBe('As the camera recorded it: shutter speed, aperture, ISO')
    expect(infoHelp({ exposureCompensation: 2 / 3, taken: new Date(2026, 8, 12) })).toBe(
      "As the camera recorded it: shutter speed, aperture, ISO, exposure compensation, the date is by the camera's own clock",
    )
    expect(infoHelp({ focalLength: 45, focalLength35mm: 35 })).toBe(
      'As the camera recorded it: shutter speed, aperture, ISO, 45 mm is like 35 mm on a 35 mm camera',
    )
    expect(infoParts({ iso: 100, mode: 'Aperture priority' })).toEqual(['ISO 100', 'Aperture priority'])
  })
})

describe('swatches and zips', () => {
  it('looks colours up in a table', () => {
    const n = 3
    const table = new Float32Array(n * n * n * 3)
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) table.set([r / 2, g / 2, b / 2], ((b * n + g) * n + r) * 3)
    const out = lookUp(table, n, [0.3, 0.6, 0.9])
    expect(out[0]).toBeCloseTo(0.3)
    expect(out[1]).toBeCloseTo(0.6)
    expect(out[2]).toBeCloseTo(0.9)
  })

  it('gives warm grading and mixer colours their own hue', () => {
    const red = gradeColour(0)
    expect(red[0]).toBeGreaterThan(red[2])
    const blue = mixBandColour(5)
    expect(blue[2]).toBeGreaterThan(blue[0])
  })

  it('zips files a zip reader can check', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const blob = await zip([['HAZEL/README.txt', 'hi']])
    const view = new DataView(await blob.arrayBuffer())
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint32(blob.size - 22, true)).toBe(0x06054b50)
  })
})

describe('slots on the card', () => {
  const older = '# Gritty black and white\nmono = 1\ncontrast = 0.4\nshadows = -0.2\nclarity = 0.8\ngrain = 0.5\ngrain_size = 0.6\nvignette = 0.3\n'
  const app = '# Gritty black and white\n# Hard black and white with coarse grain and strong local contrast.\nmono = 1\ncontrast = 0.400\nshadows = -0.200\nclarity = 0.800\ngrain = 0.500\ngrain_size = 0.600\nvignette = 0.300\n'

  it('counts a recipe written the older way as the same', () => {
    expect(sameSlotRecipe(look, app, older)).toBe(true)
  })

  it('tells a changed setting or name apart', () => {
    expect(sameSlotRecipe(look, app, older.replace('grain = 0.5', 'grain = 0.6'))).toBe(false)
    expect(sameSlotRecipe(look, app, older.replace('# Gritty', '# Grainy'))).toBe(false)
  })
})
