// The app's state and everything that changes it, shared by the four tabs. A port of the Mac
// app's AppModel: the library, the slots, the open folder of photos, the card, exports and the
// notice at the bottom of the window.

import { useSyncExternalStore } from 'react'
import type { LookSettings } from '../engine/types'
import { isCard, photoFolders, readCardSlots, writeCardSlots } from '../core/card'
import { mergedIncluded, RecipeCollection } from '../core/collection'
import { MemoryFolder, type Folder } from '../core/folder'
import {
  compareNames,
  formatSlots,
  INCLUDED,
  libraryFileName,
  RecipeLibrary,
  SLOT_NAMES,
  storedText,
  type DeletedRecipe,
  type IncludedRecipe,
  type SlotName,
  type Slots,
  type StoredRecipe,
} from '../core/library'
import { EXPORT_FORMATS, exportName, listPhotos, type ExportFormat, type Photo } from '../core/photos'
import { recipeSummary, sidecarLabel, sidecarRecipe, unsupportedSettings } from '../core/recipe'
import { filmSettingsFrom, neutralSettings, noiseReductionStep, sameSettings, type FilmSettings } from '../core/settings'
import { IndexedDBStore, type Store } from '../core/storage'
import { zip } from '../core/zip'
import type { Engines } from './engines'
import { devCard, download, FileListFolder, HandleFolder, pickFolder, readFileHandle, reopen } from './folders'
import { FULL_SIZE, Renderer, type PhotoRef } from './render'

export type Place = 'darkroom' | 'recipes' | 'studio' | 'camera'
export const PLACES: { id: Place; name: string }[] = [
  { id: 'darkroom', name: 'Darkroom' },
  { id: 'recipes', name: 'Recipes' },
  { id: 'studio', name: 'Studio' },
  { id: 'camera', name: 'Camera' },
]

/** Which look a photo is shown and exported with: what the camera showed (its sidecar), none,
 *  or one of your recipes by name. */
export type LookChoice = 'asShot' | 'original' | `recipe:${string}`

export interface AppPhoto extends Photo, PhotoRef {}

/** Changes made in the Studio and not saved yet. Kept here rather than only in the Studio, so
 *  leaving the page can warn and a reload picks them up again. */
export interface UnsavedEdit {
  recipe: StoredRecipe
  name: string
  settings: FilmSettings
}

/** The card or folder the Darkroom shows photos from. */
export interface Source {
  root: Folder
  isCard: boolean
  /** a card's DCIM/…HASBL folders */
  photoFolders: string[]
  /** the photo folder shown: one of `photoFolders`, or '' for the root itself */
  current: string
}

export interface State {
  loaded: boolean
  place: Place
  recipes: StoredRecipe[]
  /** the recipes that come with Hazel, as the collection last had them */
  included: IncludedRecipe[]
  deleted: DeletedRecipe[]
  slots: Slots
  /** set to open a recipe in the Studio; the Studio clears it once it has */
  editing: string | null
  unsaved: UnsavedEdit | null
  source: Source | null
  photos: AppPhoto[]
  photosLoading: boolean
  choices: Readonly<Record<string, LookChoice>>
  /** the photo the Recipes and Camera tabs show recipes on, by name in the open folder */
  sampleName: string | null
  /** a photo picked from elsewhere ("Other photo…") */
  otherSample: AppPhoto | null
  card: Folder | null
  /** the slots as the card has them now; null before a card is chosen */
  cardSlots: Partial<Record<SlotName, string>> | null
  exportFormat: ExportFormat
  exportFolder: Folder | null
  exporting: { done: number; total: number } | null
  notice: { id: number; text: string } | null
  /** remembered folders the browser wants a click before reopening */
  waiting: { source?: FileSystemDirectoryHandle; card?: FileSystemDirectoryHandle }
}

const initial: State = {
  loaded: false,
  place: 'darkroom',
  recipes: [],
  included: INCLUDED,
  deleted: [],
  slots: {},
  editing: null,
  unsaved: null,
  source: null,
  photos: [],
  photosLoading: false,
  choices: {},
  sampleName: null,
  otherSample: null,
  card: null,
  cardSlots: null,
  exportFormat: 'jpeg',
  exportFolder: null,
  exporting: null,
  notice: null,
  waiting: {},
}

interface Preferences {
  exportFormat?: ExportFormat
  sampleName?: string
  place?: Place
}

function otherPhoto(file: File): AppPhoto {
  return {
    key: `other/${file.name}/${file.lastModified}`,
    name: file.name,
    base: file.name.replace(/\.[^.]+$/, ''),
    sidecar: null,
    isRaw: /\.(3fr|fff|dng)$/i.test(file.name),
    file: async () => file,
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export class AppModel {
  state: State = initial
  private listeners = new Set<() => void>()
  readonly store: Store
  library!: RecipeLibrary
  collection: RecipeCollection
  renderer!: Renderer
  engines!: Engines
  private noticeId = 0

  constructor(store: Store = new IndexedDBStore()) {
    this.store = store
    this.collection = new RecipeCollection(store, new URLSearchParams(location.search).get('collection') ?? undefined)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  notify(text: string) {
    this.set({ notice: { id: ++this.noticeId, text } })
  }

  dismissNotice(id: number) {
    if (this.state.notice?.id === id) this.set({ notice: null })
  }

  private fail(what: string, error: unknown) {
    console.error(error)
    this.notify(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** The engine's settings for a recipe text, with its notes. */
  readSettings = (text: string): FilmSettings => filmSettingsFrom(this.engines.look.parse(text), text)

  lookOf(text: string | null): LookSettings | null {
    return text === null ? null : this.engines.look.parse(text)
  }

  private started = false

  async start(engines: Engines) {
    if (this.started) return
    this.started = true
    this.engines = engines
    this.renderer = new Renderer(engines)
    this.library = new RecipeLibrary(this.store, this.readSettings)
    const preferences = (await this.store.get<Preferences>('preferences')) ?? {}
    this.set({
      exportFormat: EXPORT_FORMATS.some((f) => f.id === preferences.exportFormat) ? (preferences.exportFormat as ExportFormat) : 'jpeg',
      sampleName: preferences.sampleName ?? null,
      place: preferences.place ?? 'darkroom',
    })
    await this.reloadRecipes()
    const unsaved = await this.store.get<UnsavedEdit>('unsaved')
    if (unsaved && this.state.recipes.some((r) => r.file === unsaved.recipe.file)) this.set({ unsaved })
    const cached = await this.collection.cached()
    this.set({ included: mergedIncluded(INCLUDED, cached), loaded: true })
    void this.refreshCollection()
    await this.restoreFolders()
  }

  private savePreferences() {
    const preferences: Preferences = {
      exportFormat: this.state.exportFormat,
      sampleName: this.state.sampleName ?? undefined,
      place: this.state.place,
    }
    void this.store.set('preferences', preferences)
  }

  setPlace(place: Place) {
    this.set({ place })
    this.savePreferences()
  }

  // MARK: recipes

  async reloadRecipes() {
    try {
      this.set({
        recipes: await this.library.load(),
        slots: await this.library.loadSlots(),
        deleted: await this.library.deleted(),
      })
    } catch (error) {
      this.fail("Couldn't read the recipes", error)
    }
  }

  /** Fetches the latest recipe collection. Offline, the copy from last time stays, without a
   *  message: nothing is wrong locally. */
  async refreshCollection() {
    try {
      const fetched = await this.collection.refresh()
      this.set({ included: mergedIncluded(INCLUDED, fetched.recipes) })
      if (fetched.skipped.length > 0) console.info('Hazel: recipes left out of the collection', fetched.skipped)
    } catch (error) {
      console.info('Hazel: the recipe collection could not be read; keeping the last copy', error)
    }
  }

  recipeNamed(name: string): StoredRecipe | undefined {
    return this.state.recipes.find((r) => r.name === name)
  }

  /** A name not taken yet: "Warm print 2". Names whose files would clash count as taken too
   *  ("B&W" and "B-W" are both B-W.txt; a Mac's disk doesn't tell "warm" from "Warm"), except
   *  the file of the recipe being renamed. */
  freeName(base: string, renaming?: StoredRecipe): string {
    const fileOf = (name: string) => `${libraryFileName(name)}.txt`.toLocaleLowerCase()
    const taken = (name: string) =>
      this.recipeNamed(name) !== undefined ||
      this.state.recipes.some((r) => r.file !== renaming?.file && r.file.toLocaleLowerCase() === fileOf(name))
    let name = base
    for (let n = 2; taken(name); n++) name = `${base} ${n}`
    return name
  }

  slotOf(name: string): SlotName | undefined {
    return SLOT_NAMES.find((slot) => this.state.slots[slot] === name)
  }

  edit(recipe: StoredRecipe) {
    this.set({ editing: recipe.file, place: 'studio' })
    this.savePreferences()
  }

  clearEditing() {
    this.set({ editing: null })
  }

  setUnsaved(unsaved: UnsavedEdit | null) {
    if (unsaved === this.state.unsaved) return
    this.set({ unsaved })
    void (unsaved ? this.store.set('unsaved', unsaved) : this.store.delete('unsaved'))
  }

  /** Saves the Studio's changes over their recipe; a new name that's taken gets a number. */
  async saveEdit(edit: UnsavedEdit): Promise<StoredRecipe | null> {
    const clean = edit.name.trim()
    const name = clean === '' || clean === edit.recipe.name ? edit.recipe.name : this.freeName(clean, edit.recipe)
    const stored = await this.save(name, edit.settings, edit.recipe)
    if (stored && this.state.unsaved === edit) this.setUnsaved(null)
    return stored
  }

  async save(name: string, settings: FilmSettings, replacing?: StoredRecipe): Promise<StoredRecipe | null> {
    try {
      const stored = await this.library.save(name, settings, replacing)
      let slots = this.state.slots
      if (replacing && replacing.name !== name) {
        slots = Object.fromEntries(Object.entries(slots).map(([slot, value]) => [slot, value === replacing.name ? name : value]))
        await this.library.saveSlots(slots)
      }
      const replaced = replacing?.file ?? stored.file
      const others = this.state.recipes.filter((r) => r.file !== replaced && r.file !== stored.file)
      this.set({ recipes: [...others, stored].sort((a, b) => compareNames(a.name, b.name)), slots })
      return stored
    } catch (error) {
      this.fail(`Couldn't save ${name}`, error)
      return null
    }
  }

  async newRecipe(): Promise<StoredRecipe | null> {
    return this.save(this.freeName('New recipe'), neutralSettings())
  }

  async duplicate(recipe: StoredRecipe): Promise<StoredRecipe | null> {
    return this.save(this.freeName(`${recipe.name} copy`), recipe.settings)
  }

  async rename(recipe: StoredRecipe, newName: string): Promise<StoredRecipe | null> {
    const clean = newName.trim()
    if (clean === '' || clean === recipe.name) return recipe
    const stored = await this.save(this.freeName(clean, recipe), recipe.settings, recipe)
    if (stored && this.state.unsaved?.recipe.file === recipe.file) {
      this.setUnsaved({ ...this.state.unsaved, recipe: stored, name: stored.name })
    }
    return stored
  }

  async delete(recipe: StoredRecipe) {
    try {
      await this.library.delete(recipe)
    } catch (error) {
      this.fail(`Couldn't delete ${recipe.name}`, error)
      return
    }
    const slots: Slots = { ...this.state.slots }
    for (const slot of SLOT_NAMES) if (slots[slot] === recipe.name) delete slots[slot]
    await this.library.saveSlots(slots)
    if (this.state.unsaved?.recipe.file === recipe.file) this.setUnsaved(null)
    this.set({
      recipes: this.state.recipes.filter((r) => r.file !== recipe.file),
      slots,
      deleted: await this.library.deleted(),
    })
    this.notify(`${recipe.name} is in Recently deleted, under Recipes`)
  }

  async restore(recipe: DeletedRecipe) {
    try {
      const stored = await this.library.restore(recipe, this.freeName(recipe.name))
      this.set({
        recipes: [...this.state.recipes, stored].sort((a, b) => compareNames(a.name, b.name)),
        deleted: await this.library.deleted(),
      })
      this.notify(`${stored.name} is back`)
    } catch (error) {
      this.fail(`Couldn't restore ${recipe.name}`, error)
    }
  }

  async removePermanently(recipe: DeletedRecipe) {
    await this.library.removePermanently(recipe)
    this.set({ deleted: await this.library.deleted() })
  }

  /** A copy of an included recipe in the library, to edit. */
  async add(included: IncludedRecipe): Promise<StoredRecipe | null> {
    return this.save(this.freeName(included.name), this.readSettings(included.text))
  }

  async setSlot(slot: SlotName, name: string | null) {
    const slots: Slots = { ...this.state.slots }
    if (name) slots[slot] = name
    else delete slots[slot]
    this.set({ slots })
    await this.library.saveSlots(slots)
  }

  /** Recipe files (the camera's `.txt` format) into the library, each under a free name. */
  async importRecipes(files: File[]) {
    const added: string[] = []
    const refused: string[] = []
    /** settings a newer Hazel wrote, which this one can't keep */
    const leftOut: string[] = []
    for (const file of files) {
      try {
        if (file.size > 64 << 10) throw new Error('too large for a recipe')
        const text = await file.text()
        if (file.name === 'slots.txt') continue
        const name = this.freeName(recipeSummary(text) ?? file.name.replace(/\.txt$/i, ''))
        const stored = await this.save(name, this.readSettings(text))
        if (!stored) continue
        added.push(stored.name)
        const unknown = unsupportedSettings(text, (line) => this.engines.look.recognises(line))
        if (unknown.length > 0) leftOut.push(`${stored.name} (${unknown.join(', ')})`)
      } catch {
        refused.push(file.name)
      }
    }
    // one notice, since a second one would replace the first
    const parts: string[] = []
    if (added.length > 0) parts.push(`Added ${added.length === 1 ? added[0] : plural(added.length, 'recipe')}`)
    if (leftOut.length > 0) parts.push(`Made for a newer Hazel, so these settings were left out: ${leftOut.join('; ')}`)
    if (refused.length > 0) parts.push(`Couldn't read ${refused.join(', ')}`)
    if (parts.length > 0) this.notify(parts.join('. '))
  }

  exportRecipe(recipe: StoredRecipe) {
    download(new Blob([storedText(recipe)], { type: 'text/plain' }), `${libraryFileName(recipe.name)}.txt`)
  }

  /** Every recipe and slots.txt, as the Mac app's Recipes folder, in one zip. */
  async exportLibrary() {
    const files: [string, string][] = this.state.recipes.map((r) => [`Recipes/${r.file}`, storedText(r)])
    files.push(['Recipes/slots.txt', formatSlots(this.state.slots)])
    download(await zip(files), 'Hazel recipes.zip')
  }

  // MARK: photos

  private async restoreFolders() {
    const source = await this.store.get<FileSystemDirectoryHandle>('handle:source')
    const card = await this.store.get<FileSystemDirectoryHandle>('handle:card')
    const exportHandle = await this.store.get<FileSystemDirectoryHandle>('handle:export')
    const waiting: State['waiting'] = {}
    if (source) {
      const folder = await reopen(source, 'readwrite', false).catch(() => null)
      if (folder) await this.openSource(folder, false)
      else waiting.source = source
    }
    if (card && card !== source) {
      const folder = await reopen(card, 'readwrite', false).catch(() => null)
      if (folder) await this.useCard(folder, false)
      else waiting.card = card
    }
    if (exportHandle) {
      const folder = await reopen(exportHandle, 'readwrite', false).catch(() => null)
      if (folder) this.set({ exportFolder: folder })
    }
    this.set({ waiting })
    await this.restoreSample()
    if (!this.state.source) {
      const dev = await devCard()
      if (dev) await this.openSource(dev, false)
    }
  }

  /** Asks the browser again for a remembered folder (it needs a click for that). */
  async reopenWaiting(which: 'source' | 'card') {
    const handle = this.state.waiting[which]
    if (!handle) return
    const folder = await reopen(handle, 'readwrite', true).catch(() => null)
    if (!folder) {
      this.notify(`${handle.name} isn't available. Put the card in, or choose it again.`)
      return
    }
    this.set({ waiting: { ...this.state.waiting, [which]: undefined } })
    if (which === 'source') await this.openSource(folder, true)
    else await this.useCard(folder, true)
  }

  async chooseFolder() {
    try {
      const folder = await pickFolder('hazel-photos', 'readwrite')
      if (folder) await this.openSource(folder, true)
    } catch (error) {
      this.fail("Couldn't open the folder", error)
    }
  }

  async openFileList(files: File[]) {
    const folder = FileListFolder.from(files)
    if (folder) await this.openSource(folder, false)
  }

  /** A card, or any folder of photos. A card shows its newest photo folder. */
  async openSource(root: Folder, remember: boolean) {
    try {
      const card = await isCard(root)
      const folders = card ? await photoFolders(root) : []
      this.set({ source: { root, isCard: card, photoFolders: folders, current: folders[folders.length - 1] ?? '' } })
      if (remember && root instanceof HandleFolder) await this.store.set('handle:source', root.handle)
      if (card) await this.useCard(root, remember)
      await this.loadPhotos()
    } catch (error) {
      this.fail(`Couldn't open ${root.name}`, error)
    }
  }

  async showPhotoFolder(name: string) {
    if (!this.state.source) return
    this.set({ source: { ...this.state.source, current: name } })
    await this.loadPhotos()
  }

  private async loadPhotos() {
    const source = this.state.source
    if (!source) return
    this.set({ photosLoading: true, choices: {} })
    try {
      const folder = source.current === '' ? source.root : await (await source.root.folder('DCIM'))?.folder(source.current)
      if (!folder) throw new Error(`${source.current} is gone`)
      const prefix = `${source.root.name}/${source.current}/`
      const photos = (await listPhotos(folder)).map((p): AppPhoto => ({ ...p, key: prefix + p.name }))
      this.set({ photos, photosLoading: false })
    } catch (error) {
      this.set({ photos: [], photosLoading: false })
      this.fail(`Couldn't open ${source.current || source.root.name}`, error)
    }
  }

  folderTitle(): string {
    const source = this.state.source
    if (!source) return 'Darkroom'
    return source.current === '' ? source.root.name : `${source.root.name} · ${source.current}`
  }

  /** A recipe picked for the photo that has since been renamed or deleted falls back to as shot,
   *  so the picker and the picture agree. */
  choice(photo: AppPhoto): LookChoice {
    const choice = this.state.choices[photo.key] ?? 'asShot'
    return choice.startsWith('recipe:') && !this.recipeNamed(choice.slice('recipe:'.length)) ? 'asShot' : choice
  }

  setChoice(photo: AppPhoto, choice: LookChoice) {
    this.set({ choices: { ...this.state.choices, [photo.key]: choice } })
  }

  /** the recipe text a choice stands for; null shows the photo as developed, with no look */
  recipeFor(photo: AppPhoto, choice: LookChoice = this.choice(photo)): string | null {
    if (choice === 'asShot') return photo.sidecar ? sidecarRecipe(photo.sidecar) : null
    if (choice === 'original') return null
    const stored = this.recipeNamed(choice.slice('recipe:'.length))
    return stored ? storedText(stored) : null
  }

  label(choice: LookChoice, photo: AppPhoto): string {
    if (choice === 'asShot') {
      if (!photo.sidecar) return 'As shot · no look'
      return `As shot · ${recipeSummary(photo.sidecar.text) ?? sidecarLabel(photo.sidecar)}`
    }
    if (choice === 'original') return 'Original'
    return choice.slice('recipe:'.length)
  }

  /** For edge print: "gritty black and white: strong clarity, …" becomes "gritty black and white" */
  shortLabel(photo: AppPhoto): string {
    const choice = this.choice(photo)
    if (choice === 'asShot') {
      const sidecar = photo.sidecar
      if (!sidecar) return 'no look'
      const summary = recipeSummary(sidecar.text)
      if (sidecar.look !== 'recipe' || summary === undefined) return sidecarLabel(sidecar)
      return summary.split(':')[0]
    }
    if (choice === 'original') return 'original'
    return choice.slice('recipe:'.length)
  }

  /** The photo's own recipe, when it was taken with one you don't have yet. */
  keepableLook(photo: AppPhoto): FilmSettings | null {
    const sidecar = photo.sidecar
    if (!sidecar || sidecar.look !== 'recipe' || this.choice(photo) !== 'asShot') return null
    const settings = this.readSettings(sidecar.text)
    return this.state.recipes.some((r) => sameSettings(r.settings, settings)) ? null : settings
  }

  async keepLook(photo: AppPhoto) {
    const settings = this.keepableLook(photo)
    if (!settings || !photo.sidecar) return
    const summary = recipeSummary(photo.sidecar.text)
    const stored = await this.save(this.freeName(summary ? summary.slice(0, 40) : `From ${photo.name}`), settings)
    if (stored) this.notify(`${stored.name} is in your recipes`)
  }

  // MARK: sample photo

  /** The photo the Recipes and Camera tabs show every recipe on: the one picked, or the first open. */
  sample(): AppPhoto | null {
    const { otherSample, sampleName, photos } = this.state
    if (sampleName === null && otherSample) return otherSample
    return photos.find((p) => p.name === sampleName) ?? otherSample ?? photos[0] ?? null
  }

  useSample(photo: AppPhoto) {
    this.set({ sampleName: photo.name })
    this.savePreferences()
  }

  /** back to the photo picked from elsewhere */
  useOther() {
    this.set({ sampleName: null })
    this.savePreferences()
  }

  /** A photo from elsewhere. With a file handle it's found again next visit, as the Mac app
   *  remembers its path. */
  async useOtherSample(file: File, handle?: FileSystemFileHandle) {
    this.set({ otherSample: otherPhoto(file), sampleName: null })
    this.savePreferences()
    await (handle ? this.store.set('handle:sample', handle) : this.store.delete('handle:sample'))
  }

  private async restoreSample() {
    const handle = await this.store.get<FileSystemFileHandle>('handle:sample')
    if (!handle) return
    const file = await readFileHandle(handle).catch(() => null)
    if (file) this.set({ otherSample: otherPhoto(file) })
  }

  // MARK: exports

  setExportFormat(format: ExportFormat) {
    this.set({ exportFormat: format })
    this.savePreferences()
  }

  async chooseExportFolder(): Promise<Folder | null> {
    const folder = await pickFolder('hazel-exports', 'readwrite').catch(() => null)
    if (folder) {
      this.set({ exportFolder: folder })
      await this.store.set('handle:export', folder.handle)
    }
    return folder
  }

  /** Develops each photo at full size with its look and saves it as `<name>-film.<ext>`: to the
   *  export folder where the browser can write one, as downloads elsewhere. */
  async export(photos: AppPhoto[]) {
    if (this.state.exporting || photos.length === 0) return
    let folder = this.state.exportFolder
    if (!folder && 'showDirectoryPicker' in window) folder = await this.chooseExportFolder()
    const format = this.state.exportFormat
    const jobs = photos.map((photo) => ({ photo, recipe: this.recipeFor(photo) }))
    const failures: string[] = []
    this.set({ exporting: { done: 0, total: jobs.length } })
    for (const [index, job] of jobs.entries()) {
      try {
        const look = this.lookOf(job.recipe)
        const noise = job.recipe ? noiseReductionStep(this.readSettings(job.recipe)) : 0
        const developed = await this.renderer.developed(job.photo, FULL_SIZE, noise)
        const image = await this.renderer.look(developed, look)
        const info = await this.renderer.info(job.photo).catch(() => undefined)
        const blob = await this.engines.encode(image, format, info)
        const name = exportName(job.photo.name, format)
        if (folder) await folder.writeFile(name, blob)
        else download(blob, name)
      } catch (error) {
        console.error(error)
        failures.push(job.photo.name)
      }
      this.set({ exporting: { done: index + 1, total: jobs.length } })
    }
    this.set({ exporting: null })
    const where = folder ? ` to ${folder.name}` : ''
    this.notify(failures.length === 0 ? `Exported ${plural(jobs.length, 'photo')}${where}` : `Couldn't export ${failures.join(', ')}`)
  }

  // MARK: card

  async chooseCard() {
    try {
      const folder = await pickFolder('hazel-card', 'readwrite')
      if (folder) await this.useCard(folder, true)
    } catch (error) {
      this.fail("Couldn't open the card", error)
    }
  }

  async useCard(card: Folder, remember: boolean) {
    this.set({ card })
    if (remember && card instanceof HandleFolder) await this.store.set('handle:card', card.handle)
    await this.refreshCardSlots()
  }

  async refreshCardSlots() {
    const card = this.state.card
    if (!card) return
    try {
      this.set({ cardSlots: await readCardSlots(card) })
    } catch {
      this.set({ cardSlots: {} })
    }
  }

  /** What each slot should hold on the card: the recipe text the camera reads. */
  wantedSlots(): Partial<Record<SlotName, string>> {
    const wanted: Partial<Record<SlotName, string>> = {}
    for (const slot of SLOT_NAMES) {
      const name = this.state.slots[slot]
      const stored = name ? this.recipeNamed(name) : undefined
      if (stored) wanted[slot] = storedText(stored)
    }
    return wanted
  }

  /** Writes `HAZEL/recipes/C1.txt`..`C7.txt` to the card, or where the browser can't write to
   *  it, downloads the HAZEL folder as a zip to put at the card's top level. */
  async writeSlotsToCard() {
    const wanted = this.wantedSlots()
    const count = Object.keys(wanted).length
    const card = this.state.card
    try {
      if (card?.writable) {
        await writeCardSlots(card, wanted)
        await this.refreshCardSlots()
        this.notify(`Wrote ${plural(count, 'recipe')} to ${card.name}`)
      } else {
        const folder = new MemoryFolder('card')
        await writeCardSlots(folder, wanted)
        download(await zip(folder.allFiles()), 'HAZEL.zip')
        this.notify('Unzip HAZEL.zip at the top of the card, replacing any HAZEL folder there')
      }
    } catch (error) {
      this.fail(`Couldn't write to ${card?.name ?? 'the card'}`, error)
    }
  }
}

export const model = new AppModel()

export function useModel(): State {
  return useSyncExternalStore(model.subscribe, () => model.state)
}
