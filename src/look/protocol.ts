import type { LookSettings } from '../engine/types'

// Messages between the look engine on the main thread (engine.ts) and its worker (worker.ts).

export interface InitMessage {
  type: 'init'
  module: WebAssembly.Module
}

export interface ApplyMessage {
  type: 'apply'
  id: number
  settings: LookSettings
  width: number
  height: number
  /** Which picture: the worker keeps the last one it was sent, so the same picture with new
   *  settings doesn't cross threads again. */
  sourceId: number
  /** The picture's pixels, when the worker doesn't have them yet (transferred). */
  source?: Float32Array
}

export type ToWorker = InitMessage | ApplyMessage

export type FromWorker =
  | { type: 'done'; id: number; rgb: Float32Array; milliseconds: number; threads: number }
  | { type: 'error'; id: number; name: string; message: string }
