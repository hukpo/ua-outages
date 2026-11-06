import { inflateSync } from 'node:zlib'

/**
 * Minimal PNG decoder for the schedule images operators publish: 8-bit greyscale, RGB,
 * palette, grey+alpha and RGBA, non-interlaced. Enough for screenshots and exported tables;
 * no dependency beyond node:zlib.
 */
export interface RgbaImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row by row */
  data: Uint8Array
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => bytes[i] === b)
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
    const body = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8)
      height = view.getUint32(pos + 12)
      bitDepth = body[8]!
      colorType = body[9]!
      interlace = body[12]!
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') transparency = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }

  if (!width || !height) throw new Error('PNG without a header')
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported`)
  if (interlace) throw new Error('interlaced PNG is not supported')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`)
  if (colorType === 3 && !palette) throw new Error('PNG palette missing')

  const raw = inflateSync(concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is truncated')
  const pixels = unfilter(raw, width, height, channels)

  const data = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4
    switch (colorType) {
      case 0: // grey
        data[o] = data[o + 1] = data[o + 2] = pixels[p]!
        data[o + 3] = 255
        break
      case 2: // RGB
        data[o] = pixels[p]!
        data[o + 1] = pixels[p + 1]!
        data[o + 2] = pixels[p + 2]!
        data[o + 3] = 255
        break
      case 3: {
        // palette
        const idx = pixels[p]!
        data[o] = palette![idx * 3]!
        data[o + 1] = palette![idx * 3 + 1]!
        data[o + 2] = palette![idx * 3 + 2]!
        data[o + 3] = transparency && idx < transparency.length ? transparency[idx]! : 255
        break
      }
      case 4: // grey + alpha
        data[o] = data[o + 1] = data[o + 2] = pixels[p]!
        data[o + 3] = pixels[p + 1]!
        break
      default: // RGBA
        data[o] = pixels[p]!
        data[o + 1] = pixels[p + 1]!
        data[o + 2] = pixels[p + 2]!
        data[o + 3] = pixels[p + 3]!
    }
  }
  return { width, height, data }
}

/** Reverses the per-row PNG filters (None, Sub, Up, Average, Paeth). */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!
      const a = x >= bpp ? out[dst + x - bpp]! : 0
      const b = y > 0 ? out[dst - stride + x]! : 0
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp]! : 0
      let r: number
      switch (filter) {
        case 0:
          r = v
          break
        case 1:
          r = v + a
          break
        case 2:
          r = v + b
          break
        case 3:
          r = v + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`)
      }
      out[dst + x] = r & 0xff
    }
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** RGB of a pixel. */
export function pixel(img: RgbaImage, x: number, y: number): [number, number, number] {
  const o = (Math.round(y) * img.width + Math.round(x)) * 4
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!]
}
