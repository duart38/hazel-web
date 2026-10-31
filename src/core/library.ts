// The recipes kept in this browser, and which of them go in the camera's seven slots. Everything
// is plain text, as in the Mac app's folder: one `<name>.txt` per recipe (the text the camera
// reads) and `slots.txt` with a line per slot (`C1 = Gritty black and white`).

import { recipeSummary } from './recipe'
import { recipeText, type FilmSettings } from './settings'
import { COLLECTION_SNAPSHOT } from './snapshot'
import type { Store } from './storage'

export const SLOT_NAMES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const
export type SlotName = (typeof SLOT_NAMES)[number]
export type Slots = Partial<Record<SlotName, string>>

/** Reads a recipe's settings through the look engine. */
export type ReadSettings = (text: string) => FilmSettings

/** A recipe the app keeps, named by the recipe. */
export interface StoredRecipe {
  file: string
  name: string
  settings: FilmSettings
}

/** A recipe that comes with the app. */
export interface IncludedRecipe {
  name: string
  text: string
}

/** A recipe in Recently Deleted. */
export interface DeletedRecipe {
  file: string
  name: string
  settings: FilmSettings
  deletedAt: number
}

export const KEEP_DELETED_MS = 30 * 24 * 3600 * 1000

/** whole days left before it's removed, at least 1 while it's still listed */
export function daysLeft(recipe: DeletedRecipe, now = Date.now()): number {
  return Math.max(1, Math.ceil((KEEP_DELETED_MS - (now - recipe.deletedAt)) / 86_400_000))
}

export function storedText(recipe: { name: string; settings: FilmSettings }): string {
  return recipeText(recipe.name, recipe.settings)
}

/** The seven a new library starts with, in the slots C1 to C7, in this order. Hazel-firmware's
 *  `hazel/slots` has the same seven, in the same order. */
export const STARTER_NAMES = [
  'Gritty black and white',
  'Red filter black and white',
  'Warm portrait',
  'Silver screen',
  'Gold 200',
  'Faded chrome',
  'Neutral',
]

/** Every recipe that comes with the app: the starters first, then the rest of the collection. */
export const INCLUDED: IncludedRecipe[] = [
  ...STARTER_NAMES.flatMap((name) => COLLECTION_SNAPSHOT.filter((r) => r.name === name)),
  ...COLLECTION_SNAPSHOT.filter((r) => !STARTER_NAMES.includes(r.name)),
]

/** A file name any card and file system accepts. */
export function libraryFileName(name: string): string {
  const cleaned = [...name].map((c) => (/^[\p{L}\p{N}\p{M} _-]$/u.test(c) ? c : '-')).join('').trim()
  return cleaned === '' ? 'Recipe' : [...cleaned].slice(0, 60).join('')
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** slot -> recipe name, from `slots.txt` */
export function parseSlots(text: string): Slots {
  const slots: Slots = {}
  for (const line of text.split('\n')) {
    const equals = line.indexOf('=')
    if (equals < 0) continue
    const slot = line.slice(0, equals).trim()
    const name = line.slice(equals + 1).trim()
    if ((SLOT_NAMES as readonly string[]).includes(slot) && name !== '') slots[slot as SlotName] = name
  }
  return slots
}

export function formatSlots(slots: Slots): string {
  return SLOT_NAMES.map((slot) => `${slot} = ${slots[slot] ?? ''}`).join('\n') + '\n'
}

interface DeletedEntry {
  text: string
  deletedAt: number
}

const RECIPE = 'recipes/'
const DELETED = 'deleted/'
const SLOTS = 'slots.txt'
const CREATED = 'library-created'

export class RecipeLibrary {
  private store: Store
  private read: ReadSettings

  constructor(store: Store, read: ReadSettings) {
    this.store = store
    this.read = read
  }

  private stored(file: string, text: string): StoredRecipe {
    return { file, name: recipeSummary(text) ?? file.replace(/\.txt$/, ''), settings: this.read(text) }
  }

  /** All recipes, by name. The first time, the library is filled with the starter recipes. */
  async load(): Promise<StoredRecipe[]> {
    if (!(await this.store.get<boolean>(CREATED))) {
      const starters = INCLUDED.slice(0, SLOT_NAMES.length)
      for (const starter of starters) await this.save(starter.name, this.read(starter.text))
      const slots: Slots = {}
      SLOT_NAMES.forEach((slot, i) => {
        if (starters[i]) slots[slot] = starters[i].name
      })
      await this.saveSlots(slots)
      await this.store.set(CREATED, true)
    }
    const recipes: StoredRecipe[] = []
    for (const key of await this.store.keys(RECIPE)) {
      const text = await this.store.get<string>(key)
      if (typeof text === 'string') recipes.push(this.stored(key.slice(RECIPE.length), text))
    }
    return recipes.sort((a, b) => compareNames(a.name, b.name))
  }

  /** Writes the recipe, renaming its file when the name changed. */
  async save(name: string, settings: FilmSettings, replacing?: StoredRecipe): Promise<StoredRecipe> {
    const file = `${libraryFileName(name)}.txt`
    await this.store.set(RECIPE + file, recipeText(name, settings))
    if (replacing && replacing.file !== file) await this.store.delete(RECIPE + replacing.file)
    return { file, name, settings }
  }

  /** Moves the recipe to Recently Deleted; `deleted()` lists it until it's 30 days old. */
  async delete(recipe: StoredRecipe, now = Date.now()): Promise<void> {
    const text = await this.store.get<string>(RECIPE + recipe.file)
    const entry: DeletedEntry = { text: text ?? storedText(recipe), deletedAt: now }
    await this.store.set(DELETED + recipe.file, entry)
    await this.store.delete(RECIPE + recipe.file)
  }

  /** Recently deleted recipes, newest first. Ones deleted more than 30 days ago are removed. */
  async deleted(now = Date.now()): Promise<DeletedRecipe[]> {
    const list: DeletedRecipe[] = []
    for (const key of await this.store.keys(DELETED)) {
      const entry = await this.store.get<DeletedEntry>(key)
      if (!entry) continue
      if (now - entry.deletedAt > KEEP_DELETED_MS) {
        await this.store.delete(key)
        continue
      }
      const stored = this.stored(key.slice(DELETED.length), entry.text)
      list.push({ ...stored, deletedAt: entry.deletedAt })
    }
    return list.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** Back into the library, as `name` (the caller picks a free one). */
  async restore(recipe: DeletedRecipe, name: string): Promise<StoredRecipe> {
    const stored = await this.save(name, recipe.settings)
    await this.store.delete(DELETED + recipe.file)
    return stored
  }

  async removePermanently(recipe: DeletedRecipe): Promise<void> {
    await this.store.delete(DELETED + recipe.file)
  }

  async loadSlots(): Promise<Slots> {
    const text = await this.store.get<string>(SLOTS)
    return typeof text === 'string' ? parseSlots(text) : {}
  }

  async saveSlots(slots: Slots): Promise<void> {
    await this.store.set(SLOTS, formatSlots(slots))
  }
}
