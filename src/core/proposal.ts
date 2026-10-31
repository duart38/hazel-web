// Offering one of your recipes to Hazel's recipe collection. The app opens GitHub's page for
// adding a file to the collection with the recipe filled in; GitHub signs you in, makes your own
// copy of the collection and turns the file into a pull request, so the app needs no GitHub
// account or key. The rules are the ones the collection checks every pull request with
// (tools/build_index.py there): keep them the same.

import { recipeSummary, STORED_ROOM, storedSize } from './recipe'
import { recipeText, type FilmSettings } from './settings'

export const REPOSITORY = 'https://github.com/duart38/Hazel-film-recipes'

/** Film stock names are fine in a name; company names are trademarks. */
const COMPANY_NAMES = /\b(kodak|fuji|fujifilm|hasselblad|ilford|agfa|polaroid|leica)\b/i

/** "Gold 200" is gold-200.txt, the file name the collection expects for it. */
export function proposalFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return slug.replace(/^-+|-+$/g, '') + '.txt'
}

/** The recipe as the collection keeps it: its name, a one-line description, then the rest of
 *  its notes. The description takes the place of the first note. */
export function proposalRecipe(name: string, settings: FilmSettings, description: string): string {
  const line = description.trim()
  const notes = settings.notes.length === 0 ? [line] : [line, ...settings.notes.slice(1)]
  return recipeText(name.trim(), { ...settings, notes })
}

/** Why the collection would turn the recipe down, as you'd fix it; empty when it wouldn't.
 *  `taken` is the names already in the collection. */
export function proposalProblems(text: string, taken: string[]): string[] {
  const name = recipeSummary(text) ?? ''
  const problems: string[] = []
  if (proposalFileName(name) === '.txt') problems.push('Give the recipe a name with letters or numbers in it.')
  if (COMPANY_NAMES.test(name)) {
    problems.push('Leave the company name out of the recipe\'s name. Say "Inspired by …" in the description instead.')
  }
  const lines = text.split('\n')
  if (lines.length < 2 || !lines[1].startsWith('#') || lines[1].slice(1).trim() === '') {
    problems.push('Add a description: one line on what the look is.')
  }
  const size = storedSize(text)
  if (size > STORED_ROOM) {
    problems.push(
      `The recipe is ${size} bytes and the camera keeps ${STORED_ROOM} with each photo. Shorten the name or drop a setting.`,
    )
  }
  if (taken.some((t) => proposalFileName(t) === proposalFileName(name))) {
    problems.push(`The collection already has a recipe called ${name}. Give yours another name.`)
  }
  return problems
}

// Foundation's urlQueryAllowed less `+&=#`, which a query would read as a space or a new parameter
const ALLOWED = /[A-Za-z0-9!$'()*,\-./:;?@_~]/

function encoded(value: string): string {
  let out = ''
  for (const char of value) {
    if (ALLOWED.test(char)) {
      out += char
      continue
    }
    for (const byte of new TextEncoder().encode(char)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** GitHub's page for adding the recipe to the collection's recipes folder, filled in. */
export function proposalUrl(text: string): string {
  const file = proposalFileName(recipeSummary(text) ?? '')
  return `${REPOSITORY}/new/main/recipes?filename=${encoded(file)}&value=${encoded(text)}`
}
