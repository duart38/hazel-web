import type { DevelopedImage, PhotoSource, ShootingInfo } from '../engine/types'
import { canvasBlob, context2d, makeCanvas, orientedCanvas } from './canvas'
import { developRaw, releaseRaw } from './client'
import { developParams } from './colour'
import { rawMeta, type RawMeta } from './meta'
import type { Timings } from './protocol'
import { OutOfRange, parseTiff } from './tiff'

const HEAD_BYTES = 1 << 20

/** Reads the start of the file and parses its TIFF structure, reading further if it points
 *  past what was read. */
export async function readMeta(file: Blob): Promise<RawMeta> {
  let length = Math.min(file.size, HEAD_BYTES)
  for (;;) {
    const head = new Uint8Array(await file.slice(0, length).arrayBuffer())
    try {
      return rawMeta(parseTiff(head), head)
    } catch (error) {
      if (!(error instanceof OutOfRange) || length >= file.size) throw error
      length = Math.min(file.size, Math.max(length * 2, error.needed + 65536))
    }
  }
}

let nextKey = 1

export class RawPhoto implements PhotoSource {
  readonly name: string
  readonly meta: RawMeta
  private readonly file: Blob
  private readonly key: string
  private previewBlob: Promise<Blob | null> | null = null
  /** How long the last develop took, for diagnostics. */
  lastTimings: Timings | null = null

  constructor(file: Blob, name: string, meta: RawMeta) {
    this.file = file
    this.name = name
    this.meta = meta
    this.key = `${nextKey++}:${name}`
  }

  info(): ShootingInfo {
    return { ...this.meta.info }
  }

  preview(): Promise<Blob | null> {
    this.previewBlob ??= this.makePreview().catch((error: unknown) => {
      console.warn(`No preview for ${this.name}:`, error)
      return null
    })
    return this.previewBlob
  }

  private async makePreview(): Promise<Blob | null> {
    const location = this.meta.preview
    if (!location) return null
    const bytes = this.file.slice(location.offset, location.offset + location.length)
    const orientation = this.meta.orientation
    if (location.kind === 'jpeg') {
      const jpeg = new Blob([bytes], { type: 'image/jpeg' })
      if (orientation === 1) return jpeg
      const bitmap = await createImageBitmap(jpeg, { imageOrientation: 'none' })
      return canvasBlob(orientedCanvas(bitmap, orientation), 'image/jpeg', 0.9)
    }
    const rgb = new Uint8Array(await bytes.arrayBuffer())
    const { width, height } = location
    const canvas = makeCanvas(width, height)
    const ctx = context2d(canvas)
    const image = ctx.createImageData(width, height)
    const out = image.data
    for (let i = 0, j = 0; i < width * height * 3; i += 3, j += 4) {
      out[j] = rgb[i]
      out[j + 1] = rgb[i + 1]
      out[j + 2] = rgb[i + 2]
      out[j + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
    return canvasBlob(orientation === 1 ? canvas : orientedCanvas(canvas, orientation), 'image/jpeg', 0.9)
  }

  async develop(options: { longSide?: number; noiseReduction?: number } = {}): Promise<DevelopedImage> {
    const { image, timings } = await developRaw({
      key: this.key,
      file: this.file,
      meta: this.meta,
      params: developParams(this.meta),
      options: { longSide: options.longSide, noiseReduction: options.noiseReduction },
    })
    this.lastTimings = timings
    return image
  }

  /** Lets the worker drop this photo's decoded raw now rather than when the next one opens. */
  close(): void {
    releaseRaw(this.key)
  }
}
