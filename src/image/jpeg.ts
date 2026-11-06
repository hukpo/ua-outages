import type { RgbaImage } from './png.js'

/**
 * Minimal baseline JPEG decoder (Huffman, 8-bit, greyscale or YCbCr, any chroma subsampling,
 * restart markers). Operators export their schedule pictures from Photoshop/Canva as baseline
 * JPEGs; progressive and arithmetic-coded files are rejected with an error.
 */

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7,
  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]

interface Huffman {
  /** code length → (code → symbol) */
  lookup: Map<number, number>[]
}

interface Component {
  id: number
  h: number
  v: number
  tq: number
  td: number
  ta: number
  /** blocks per line / column, padded to whole MCUs */
  bw: number
  bh: number
  /** decoded samples, bw*8 × bh*8 */
  pixels: Uint8Array
  pred: number
}

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const lookup: Map<number, number>[] = []
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    const map = new Map<number, number>()
    for (let i = 0; i < counts[len - 1]!; i++) map.set(code++, symbols[k++]!)
    lookup[len] = map
    code <<= 1
  }
  return { lookup }
}

// cosine table for the separable IDCT: C[x][u] = c(u) * cos((2x+1)uπ/16) / 2
const COS = new Float64Array(64)
for (let x = 0; x < 8; x++)
  for (let u = 0; u < 8; u++)
    COS[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2

function idct(coef: Float64Array, out: Uint8Array, stride: number, offset: number) {
  const tmp = new Float64Array(64)
  // rows: tmp[y][x] = Σu C[x][u] coef[y][u]
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u]! * coef[y * 8 + u]!
      tmp[y * 8 + x] = s
    }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let s = 0
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v]! * tmp[v * 8 + x]!
      const val = Math.round(s + 128)
      out[offset + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val
    }
}

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  if (!isJpeg(bytes)) throw new Error('not a JPEG')
  const quant: Uint16Array[] = []
  const dcTables: Huffman[] = []
  const acTables: Huffman[] = []
  let components: Component[] = []
  let width = 0
  let height = 0
  let hmax = 1
  let vmax = 1
  let restartInterval = 0
  let adobeTransform: number | null = null
  let pos = 2

  const u16 = (p: number) => (bytes[p]! << 8) | bytes[p + 1]!

  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = bytes[pos + 1]!
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      if (marker === 0xff) pos--
      continue
    }
    if (marker === 0xd9) break
    const len = u16(pos)
    const seg = bytes.subarray(pos + 2, pos + len)
    if (marker === 0xdb) {
      for (let p = 0; p < seg.length;) {
        const precision = seg[p]! >> 4
        const id = seg[p]! & 15
        const table = new Uint16Array(64)
        p++
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]!] = precision ? (seg[p]! << 8) | seg[p + 1]! : seg[p]!
          p += precision ? 2 : 1
        }
        quant[id] = table
      }
    } else if (marker === 0xc4) {
      for (let p = 0; p < seg.length;) {
        const cls = seg[p]! >> 4
        const id = seg[p]! & 15
        const counts = seg.subarray(p + 1, p + 17)
        const total = counts.reduce((a, b) => a + b, 0)
        const table = buildHuffman(counts, seg.subarray(p + 17, p + 17 + total))
        ;(cls === 0 ? dcTables : acTables)[id] = table
        p += 17 + total
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (seg[0] !== 8) throw new Error(`unsupported JPEG precision ${seg[0]}`)
      height = (seg[1]! << 8) | seg[2]!
      width = (seg[3]! << 8) | seg[4]!
      components = []
      for (let i = 0; i < seg[5]!; i++) {
        const b = 6 + i * 3
        components.push({
          id: seg[b]!,
          h: seg[b + 1]! >> 4,
          v: seg[b + 1]! & 15,
          tq: seg[b + 2]!,
          td: 0,
          ta: 0,
          bw: 0,
          bh: 0,
          pixels: new Uint8Array(0),
          pred: 0,
        })
      }
      hmax = Math.max(...components.map((c) => c.h))
      vmax = Math.max(...components.map((c) => c.v))
      const mcusX = Math.ceil(width / (8 * hmax))
      const mcusY = Math.ceil(height / (8 * vmax))
      for (const c of components) {
        c.bw = mcusX * c.h
        c.bh = mcusY * c.v
        c.pixels = new Uint8Array(c.bw * 8 * c.bh * 8)
      }
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error('only baseline JPEGs are supported (this one is progressive or arithmetic-coded)')
    } else if (marker === 0xdd) {
      restartInterval = u16(pos + 2)
    } else if (marker === 0xee && String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') {
      adobeTransform = seg[11] ?? null
    } else if (marker === 0xda) {
      const n = seg[0]!
      const scan: Component[] = []
      for (let i = 0; i < n; i++) {
        const c = components.find((x) => x.id === seg[1 + i * 2])
        if (!c) throw new Error('JPEG scan names an unknown component')
        c.td = seg[2 + i * 2]! >> 4
        c.ta = seg[2 + i * 2]! & 15
        scan.push(c)
      }
      pos = decodeScan(
        bytes,
        pos + len,
        scan,
        width,
        height,
        hmax,
        vmax,
        restartInterval,
        quant,
        dcTables,
        acTables,
      )
      continue
    }
    pos += len
  }

  if (!width || !components.length) throw new Error('JPEG has no image data')
  return toRgba(components, width, height, hmax, vmax, adobeTransform)
}

function decodeScan(
  bytes: Uint8Array,
  start: number,
  scan: Component[],
  width: number,
  height: number,
  hmax: number,
  vmax: number,
  restartInterval: number,
  quant: Uint16Array[],
  dcTables: Huffman[],
  acTables: Huffman[],
): number {
  let pos = start
  let bitBuf = 0
  let bitCount = 0

  const readBit = (): number => {
    if (bitCount === 0) {
      const b = bytes[pos]
      if (b === undefined) throw new Error('JPEG data ends early')
      if (b === 0xff && bytes[pos + 1] !== 0) {
        // reached a marker: the remaining bits of the segment are padding
        bitBuf = 0
        bitCount = 8
      } else {
        pos += b === 0xff ? 2 : 1 // 0xFF00 is a stuffed 0xFF
        bitBuf = b
        bitCount = 8
      }
      bitCount = 8
    }
    bitCount--
    return (bitBuf >> bitCount) & 1
  }
  const receive = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | readBit()
    return v
  }
  const extend = (v: number, n: number) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v)
  const decodeHuff = (t: Huffman): number => {
    let code = 0
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit()
      const s = t.lookup[len]!.get(code)
      if (s !== undefined) return s
    }
    throw new Error('bad Huffman code in JPEG')
  }

  const coef = new Float64Array(64)
  const decodeBlock = (c: Component, row: number, col: number) => {
    coef.fill(0)
    const q = quant[c.tq]!
    const dcT = dcTables[c.td]
    const acT = acTables[c.ta]
    if (!dcT || !acT) throw new Error('JPEG references a missing Huffman table')
    const t = decodeHuff(dcT)
    c.pred += t ? extend(receive(t), t) : 0
    coef[0] = c.pred * q[0]!
    for (let k = 1; k < 64;) {
      const rs = decodeHuff(acT)
      const r = rs >> 4
      const s = rs & 15
      if (!s) {
        if (r !== 15) break
        k += 16
        continue
      }
      k += r
      if (k > 63) break
      coef[ZIGZAG[k]!] = extend(receive(s), s) * q[ZIGZAG[k]!]!
      k++
    }
    const stride = c.bw * 8
    idct(coef, c.pixels, stride, row * 8 * stride + col * 8)
  }

  const single = scan.length === 1
  const c0 = scan[0]!
  // a single-component scan is not interleaved: it walks that component's own blocks
  const mcusX = single ? Math.ceil(Math.ceil((width * c0.h) / hmax) / 8) : Math.ceil(width / (8 * hmax))
  const mcusY = single ? Math.ceil(Math.ceil((height * c0.v) / vmax) / 8) : Math.ceil(height / (8 * vmax))
  const total = mcusX * mcusY
  for (const c of scan) c.pred = 0

  for (let m = 0; m < total; m++) {
    if (restartInterval && m > 0 && m % restartInterval === 0) {
      // skip to the RSTn marker and reset the decoder state
      bitCount = 0
      while (
        pos < bytes.length &&
        !(bytes[pos] === 0xff && bytes[pos + 1]! >= 0xd0 && bytes[pos + 1]! <= 0xd7)
      )
        pos++
      pos += 2
      for (const c of scan) c.pred = 0
    }
    const my = Math.floor(m / mcusX)
    const mx = m % mcusX
    if (single) decodeBlock(c0, my, mx)
    else
      for (const c of scan)
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, my * c.v + v, mx * c.h + h)
  }

  // find the next marker
  while (
    pos < bytes.length &&
    !(bytes[pos] === 0xff && bytes[pos + 1] !== 0 && !(bytes[pos + 1]! >= 0xd0 && bytes[pos + 1]! <= 0xd7))
  )
    pos++
  return pos
}

function toRgba(
  components: Component[],
  width: number,
  height: number,
  hmax: number,
  vmax: number,
  adobeTransform: number | null,
): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  const at = (c: Component, x: number, y: number) => {
    const sx = Math.floor((x * c.h) / hmax)
    const sy = Math.floor((y * c.v) / vmax)
    return c.pixels[sy * c.bw * 8 + sx]!
  }
  const ycc = components.length === 3 && adobeTransform !== 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (components.length === 1) {
        const g = at(components[0]!, x, y)
        data[o] = data[o + 1] = data[o + 2] = g
      } else if (components.length === 3) {
        const a = at(components[0]!, x, y)
        const b = at(components[1]!, x, y)
        const c = at(components[2]!, x, y)
        if (ycc) {
          data[o] = clamp(a + 1.402 * (c - 128))
          data[o + 1] = clamp(a - 0.344136 * (b - 128) - 0.714136 * (c - 128))
          data[o + 2] = clamp(a + 1.772 * (b - 128))
        } else {
          data[o] = a
          data[o + 1] = b
          data[o + 2] = c
        }
      } else throw new Error(`unsupported JPEG with ${components.length} components`)
      data[o + 3] = 255
    }
  return { width, height, data }
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
