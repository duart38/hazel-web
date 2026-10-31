// One instance of look.wasm and typed calls into it. Used on the main thread for the quick
// calls (parse, format, tables) and in the worker for look_apply_image.

import type { LookSettings } from '../engine/types'
import { RECIPE_SIZE, readRecipe, writeRecipe } from './recipe'

interface LookExports {
  malloc(size: number): number
  free(pointer: number): void
  hz_alloc_failed(): number
  look_defaults(recipe: number): void
  look_parse(recipe: number, text: number): number
  look_format(recipe: number, out: number, size: number): number
  look_is_mono(recipe: number): number
  look_pixel(recipe: number, rgb: number): void
  look_build_rgb_table(recipe: number, n: number, table: number): void
  look_table_apply(table: number, n: number, rgb: number): void
  look_apply_image(recipe: number, rgb: number, width: number, height: number): void
  look_mix_band_name(band: number): number
  look_grade_colour(hue: number, rgb: number): void
  look_mix_band_colour(band: number, rgb: number): void
}

const EXPORT_NAMES: readonly (keyof LookExports)[] = [
  'malloc', 'free', 'hz_alloc_failed', 'look_defaults', 'look_parse', 'look_format',
  'look_is_mono', 'look_pixel', 'look_build_rgb_table', 'look_table_apply', 'look_apply_image',
  'look_mix_band_name', 'look_grade_colour', 'look_mix_band_colour',
]

/** look-threads.wasm's extra exports: a helper thread's stack pointer and its loop. */
export interface HelperExports {
  __stack_pointer: WebAssembly.Global
  hz_helper_main(): void
}

// The maths look.c can't round with certainty itself (wasm/include/hz_math.h sends about one
// call in 65,000 here). Double in and out, like Math itself, so V8 calls its C++ maths straight
// from WebAssembly; the C side rounds each result to float once, as the native parity build does.
export const MATH_IMPORTS = {
  pow: Math.pow,
  exp: Math.exp,
  cbrt: Math.cbrt,
  sin: Math.sin,
  cos: Math.cos,
  atan2: Math.atan2,
  fmod: (x: number, y: number) => x % y, // exact, like C's fmod
}

export const FORMAT_ROOM = 8192

export class LookOutOfMemory extends Error {
  constructor(width: number, height: number) {
    super(`Not enough memory to apply the look to a ${width}×${height} picture`)
    this.name = 'LookOutOfMemory'
  }
}

function isLookExports(exports: WebAssembly.Exports): exports is WebAssembly.Exports & LookExports {
  return EXPORT_NAMES.every((name) => name in exports)
}

/** The imports of either build: look-threads.wasm also takes its (shared) memory. */
export function lookImports(memory?: WebAssembly.Memory): WebAssembly.Imports {
  return memory ? { math: MATH_IMPORTS, env: { memory } } : { math: MATH_IMPORTS }
}

export class LookWasm {
  private readonly exports: LookExports
  private readonly memory: WebAssembly.Memory
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()

  /** look.wasm, or look-threads.wasm with the shared `memory` its helper threads also use. */
  constructor(module: WebAssembly.Module, memory?: WebAssembly.Memory) {
    const instance = new WebAssembly.Instance(module, lookImports(memory))
    if (!isLookExports(instance.exports)) throw new Error('look.wasm is missing exports')
    this.exports = instance.exports
    const own = instance.exports.memory
    if (memory) this.memory = memory
    else if (own instanceof WebAssembly.Memory) this.memory = own
    else throw new Error('look.wasm exports no memory')
  }

  /** Bytes of WebAssembly memory in use: it only ever grows, so a big picture leaves it big. */
  get memoryBytes(): number {
    return this.memory.buffer.byteLength
  }

  /** A block of `size` bytes that stays allocated: a helper thread's stack. */
  reserve(size: number): number {
    return this.allocate(size)
  }

  private allocate(size: number): number {
    const pointer = this.exports.malloc(size) >>> 0
    if (pointer === 0) {
      this.exports.hz_alloc_failed()
      throw new RangeError(`look.wasm could not allocate ${size} bytes`)
    }
    return pointer
  }

  /** Runs `body` with these settings as a look_recipe in memory, then frees it. */
  private withRecipe<T>(settings: LookSettings | null, body: (recipe: number) => T): T {
    const recipe = this.allocate(RECIPE_SIZE)
    try {
      if (settings) writeRecipe(settings, new DataView(this.memory.buffer), recipe)
      else this.exports.look_defaults(recipe)
      return body(recipe)
    } finally {
      this.exports.free(recipe)
    }
  }

  private withString<T>(text: string, body: (pointer: number) => T): T {
    const bytes = this.encoder.encode(text)
    const pointer = this.allocate(bytes.length + 1)
    try {
      const memory = new Uint8Array(this.memory.buffer)
      memory.set(bytes, pointer)
      memory[pointer + bytes.length] = 0
      return body(pointer)
    } finally {
      this.exports.free(pointer)
    }
  }

  private withFloats<T>(count: number, body: (pointer: number) => T): T {
    const pointer = this.allocate(4 * count)
    try {
      return body(pointer)
    } finally {
      this.exports.free(pointer)
    }
  }

  private readRecipeAt(recipe: number): LookSettings {
    return readRecipe(new DataView(this.memory.buffer), recipe)
  }

  private floatsAt(pointer: number, count: number): Float32Array {
    return new Float32Array(this.memory.buffer, pointer, count).slice()
  }

  private cString(pointer: number): string {
    const memory = new Uint8Array(this.memory.buffer)
    let end = pointer
    while (memory[end] !== 0) end++
    return this.decoder.decode(memory.slice(pointer, end)) // a copy: decode refuses shared memory
  }

  defaults(): LookSettings {
    return this.withRecipe(null, (recipe) => this.readRecipeAt(recipe))
  }

  /** look_parse over `base` (the defaults when absent); also returns how many keys it took. */
  parse(text: string, base?: LookSettings): { settings: LookSettings; recognised: number } {
    return this.withRecipe(base ?? null, (recipe) =>
      this.withString(text, (pointer) => {
        const recognised = this.exports.look_parse(recipe, pointer)
        return { settings: this.readRecipeAt(recipe), recognised }
      }),
    )
  }

  format(settings: LookSettings): string {
    return this.withRecipe(settings, (recipe) => {
      const out = this.allocate(FORMAT_ROOM)
      try {
        const length = this.exports.look_format(recipe, out, FORMAT_ROOM)
        const bytes = new Uint8Array(this.memory.buffer, out, Math.min(length, FORMAT_ROOM - 1))
        return this.decoder.decode(bytes.slice())
      } finally {
        this.exports.free(out)
      }
    })
  }

  isMono(settings: LookSettings): boolean {
    return this.withRecipe(settings, (recipe) => this.exports.look_is_mono(recipe) !== 0)
  }

  /** look_pixel on each RGB triple of `rgb`, into a new array. */
  pixels(settings: LookSettings, rgb: Float32Array): Float32Array {
    return this.withRecipe(settings, (recipe) =>
      this.withFloats(rgb.length, (pointer) => {
        new Float32Array(this.memory.buffer, pointer, rgb.length).set(rgb)
        for (let i = 0; i + 2 < rgb.length; i += 3) this.exports.look_pixel(recipe, pointer + 4 * i)
        return this.floatsAt(pointer, rgb.length)
      }),
    )
  }

  buildTable(settings: LookSettings, n: number): Float32Array {
    if (!Number.isInteger(n) || n < 2) throw new RangeError(`table size ${n}: needs a whole number of at least 2`)
    const count = 3 * n * n * n
    return this.withRecipe(settings, (recipe) =>
      this.withFloats(count, (table) => {
        this.exports.look_build_rgb_table(recipe, n, table)
        return this.floatsAt(table, count)
      }),
    )
  }

  /** look_table_apply on each RGB triple of `rgb`, into a new array. */
  tableApply(table: Float32Array, n: number, rgb: Float32Array): Float32Array {
    return this.withFloats(table.length, (tablePointer) => {
      new Float32Array(this.memory.buffer, tablePointer, table.length).set(table)
      return this.withFloats(rgb.length, (pointer) => {
        new Float32Array(this.memory.buffer, pointer, rgb.length).set(rgb)
        for (let i = 0; i + 2 < rgb.length; i += 3) this.exports.look_table_apply(tablePointer, n, pointer + 4 * i)
        return this.floatsAt(pointer, rgb.length)
      })
    })
  }

  /** look_apply_image on a copy of `rgb`; the copy comes back. Throws LookOutOfMemory when the
   *  picture and look.c's working buffers don't fit in WebAssembly memory (4 GB at most). */
  applyImage(settings: LookSettings, rgb: Float32Array, width: number, height: number): Float32Array {
    const count = 3 * width * height
    if (rgb.length !== count) throw new RangeError(`${rgb.length} floats for a ${width}×${height} picture`)
    const pixels = this.exports.malloc(4 * count) >>> 0
    if (pixels === 0) {
      this.exports.hz_alloc_failed()
      throw new LookOutOfMemory(width, height)
    }
    try {
      new Float32Array(this.memory.buffer, pixels, count).set(rgb)
      this.withRecipe(settings, (recipe) => this.exports.look_apply_image(recipe, pixels, width, height))
      // look.c skips an effect whose buffer it can't get; that would be a different picture
      if (this.exports.hz_alloc_failed()) throw new LookOutOfMemory(width, height)
      return this.floatsAt(pixels, count)
    } finally {
      this.exports.free(pixels)
    }
  }

  mixBandNames(): string[] {
    return Array.from({ length: 8 }, (_, band) => this.cString(this.exports.look_mix_band_name(band) >>> 0))
  }

  gradeColour(hue: number): [number, number, number] {
    return this.withFloats(3, (rgb) => {
      this.exports.look_grade_colour(hue, rgb)
      const [r, g, b] = this.floatsAt(rgb, 3)
      return [r, g, b]
    })
  }

  mixBandColour(band: number): [number, number, number] {
    return this.withFloats(3, (rgb) => {
      this.exports.look_mix_band_colour(band, rgb)
      const [r, g, b] = this.floatsAt(rgb, 3)
      return [r, g, b]
    })
  }
}
