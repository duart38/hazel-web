import { develop, release } from './developer'
import type { WorkerRequest, WorkerResponse } from './protocol'

let queue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'release') {
    queue = queue.then(() => release(request.key))
    return
  }
  // one develop at a time: each holds a 100 MB raw and the one GL context
  queue = queue.then(async () => {
    let response: WorkerResponse
    try {
      const { image, timings } = await develop(request)
      response = { id: request.id, ok: true, image, timings }
      self.postMessage(response, { transfer: [image.rgb.buffer] })
    } catch (error) {
      response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
      self.postMessage(response)
    }
  })
}
