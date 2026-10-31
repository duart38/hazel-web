import type { DevelopedImage, PhotoSource, ShootingInfo } from '../engine/types'
import { canvasBlob, context2d, makeCanvas } from './canvas'
import { shootingInfo } from './meta'
import { isTiff, parseTiff } from './tiff'

/** The EXIF block of a JPEG (its APP1 segment), parsed for the shooting info. */
export function jpegExifInfo(bytes: Uint8Array): ShootingInfo {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return {}
  let p = 2
  while (p + 4 < bytes.length && bytes[p] === 0xff) {
    const marker = bytes[p + 1]
    const len = (bytes[p + 2] << 8) | bytes[p + 3]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0xe1 && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78 && bytes[p + 6] === 0x69 && bytes[p + 7] === 0x66) {
      try {
        const tiff = parseTiff(bytes.subarray(p + 10, p + 2 + len))
        return shootingInfo(tiff.ifds[0], tiff.ifds[0]?.exif)
      } catch {
        return {}
      }
    }
    p += 2 + len
  }
  return {}
}

const SHOWABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

/** Any picture the browser itself can decode: JPEG, PNG, WebP, HEIC in Safari, and so on. */
export class ImagePhoto implements PhotoSource {
  private readonly file: Blob
  private readonly shooting: ShootingInfo
  private bitmap: Promise<ImageBitmap> | null = null

  constructor(file: Blob, info: ShootingInfo) {
    this.file = file
    this.shooting = info
  }

  static async open(file: Blob): Promise<ImagePhoto> {
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
    let info: ShootingInfo = {}
    if (isTiff(head)) {
      try {
        const tiff = parseTiff(head)
        info = shootingInfo(tiff.ifds[0], tiff.ifds[0]?.exif)
      } catch {
        info = {}
      }
    } else {
      info = jpegExifInfo(head)
    }
    const photo = new ImagePhoto(file, info)
    const bitmap = await photo.decoded()
    photo.shooting.width = bitmap.width
    photo.shooting.height = bitmap.height
    return photo
  }

  private decoded(): Promise<ImageBitmap> {
    this.bitmap ??= createImageBitmap(this.file, { imageOrientation: 'from-image' })
    return this.bitmap
  }

  info(): ShootingInfo {
    return { ...this.shooting }
  }

  async preview(): Promise<Blob | null> {
    if (SHOWABLE.has(this.file.type)) return this.file
    const bitmap = await this.decoded()
    const scale = Math.min(1, 1440 / Math.max(bitmap.width, bitmap.height))
    const canvas = makeCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    context2d(canvas).drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvasBlob(canvas, 'image/jpeg', 0.9)
  }

  async develop(options: { longSide?: number } = {}): Promise<DevelopedImage> {
    const bitmap = await this.decoded()
    const long = Math.max(bitmap.width, bitmap.height)
    const scale = options.longSide && options.longSide < long ? options.longSide / long : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = makeCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    const pixels = ctx.getImageData(0, 0, width, height).data
    const rgb = new Float32Array(width * height * 3)
    for (let i = 0, j = 0; j < pixels.length; i += 3, j += 4) {
      rgb[i] = pixels[j] / 255
      rgb[i + 1] = pixels[j + 1] / 255
      rgb[i + 2] = pixels[j + 2] / 255
    }
    return { width, height, rgb }
  }
}
