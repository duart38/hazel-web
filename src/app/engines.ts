// The app's way to the raw decoder (web/src/raw) and the look engine (web/src/look).

import type { DevelopedImage, LookEngine, PhotoSource, ShootingInfo } from '../engine/types'
import type { ExportFormat } from '../core/photos'
import { loadLookModule } from '../look'
import { lookEngineFromModule } from '../look/engine'
import { encodeJpeg, encodePng16, encodeTiff16, openPhoto } from '../raw'

export type OpenPhoto = (file: File, name: string) => Promise<PhotoSource>
export type Encode = (image: DevelopedImage, format: ExportFormat, info?: ShootingInfo) => Promise<Blob>

export interface Engines {
  /** thumbnails and exports */
  look: LookEngine
  /** Its own worker, for the pictures that follow a slider or a picked look: cancelling what a
   *  slider has moved past never drops a thumbnail or an export. */
  live: LookEngine
  openPhoto: OpenPhoto
  encode: Encode
  /** false without WebGL2: pictures then change when the look engine is done, not as you drag */
  webgl2: boolean
}

/** Something the browser lacks that Hazel can't start without. */
export class MissingFeature extends Error {}

export function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return gl !== null
  } catch {
    return false
  }
}

export async function loadEngines(): Promise<Engines> {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.compile !== 'function') {
    throw new MissingFeature(
      "This browser can't run WebAssembly, which Hazel's look engine needs. A current Chrome, Edge, Firefox or Safari can; in some browsers it's turned off by a security setting.",
    )
  }
  const module = await loadLookModule()
  return {
    look: lookEngineFromModule(module),
    live: lookEngineFromModule(module),
    webgl2: hasWebGL2(),
    openPhoto,
    encode: async (image, format, info) => {
      if (format === 'jpeg') return encodeJpeg(image, { info })
      if (format === 'png') return encodePng16(image)
      return encodeTiff16(image)
    },
  }
}
