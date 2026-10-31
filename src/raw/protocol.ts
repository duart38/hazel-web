import type { DevelopedImage } from '../engine/types'
import type { DevelopParams } from './colour'
import type { RawMeta } from './meta'

export interface DevelopOptions {
  longSide?: number
  noiseReduction?: number
}

export interface DevelopRequest {
  type: 'develop'
  id: number
  /** Identifies the photo, so the worker can keep its decoded raw between develops. */
  key: string
  file: Blob
  meta: RawMeta
  params: DevelopParams
  options: DevelopOptions
}

export interface ReleaseRequest {
  type: 'release'
  key: string
}

export type WorkerRequest = DevelopRequest | ReleaseRequest

export interface Timings {
  readMs: number
  decodeMs: number
  developMs: number
  gpu: boolean
}

export type WorkerResponse =
  | { id: number; ok: true; image: DevelopedImage; timings: Timings }
  | { id: number; ok: false; error: string }
