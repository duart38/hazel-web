import { decodeHasselblad } from './ljpeg'
import type { RawMeta } from './meta'

/** The raw strip's samples, rawWidth × rawHeight. `strip` is the bytes at meta.stripOffset. */
export function unpackRaw(meta: RawMeta, strip: Uint8Array): Uint16Array {
  const count = meta.rawWidth * meta.rawHeight
  if (meta.compression === 1) {
    if (meta.bitsPerSample !== 16) throw new Error(`uncompressed ${meta.bitsPerSample}-bit raws are not supported`)
    if (strip.byteLength < count * 2) throw new Error('raw strip is shorter than the image')
    const hostLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
    let samples: Uint16Array
    if (strip.byteOffset % 2 === 0) {
      samples = new Uint16Array(strip.buffer, strip.byteOffset, count)
    } else {
      samples = new Uint16Array(count)
      new Uint8Array(samples.buffer).set(strip.subarray(0, count * 2))
    }
    if (meta.littleEndian !== hostLittle) {
      for (let i = 0; i < count; i++) samples[i] = ((samples[i] & 0xff) << 8) | (samples[i] >> 8)
    }
    return samples
  }
  const out = new Uint16Array(count)
  decodeHasselblad(strip, meta.rawWidth, meta.rawHeight, out)
  return out
}
