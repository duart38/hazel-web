// Raw photos stay out of the repository: tests read them from an X1D card's photo folder
// (HAZEL_TEST_CARD, or the card as a Mac mounts it) and skip when it isn't there.
// The web project doesn't type Node's modules, so the two functions used are typed here.

interface NodeFs {
  readFileSync(path: string): Uint8Array<ArrayBuffer>
  existsSync(path: string): boolean
}

declare const process: { env: Record<string, string | undefined> }

export const CARD = process.env.HAZEL_TEST_CARD ?? '/Volumes/Untitled/DCIM/100HASBL'

export async function cardFile(name: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const specifier = 'node:fs'
  const fs = (await import(/* @vite-ignore */ specifier)) as NodeFs
  const path = `${CARD}/${name}`
  return fs.existsSync(path) ? fs.readFileSync(path) : null
}
