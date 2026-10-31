// Decoding and rendering, kept off the critical path. Recently decoded pictures are kept, since
// decoding is the slow part; the look on top takes milliseconds at screen size. Small previews
// come from the camera's own preview inside the raw (fast, Hasselblad colour); the large view,
// the Studio and exports develop the raw itself.

import type { DevelopedImage, LookSettings, PhotoSource, ShootingInfo } from '../engine/types'
import type { Engines } from './engines'

export interface PhotoRef {
  /** unique across folders */
  key: string
  name: string
  file(): Promise<File>
}

class Recent<V> {
  private items = new Map<string, V>()
  private limit: number
  private onEvict?: (value: V) => void
  constructor(limit: number, onEvict?: (value: V) => void) {
    this.limit = limit
    this.onEvict = onEvict
  }
  get(key: string): V | undefined {
    const value = this.items.get(key)
    if (value !== undefined) {
      this.items.delete(key)
      this.items.set(key, value)
    }
    return value
  }
  set(key: string, value: V) {
    this.items.delete(key)
    this.items.set(key, value)
    while (this.items.size > this.limit) {
      const [oldest, old] = this.items.entries().next().value as [string, V]
      this.items.delete(oldest)
      this.onEvict?.(old)
    }
  }
  delete(key: string) {
    this.items.delete(key)
  }
}

/** Runs at most `width` jobs at once, newest first, so what was asked for last (what's on screen
 *  now) comes first. A job whose signal is aborted before it starts is dropped. */
class Queue {
  private waiting: (() => void)[] = []
  private running = 0
  private width: number
  constructor(width: number) {
    this.width = width
  }

  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) {
          reject(new DOMException('Not needed any more', 'AbortError'))
          this.next()
          return
        }
        this.running++
        job()
          .then(resolve, reject)
          .finally(() => {
            this.running--
            this.next()
          })
      }
      this.waiting.push(start)
      this.next()
    })
  }

  private next() {
    while (this.running < this.width && this.waiting.length > 0) this.waiting.pop()?.()
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** A picture the browser can decode (a raw's embedded preview, a JPEG), `longSide` at most. */
async function decodeToImage(blob: Blob, longSide?: number): Promise<DevelopedImage> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const scale = longSide ? Math.min(1, longSide / Math.max(bitmap.width, bitmap.height)) : 1
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2D canvas')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const pixels = context.getImageData(0, 0, width, height).data
  const rgb = new Float32Array(width * height * 3)
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgb[j] = pixels[i] / 255
    rgb[j + 1] = pixels[i + 1] / 255
    rgb[j + 2] = pixels[i + 2] / 255
  }
  return { width, height, rgb }
}

export function toImageData(image: DevelopedImage): ImageData {
  const data = new ImageData(image.width, image.height)
  const out = data.data
  const rgb = image.rgb
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    out[i] = rgb[j] * 255 + 0.5
    out[i + 1] = rgb[j + 1] * 255 + 0.5
    out[i + 2] = rgb[j + 2] * 255 + 0.5
    out[i + 3] = 255
  }
  return data
}

export function toBitmap(image: DevelopedImage): Promise<ImageBitmap> {
  return createImageBitmap(toImageData(image))
}

/** for `developed`: the photo at its full size, for zooming in to 100% */
export const FULL_SIZE = 0

export class Renderer {
  private sources = new Recent<Promise<PhotoSource>>(24)
  private previews = new Recent<Promise<DevelopedImage>>(64)
  /** developments are 40 MB at screen size and 600 MB at full size: only a few are kept */
  private developments = new Recent<Promise<DevelopedImage>>(3)
  private thumbs = new Recent<Promise<string>>(600, (url) => void url.then((u) => URL.revokeObjectURL(u), () => {}))
  private decodeQueue = new Queue(2)
  private lookQueue = new Queue(2)
  private lanes = new Map<string, number>()
  private tickets = 0

  readonly engines: Engines
  constructor(engines: Engines) {
    this.engines = engines
  }

  source(photo: PhotoRef): Promise<PhotoSource> {
    let source = this.sources.get(photo.key)
    if (!source) {
      source = photo.file().then((file) => this.engines.openPhoto(file, photo.name))
      source.catch(() => this.sources.delete(photo.key))
      this.sources.set(photo.key, source)
    }
    return source
  }

  async info(photo: PhotoRef): Promise<ShootingInfo> {
    return (await this.source(photo)).info()
  }

  /** The camera's own preview, `longSide` at most; a development where there is none. */
  embedded(photo: PhotoRef, longSide: number, signal?: AbortSignal): Promise<DevelopedImage> {
    const key = `${photo.key}@${longSide}`
    let image = this.previews.get(key)
    if (!image) {
      image = this.decodeQueue.run(async () => {
        const source = await this.source(photo)
        const preview = await source.preview()
        return preview ? decodeToImage(preview, longSide) : source.develop({ longSide })
      }, signal)
      image.catch(() => this.previews.delete(key))
      this.previews.set(key, image)
    }
    return image
  }

  /** A real development of the raw: the large view, the Studio and exports. `noise` is the
   *  recipe's noise reduction, which changes the decode itself. */
  developed(photo: PhotoRef, longSide: number, noise: number, signal?: AbortSignal): Promise<DevelopedImage> {
    const key = `${photo.key}@${longSide}~${noise}`
    let image = this.developments.get(key)
    if (!image) {
      image = this.decodeQueue.run(
        async () => (await this.source(photo)).develop({ longSide: longSide === FULL_SIZE ? undefined : longSide, noiseReduction: noise }),
        signal,
      )
      image.catch(() => this.developments.delete(key))
      this.developments.set(key, image)
    }
    return image
  }

  /** The look applied to `image`, as a new picture (the engine never changes the one it's
   *  given, and knows a picture it saw last by its pixels, so it isn't copied again); null
   *  leaves it as it is. */
  async look(image: DevelopedImage, look: LookSettings | null, signal?: AbortSignal): Promise<DevelopedImage> {
    if (!look) return image
    return this.lookQueue.run(() => this.engines.look.applyImage(look, image), signal)
  }

  /** A small picture with a look, as an image URL; kept, so lists scroll back quickly. */
  thumbnail(photo: PhotoRef, size: number, recipe: string | null, signal?: AbortSignal): Promise<string> {
    const key = `${photo.key}@${size}|${recipe ?? ''}`
    let url = this.thumbs.get(key)
    if (!url) {
      url = (async () => {
        const image = await this.embedded(photo, size, signal)
        const looked = await this.look(image, recipe === null ? null : this.engines.look.parse(recipe), signal)
        const canvas = new OffscreenCanvas(looked.width, looked.height)
        canvas.getContext('2d')?.putImageData(toImageData(looked), 0, 0)
        return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }))
      })()
      url.catch(() => this.thumbs.delete(key))
      this.thumbs.set(key, url)
    }
    return url
  }

  /** For pictures that follow a slider or a picked look, on the live engine. Each request takes
   *  a ticket for its `lane` and cancels whatever hasn't started yet; one overtaken by a newer
   *  request in its lane resolves null. */
  async latest(lane: string, image: DevelopedImage, look: LookSettings | null): Promise<DevelopedImage | null> {
    const ticket = ++this.tickets
    this.lanes.set(lane, ticket)
    const live = this.engines.live
    live.cancelPending()
    if (!look) return image
    // cancelPending also drops another lane's request; that one asks again
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await live.applyImage(look, image)
        return this.lanes.get(lane) === ticket ? result : null
      } catch (error) {
        if (!isAbort(error) || attempt >= 4) throw error
        if (this.lanes.get(lane) !== ticket) return null
      }
    }
  }
}
