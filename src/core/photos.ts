// The photos in a folder, each with the sidecar the camera wrote next to it (`B0000002.3FR` gets
// `B0000002.look`), if there is one.

import { readText, type Folder } from './folder'
import { parseSidecar, type Sidecar } from './recipe'

export const RAW_EXTENSIONS = ['3fr', 'fff', 'dng']
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'tif', 'tiff', 'png', 'heic']
/** Exports are named `<name>-film.<ext>`; they're left out of the list, so developing twice
 *  never develops an export. */
export const EXPORT_SUFFIX = '-film'

export interface Photo {
  /** unique in the folder */
  name: string
  /** the name without its extension: B0000002 */
  base: string
  sidecar: Sidecar | null
  isRaw: boolean
  file(): Promise<File>
}

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? { base: name, ext: '' } : { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() }
}

export function isPhotoName(name: string): boolean {
  // macOS leaves `._` copies of every file on a FAT card
  if (name.startsWith('.')) return false
  const { base, ext } = splitName(name)
  return (RAW_EXTENSIONS.includes(ext) || IMAGE_EXTENSIONS.includes(ext)) && !base.endsWith(EXPORT_SUFFIX)
}

/** Every photo in `folder` (not its subfolders), sorted by name. */
export async function listPhotos(folder: Folder): Promise<Photo[]> {
  const entries = await folder.list()
  const names = new Set(entries.filter((e) => e.kind === 'file').map((e) => e.name))
  const photos = [...names].filter(isPhotoName).sort()
  return Promise.all(
    photos.map(async (name): Promise<Photo> => {
      const { base, ext } = splitName(name)
      const sidecarName = [`${base}.look`, `${base}.LOOK`].find((n) => names.has(n))
      const text = sidecarName ? await readText(folder, sidecarName) : null
      return {
        name,
        base,
        sidecar: text === null ? null : parseSidecar(text),
        isRaw: RAW_EXTENSIONS.includes(ext),
        file: async () => {
          const file = await folder.file(name)
          if (!file) throw new Error(`${name} is gone from ${folder.name}`)
          return file
        },
      }
    }),
  )
}

export type ExportFormat = 'jpeg' | 'png' | 'tiff'

export const EXPORT_FORMATS: { id: ExportFormat; name: string; extension: string; mime: string }[] = [
  { id: 'jpeg', name: 'JPEG', extension: 'jpg', mime: 'image/jpeg' },
  { id: 'png', name: 'PNG (16-bit)', extension: 'png', mime: 'image/png' },
  { id: 'tiff', name: 'TIFF (16-bit)', extension: 'tiff', mime: 'image/tiff' },
]

export function exportName(photoName: string, format: ExportFormat): string {
  const extension = EXPORT_FORMATS.find((f) => f.id === format)?.extension ?? 'jpg'
  return `${splitName(photoName).base}${EXPORT_SUFFIX}.${extension}`
}
