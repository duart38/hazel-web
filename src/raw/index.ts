import type { PhotoSource } from '../engine/types'
import { ImagePhoto } from './image-source'
import { RawPhoto, readMeta } from './raw-source'
import { isTiff } from './tiff'

export { encodeJpeg, encodePng16, encodeTiff16 } from './encode'
export { RawPhoto } from './raw-source'
export { ImagePhoto } from './image-source'

const RAW_EXTENSIONS = /\.(3fr|fff)$/i

/** Opens a Hasselblad raw (.3FR) or any picture the browser can decode. */
export async function openPhoto(file: File | Blob, name: string): Promise<PhotoSource> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  if (isTiff(head)) {
    try {
      return new RawPhoto(file, name, await readMeta(file))
    } catch (error) {
      if (RAW_EXTENSIONS.test(name)) throw error
    }
  }
  return ImagePhoto.open(file)
}
