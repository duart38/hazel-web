// Hazel's recipe collection (github.com/duart38/Hazel-film-recipes): the recipes that come with
// the app, kept up to date without a new app. `index.json` there lists them; each is a recipe
// file like any other. The last good copy is kept, so the Recipes tab works offline, and the
// snapshot built into the app stands in before the first fetch.

import type { IncludedRecipe } from './library'
import { recipeSummary, STORED_ROOM, storedSize } from './recipe'
import type { Store } from './storage'

export const DEFAULT_COLLECTION = 'https://raw.githubusercontent.com/duart38/Hazel-film-recipes/main/'

export interface Fetched {
  recipes: IncludedRecipe[]
  /** recipes listed but left out, with why ("Gold 200: not the file the index describes") */
  skipped: string[]
}

class Problem extends Error {}

interface IndexEntry {
  name: string
  file: string
  sha256: string
}

function isEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string' && typeof entry.file === 'string' && typeof entry.sha256 === 'string'
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** only files inside the collection: "recipes/gold-200.txt", never "../" or another site */
export function isCollectionFile(file: string): boolean {
  return (
    file.startsWith('recipes/') &&
    file.endsWith('.txt') &&
    !file.includes('..') &&
    !file.includes('//') &&
    !file.includes('\\')
  )
}

/** Checks one fetched recipe file against its index entry; throws a Problem saying why it's left out. */
export async function verifyRecipe(entry: IndexEntry, data: Uint8Array): Promise<IncludedRecipe> {
  if ((await sha256Hex(data)) !== entry.sha256.toLowerCase()) throw new Problem('not the file the index describes')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Problem('not text')
  }
  if (recipeSummary(text) !== entry.name) throw new Problem('the file has another name in it')
  if (storedSize(text) > STORED_ROOM) throw new Problem('too long for the camera')
  return { name: entry.name, text }
}

const CACHE_KEY = 'recipe-collection.json'

export class RecipeCollection {
  readonly source: string
  private store: Store
  private fetcher: typeof fetch

  constructor(store: Store, source = DEFAULT_COLLECTION, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.store = store
    this.fetcher = fetcher
    this.source = source.endsWith('/') ? source : `${source}/`
  }

  /** What the last refresh fetched; empty before the first one. */
  async cached(): Promise<IncludedRecipe[]> {
    const saved = await this.store.get<IncludedRecipe[]>(CACHE_KEY)
    return Array.isArray(saved) ? saved.filter((r) => typeof r?.name === 'string' && typeof r?.text === 'string') : []
  }

  /** Fetches the index and every recipe in it, and keeps them for `cached()`. Throws when the
   *  index can't be had; a recipe that can't be fetched or fails a check is skipped instead. */
  async refresh(): Promise<Fetched> {
    const indexBytes = await this.fetch('index.json', 1 << 20)
    const index: unknown = JSON.parse(new TextDecoder().decode(indexBytes))
    const entries = (index as { recipes?: unknown })?.recipes
    if (!Array.isArray(entries)) throw new Error('the index lists no recipes')
    const before = await this.cached()
    const recipes: IncludedRecipe[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      if (!isEntry(entry)) continue
      try {
        if (!isCollectionFile(entry.file)) throw new Problem("its file isn't in the collection")
        recipes.push(await verifyRecipe(entry, await this.fetch(entry.file, 16 << 10)))
      } catch (error) {
        // a recipe that couldn't be fetched this time keeps the copy from last time
        const kept = before.find((r) => r.name === entry.name)
        if (kept) recipes.push(kept)
        skipped.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.store.set(CACHE_KEY, recipes)
    return { recipes, skipped }
  }

  private async fetch(path: string, limit: number): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      // the files change in place: always ask for the current one
      const response = await this.fetcher(this.source + path, { cache: 'no-store', signal: controller.signal })
      if (response.status !== 200) {
        throw new Problem(
          response.status === 404 ? "not found (a private collection can't be read)" : `the server answered ${response.status}`,
        )
      }
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.length > limit) throw new Problem('larger than a recipe can be')
      return data
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The included recipes as the Recipes tab shows them: the collection's version of each, the
 *  built-in ones it doesn't have, then the ones only it has. */
export function mergedIncluded(builtIn: IncludedRecipe[], collection: IncludedRecipe[]): IncludedRecipe[] {
  const byName = new Map<string, IncludedRecipe>()
  for (const r of collection) if (!byName.has(r.name)) byName.set(r.name, r)
  const names = new Set(builtIn.map((r) => r.name))
  return [...builtIn.map((r) => byName.get(r.name) ?? r), ...collection.filter((r) => !names.has(r.name))]
}
