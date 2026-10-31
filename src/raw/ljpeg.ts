// Hasselblad's variant of lossless JPEG, as dcraw's hasselblad_load_raw and LibRaw describe it.
// A normal JPEG header (SOF3, DHT, SOS) is followed by a bitstream that differs from ITU T.81:
// - it is read as little-endian 32-bit words, most significant bit first, with no 0xFF stuffing;
// - pixels come in pairs: both Huffman-coded bit lengths first, then both difference values;
// - the prediction is the same-colour pixel two columns left (0x8000 at a row's start); with
//   predictor 11 the change over the same two columns two rows up is added.

export interface LjpegHeader {
  /** 0..16 → Huffman lookup: (code length << 8) | value, indexed by the next `bits` bits. */
  table: Uint16Array
  bits: number
  predictor: number
  /** Byte offset (relative to the data given) where the bitstream starts. */
  dataStart: number
}

export function buildHuffman(counts: ArrayLike<number>, values: ArrayLike<number>): { table: Uint16Array; bits: number } {
  let bits = 16
  while (bits > 1 && !counts[bits - 1]) bits--
  const table = new Uint16Array(1 << bits)
  let code = 0
  let v = 0
  for (let len = 1; len <= bits; len++) {
    for (let i = 0; i < counts[len - 1]; i++, v++) {
      const span = 1 << (bits - len)
      const start = code << (bits - len)
      if (start + span > table.length) throw new Error('invalid Huffman table')
      table.fill((len << 8) | values[v], start, start + span)
      code++
    }
    code <<= 1
  }
  return { table, bits }
}

export function parseLjpegHeader(data: Uint8Array): LjpegHeader {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('raw strip is not a lossless JPEG')
  let p = 2
  let huffman: { table: Uint16Array; bits: number } | undefined
  const tables = new Map<number, { table: Uint16Array; bits: number }>()
  while (p + 4 <= data.length) {
    if (data[p] !== 0xff) throw new Error('bad JPEG marker')
    const marker = data[p + 1]
    if (marker === 0xff) { p++; continue }
    const len = (data[p + 2] << 8) | data[p + 3]
    const seg = p + 4
    const end = p + 2 + len
    if (marker === 0xc4) {
      let q = seg
      while (q < end) {
        const id = data[q] & 0x0f
        const counts = data.subarray(q + 1, q + 17)
        const total = counts.reduce((a, b) => a + b, 0)
        const values = data.subarray(q + 17, q + 17 + total)
        tables.set(id, buildHuffman(counts, values))
        q += 17 + total
      }
    } else if (marker === 0xda) {
      const components = data[seg]
      const firstTable = data[seg + 2] >> 4
      huffman = tables.get(firstTable) ?? tables.values().next().value
      const predictor = data[seg + 1 + components * 2]
      if (!huffman) throw new Error('lossless JPEG without a Huffman table')
      return { table: huffman.table, bits: huffman.bits, predictor, dataStart: end }
    } else if (marker === 0xd9) {
      break
    }
    p = end
  }
  throw new Error('lossless JPEG has no scan')
}

/** Decodes into `out` (rawWidth × rawHeight, row major). */
export function decodeHasselblad(data: Uint8Array, rawWidth: number, rawHeight: number, out: Uint16Array): void {
  const header = parseLjpegHeader(data)
  const { table, bits: tableBits, predictor } = header
  const start = header.dataStart
  const length = data.length

  let acc = 0
  let nbits = 0
  let pos = 0 // bytes consumed from the stream, before word swapping

  const fill = () => {
    while (nbits <= 24) {
      const i = start + (pos & ~3) + 3 - (pos & 3)
      acc = ((acc << 8) | (i < length ? data[i] : 0)) >>> 0
      nbits += 8
      pos++
    }
  }
  const huff = (): number => {
    fill()
    const entry = table[(acc >>> (nbits - tableBits)) & ((1 << tableBits) - 1)]
    nbits -= entry >> 8
    return entry & 0xff
  }
  const take = (n: number): number => {
    if (n === 0) return 0
    fill()
    const v = (acc >>> (nbits - n)) & ((1 << n) - 1)
    nbits -= n
    return v
  }
  const signed = (len: number, v: number): number => {
    if (len === 0) return 0
    let d = v
    if ((d & (1 << (len - 1))) === 0) d -= (1 << len) - 1
    return d === 65535 ? -32768 : d
  }

  const rows = [new Int32Array(rawWidth), new Int32Array(rawWidth), new Int32Array(rawWidth)]
  for (let row = 0; row < rawHeight; row++) {
    const twoUp = rows[(row + 1) % 3]
    const current = rows[row % 3]
    const base = row * rawWidth
    for (let col = 0; col < rawWidth; col += 2) {
      const len0 = huff()
      const len1 = huff()
      const d0 = signed(len0, take(len0))
      const d1 = signed(len1, take(len1))
      for (let s = col; s < col + 2 && s < rawWidth; s++) {
        let pred = col ? current[s - 2] : 0x8000
        if (col && row > 1 && predictor === 11) pred += ((twoUp[s] / 2) | 0) - ((twoUp[s - 2] / 2) | 0)
        pred += s & 1 ? d1 : d0
        current[s] = pred
        out[base + s] = pred & 0xffff
      }
    }
  }
}
