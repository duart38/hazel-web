import type { DevelopedImage } from '../engine/types'
import type { DevelopRequest, Timings, WorkerRequest, WorkerResponse } from './protocol'

type Pending = { resolve: (value: { image: DevelopedImage; timings: Timings }) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      const waiting = pending.get(response.id)
      if (!waiting) return
      pending.delete(response.id)
      if (response.ok) waiting.resolve({ image: response.image, timings: response.timings })
      else waiting.reject(new Error(response.error))
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'raw worker failed')
      for (const waiting of pending.values()) waiting.reject(error)
      pending.clear()
      worker = null
    }
  }
  return worker
}

export async function developRaw(request: Omit<DevelopRequest, 'id' | 'type'>): Promise<{ image: DevelopedImage; timings: Timings }> {
  const w = getWorker()
  if (!w) {
    const { develop } = await import('./developer')
    return develop({ ...request, type: 'develop', id: 0 })
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const message: WorkerRequest = { ...request, type: 'develop', id }
    w.postMessage(message)
  })
}

export function releaseRaw(key: string): void {
  const message: WorkerRequest = { type: 'release', key }
  worker?.postMessage(message)
}
