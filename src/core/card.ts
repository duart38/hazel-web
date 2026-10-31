// An X1D memory card. Our files live in one folder at its top, `HAZEL`, next to the camera's own
// `DCIM`: formatting the card in the camera removes them, and that is on purpose (README,
// "Starting from the card").

import type { LookEngine } from '../engine/types'
import { sameRecipe } from '../look/recipe'
import { readText, type Folder } from './folder'
import { SLOT_NAMES, type SlotName } from './library'
import { recipeSummary } from './recipe'

export const CARD_FOLDER = 'HAZEL'

export const CARD_README = `Hazel: film looks for the Hasselblad X1D (a personal project, not made by or
affiliated with Hasselblad).
recipes/C1.txt ... C7.txt are the recipes the camera's Hazel settings page offers.
Written by the Hazel app. Delete this folder, or format the card in the camera,
to remove everything; the camera itself is not changed by these files.
`

/** Where the camera writes photos: DCIM/100HASBL, 101HASBL, ... */
export async function photoFolders(card: Folder): Promise<string[]> {
  const dcim = await card.folder('DCIM')
  if (!dcim) return []
  return (await dcim.list())
    .filter((e) => e.kind === 'directory' && e.name.toUpperCase().endsWith('HASBL'))
    .map((e) => e.name)
    .sort()
}

/** Is this folder a card: a Hasselblad photo folder, or our own folder? */
export async function isCard(folder: Folder): Promise<boolean> {
  if ((await photoFolders(folder)).length > 0) return true
  return (await folder.list()).some((e) => e.kind === 'directory' && e.name === CARD_FOLDER)
}

async function recipesFolder(card: Folder, create: boolean): Promise<Folder | null> {
  const hazel = await card.folder(CARD_FOLDER, create)
  return hazel ? await hazel.folder('recipes', create) : null
}

/** The camera's slots as they are on the card now: slot -> recipe text. */
export async function readCardSlots(card: Folder): Promise<Partial<Record<SlotName, string>>> {
  const folder = await recipesFolder(card, false)
  const slots: Partial<Record<SlotName, string>> = {}
  if (!folder) return slots
  for (const slot of SLOT_NAMES) {
    const text = await readText(folder, `${slot}.txt`)
    if (text !== null) slots[slot] = text
  }
  return slots
}

/** The card's slot file holds the recipe the app would write there: the same name and the same
 *  look as the camera builds it, however the text is laid out or described (older versions wrote
 *  numbers and lines differently, and left out the description). */
export function sameSlotRecipe(look: Pick<LookEngine, 'parse'>, wanted: string, onCard: string): boolean {
  if (wanted === onCard) return true
  return recipeSummary(wanted) === recipeSummary(onCard) && sameRecipe(look.parse(wanted), look.parse(onCard))
}

/** Writes one slot's recipe to the card, or removes it when `text` is undefined. */
export async function writeCardSlot(card: Folder, slot: SlotName, text: string | undefined): Promise<void> {
  const folder = await recipesFolder(card, true)
  const hazel = await card.folder(CARD_FOLDER, true)
  if (!folder || !hazel) throw new Error(`couldn't make ${CARD_FOLDER}/recipes on the card`)
  const name = `${slot}.txt`
  if (text !== undefined) await folder.writeFile(name, text)
  else if ((await folder.list()).some((e) => e.name === name)) await folder.remove(name)
  await hazel.writeFile('README.txt', CARD_README)
}

/** Writes the slots: `HAZEL/recipes/C1.txt` … `C7.txt` and `HAZEL/README.txt`. A slot left
 *  empty is removed. The camera reads up to 2 KB of recipe and copies it into each photo's 1 KB
 *  sidecar; app recipes are a few hundred bytes. */
export async function writeCardSlots(card: Folder, slots: Partial<Record<SlotName, string>>): Promise<void> {
  const folder = await recipesFolder(card, true)
  const hazel = await card.folder(CARD_FOLDER, true)
  if (!folder || !hazel) throw new Error(`couldn't make ${CARD_FOLDER}/recipes on the card`)
  const present = new Set((await folder.list()).map((e) => e.name))
  for (const slot of SLOT_NAMES) {
    const name = `${slot}.txt`
    const text = slots[slot]
    if (text !== undefined) await folder.writeFile(name, text)
    else if (present.has(name)) await folder.remove(name)
  }
  await hazel.writeFile('README.txt', CARD_README)
}
