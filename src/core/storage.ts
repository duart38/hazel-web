// Where the app keeps things between visits: a small key-value store. IndexedDB in the browser
// (it can hold Blobs and directory handles too), memory in tests.

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** every key starting with `prefix` */
  keys(prefix: string): Promise<string[]>
}

export class MemoryStore implements Store {
  private items = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.items.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this.items.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key)
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.items.keys()].filter((k) => k.startsWith(prefix))
  }
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

export class IndexedDBStore implements Store {
  private db: Promise<IDBDatabase>
  private storeName: string

  constructor(name = 'hazel', storeName = 'kv') {
    this.storeName = storeName
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName)
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error("Couldn't open IndexedDB"))
    })
  }

  private async objectStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db).transaction(this.storeName, mode).objectStore(this.storeName)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await request((await this.objectStore('readonly')).get(key))) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    await request((await this.objectStore('readwrite')).put(value, key))
  }

  async delete(key: string): Promise<void> {
    await request((await this.objectStore('readwrite')).delete(key))
  }

  async keys(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(prefix, prefix + '￿')
    const keys = await request((await this.objectStore('readonly')).getAllKeys(range))
    return keys.filter((k): k is string => typeof k === 'string')
  }
}
