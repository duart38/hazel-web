// The browser's ways to a folder, all as core's Folder: the File System Access API (Chrome and
// Edge: read and write), a folder picked with <input webkitdirectory> (read only, everywhere),
// and in `vite dev` the card the dev server was started with (HAZEL_DEV_CARD).

import type { Folder, FolderEntry } from '../core/folder'

// The File System Access API's parts that TypeScript's DOM library leaves out.
interface PermissionDescriptor {
  mode: 'read' | 'readwrite'
}
interface HandlePermissions {
  queryPermission(descriptor: PermissionDescriptor): Promise<PermissionState>
  requestPermission(descriptor: PermissionDescriptor): Promise<PermissionState>
}
interface IterableDirectory {
  values(): AsyncIterable<FileSystemHandle>
}
interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
}
type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>

function directoryPicker(): DirectoryPicker | null {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

export const canPickFolders = (): boolean => directoryPicker() !== null

interface FilePickerOptions {
  id?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}
type FilePicker = (options?: FilePickerOptions) => Promise<FileSystemFileHandle[]>

function filePicker(): FilePicker | null {
  const picker = (window as unknown as { showOpenFilePicker?: FilePicker }).showOpenFilePicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

/** One photo, as a handle that can be kept and read again next visit. Undefined where the
 *  browser has no file handles (pick with `pickFiles` then); null when cancelled. */
export async function pickPhotoHandle(): Promise<FileSystemFileHandle | null | undefined> {
  const picker = filePicker()
  if (!picker) return undefined
  try {
    const [handle] = await picker({
      id: 'hazel-sample',
      types: [{ description: 'Photos', accept: { 'image/*': ['.3fr', '.fff', '.dng', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic'] } }],
    })
    return handle ?? null
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/** A remembered file, when the browser still lets us read it without asking. */
export async function readFileHandle(handle: FileSystemFileHandle): Promise<File | null> {
  const permissions = handle as unknown as Partial<HandlePermissions>
  if (typeof permissions.queryPermission === 'function' && (await permissions.queryPermission({ mode: 'read' })) !== 'granted') return null
  return await handle.getFile()
}

export class HandleFolder implements Folder {
  readonly handle: FileSystemDirectoryHandle
  readonly writable: boolean

  constructor(handle: FileSystemDirectoryHandle, writable: boolean) {
    this.handle = handle
    this.writable = writable
  }

  get name() {
    return this.handle.name
  }

  async list(): Promise<FolderEntry[]> {
    const entries: FolderEntry[] = []
    for await (const handle of (this.handle as unknown as IterableDirectory).values()) {
      entries.push({ name: handle.name, kind: handle.kind })
    }
    return entries
  }

  async folder(name: string, create = false): Promise<Folder | null> {
    try {
      return new HandleFolder(await this.handle.getDirectoryHandle(name, { create: create && this.writable }), this.writable)
    } catch {
      return null
    }
  }

  async file(name: string): Promise<File | null> {
    try {
      return await (await this.handle.getFileHandle(name)).getFile()
    } catch {
      return null
    }
  }

  async writeFile(name: string, data: Blob | string): Promise<void> {
    const file = await this.handle.getFileHandle(name, { create: true })
    const stream = await file.createWritable()
    await stream.write(data)
    await stream.close()
  }

  async remove(name: string): Promise<void> {
    await this.handle.removeEntry(name)
  }
}

export async function pickFolder(id: string, mode: 'read' | 'readwrite'): Promise<HandleFolder | null> {
  const picker = directoryPicker()
  if (!picker) return null
  try {
    return new HandleFolder(await picker({ id, mode }), mode === 'readwrite')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/** A remembered folder again, after asking for permission if the browser wants that (it needs a click). */
export async function reopen(handle: FileSystemDirectoryHandle, mode: 'read' | 'readwrite', ask: boolean): Promise<HandleFolder | null> {
  const permissions = handle as unknown as HandlePermissions
  if (typeof permissions.queryPermission !== 'function') return new HandleFolder(handle, mode === 'readwrite')
  let state = await permissions.queryPermission({ mode })
  if (state !== 'granted' && ask) state = await permissions.requestPermission({ mode })
  return state === 'granted' ? new HandleFolder(handle, mode === 'readwrite') : null
}

/** A folder picked with <input webkitdirectory>: its files, read only. */
export class FileListFolder implements Folder {
  readonly writable = false
  private files = new Map<string, File>()
  private folders = new Map<string, FileListFolder>()

  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  static from(list: FileList | File[]): FileListFolder | null {
    const files = [...list]
    if (files.length === 0) return null
    const rootName = files[0].webkitRelativePath.split('/')[0] || 'Photos'
    const root = new FileListFolder(rootName)
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).split('/')
      if (parts.length > 1) parts.shift()
      let folder: FileListFolder = root
      for (const part of parts.slice(0, -1)) {
        let next = folder.folders.get(part)
        if (!next) {
          next = new FileListFolder(part)
          folder.folders.set(part, next)
        }
        folder = next
      }
      folder.files.set(parts[parts.length - 1], file)
    }
    return root
  }

  async list(): Promise<FolderEntry[]> {
    return [
      ...[...this.folders.keys()].map((name) => ({ name, kind: 'directory' as const })),
      ...[...this.files.keys()].map((name) => ({ name, kind: 'file' as const })),
    ]
  }

  async folder(name: string): Promise<Folder | null> {
    return this.folders.get(name) ?? null
  }

  async file(name: string): Promise<File | null> {
    return this.files.get(name) ?? null
  }

  async writeFile(): Promise<void> {
    throw new Error('a picked folder is read only')
  }

  async remove(): Promise<void> {
    throw new Error('a picked folder is read only')
  }
}

/** The dev server's card (vite.config.ts serves it under /__hazel/card). */
export class DevFolder implements Folder {
  readonly name: string
  private path: string
  readonly writable: boolean

  constructor(name: string, path: string, writable: boolean) {
    this.name = name
    this.path = path
    this.writable = writable
  }

  private url(kind: 'list' | 'file', name = '') {
    const path = [this.path, name].filter((p) => p !== '').join('/')
    return `/__hazel/card/${kind}?path=${encodeURIComponent(path)}`
  }

  async list(): Promise<FolderEntry[]> {
    const response = await fetch(this.url('list'))
    if (!response.ok) return []
    return (await response.json()) as FolderEntry[]
  }

  async folder(name: string, create = false): Promise<Folder | null> {
    const exists = (await this.list()).some((e) => e.kind === 'directory' && e.name === name)
    if (!exists) {
      if (!create || !this.writable) return null
      const response = await fetch(this.url('list', name), { method: 'PUT' })
      if (!response.ok) return null
    }
    return new DevFolder(name, [this.path, name].filter((p) => p !== '').join('/'), this.writable)
  }

  async file(name: string): Promise<File | null> {
    const response = await fetch(this.url('file', name))
    if (!response.ok) return null
    return new File([await response.blob()], name, { lastModified: Number(response.headers.get('x-modified')) || Date.now() })
  }

  async writeFile(name: string, data: Blob | string): Promise<void> {
    const response = await fetch(this.url('file', name), { method: 'PUT', body: data })
    if (!response.ok) throw new Error(`the dev card refused ${name}`)
  }

  async remove(name: string): Promise<void> {
    const response = await fetch(this.url('file', name), { method: 'DELETE' })
    if (!response.ok) throw new Error(`the dev card refused to remove ${name}`)
  }
}

export async function devCard(): Promise<DevFolder | null> {
  if (!import.meta.env.DEV) return null
  try {
    const response = await fetch('/__hazel/card/info')
    if (!response.ok) return null
    const info = (await response.json()) as { name: string; writable: boolean }
    return new DevFolder(info.name, '', info.writable)
  } catch {
    return null
  }
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Opens the browser's file picker; resolves with the files, or an empty list when cancelled. */
export function pickFiles(options: { accept?: string; multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (options.accept) input.accept = options.accept
    input.multiple = options.multiple ?? false
    if (options.directory) input.webkitdirectory = true
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}
