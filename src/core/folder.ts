// A folder the app reads from and maybe writes to: the card, a folder of photos, an export
// folder. The browser gives us these in several ways (the File System Access API, a picked
// folder's file list, the dev server's card); they all look like this to the rest of the app.

export interface FolderEntry {
  name: string
  kind: 'file' | 'directory'
}

export interface Folder {
  readonly name: string
  /** false for a picked file list or a read-only dev card: writes go to downloads instead */
  readonly writable: boolean
  list(): Promise<FolderEntry[]>
  folder(name: string, create?: boolean): Promise<Folder | null>
  file(name: string): Promise<File | null>
  writeFile(name: string, data: Blob | string): Promise<void>
  remove(name: string): Promise<void>
}

export async function readText(folder: Folder, name: string): Promise<string | null> {
  const file = await folder.file(name)
  return file ? await file.text() : null
}

/** A folder in memory, for tests and for building a zip of what would have been written. */
export class MemoryFolder implements Folder {
  readonly writable = true
  readonly files = new Map<string, Blob>()
  readonly folders = new Map<string, MemoryFolder>()

  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  async list(): Promise<FolderEntry[]> {
    return [
      ...[...this.folders.keys()].map((name) => ({ name, kind: 'directory' as const })),
      ...[...this.files.keys()].map((name) => ({ name, kind: 'file' as const })),
    ]
  }

  async folder(name: string, create = false): Promise<Folder | null> {
    let found = this.folders.get(name)
    if (!found && create) {
      found = new MemoryFolder(name)
      this.folders.set(name, found)
    }
    return found ?? null
  }

  async file(name: string): Promise<File | null> {
    const blob = this.files.get(name)
    return blob ? new File([blob], name) : null
  }

  async writeFile(name: string, data: Blob | string): Promise<void> {
    this.files.set(name, typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : data)
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name)
  }

  /** every file, by its path inside this folder */
  allFiles(prefix = ''): [string, Blob][] {
    return [
      ...[...this.files].map(([name, blob]): [string, Blob] => [prefix + name, blob]),
      ...[...this.folders].flatMap(([name, folder]) => folder.allFiles(`${prefix}${name}/`)),
    ]
  }
}
