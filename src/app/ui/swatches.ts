// The recipe's own colours for film-box labels and the white-balance pad, from the table the
// look engine builds.

import type { LookEngine, LookSettings } from '../../engine/types'
import { lookUp, REFERENCE_COLOURS, type RGB } from '../../core/swatch'

const TABLE_SIZE = 17
const strips = new Map<string, RGB[]>()

export function swatchStrip(engine: LookEngine, key: string, look: LookSettings): RGB[] {
  const hit = strips.get(key)
  if (hit) return hit
  const table = engine.buildTable(look, TABLE_SIZE)
  const strip = REFERENCE_COLOURS.map((colour) => lookUp(table, TABLE_SIZE, colour))
  if (strips.size > 300) strips.delete(strips.keys().next().value as string)
  strips.set(key, strip)
  return strip
}

let pad: ImageData | null = null

/** The white-balance shift pad: red ↔ cyan across (right is red) and blue ↔ yellow up (top is
 *  blue), each cell a light grey through that shift. The engine's shift is subtle on a grey, so
 *  the difference from grey is drawn three times stronger. */
export function shiftPad(engine: LookEngine, size = 16): ImageData {
  if (pad) return pad
  const image = new ImageData(size, size)
  const grey = 0.62
  const base = engine.defaults()
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const look = { ...base, shiftRed: (column / (size - 1)) * 2 - 1, shiftBlue: 1 - (row / (size - 1)) * 2 }
      const table = engine.buildTable(look, 5)
      const out = lookUp(table, 5, [grey, grey, grey])
      for (let c = 0; c < 3; c++) {
        image.data[(row * size + column) * 4 + c] = Math.min(Math.max(grey + (out[c] - grey) * 3, 0), 1) * 255
      }
      image.data[(row * size + column) * 4 + 3] = 255
    }
  }
  pad = image
  return image
}
