import { deflateSync } from 'node:zlib'
import { decodeJpeg, isJpeg } from './jpeg.js'
import { decodePng, isPng, MAX_IMAGE_PIXELS, type RgbaImage } from './png.js'

/**
 * Makes a picture cheap to send to an image processor without losing what matters on it.
 * Vision models bill by pixels (Claude: ⌈w/28⌉·⌈h/28⌉ tokens), so the picture is scaled down to
 * `maxLongEdge` (never up) after trimming plain margins. Pure JS on the bundled decoders; a
 * picture they can't read (a progressive JPEG) is sent as it is, and the API scales it itself.
 *
 * Only margins of one flat colour are trimmed: headers and logos stay, since the date is often
 * printed among them.
 */

export interface CompactOptions {
  /** Long edge in px after scaling; never scaled up */
  maxLongEdge: number
  /** Trim flat margins, default true */
  trim?: boolean
}

export interface CompactImage {
  bytes: Uint8Array
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  original: { width: number; height: number; bytes: number }
  /** False when the picture went as it was (couldn't be decoded, or nothing to do) */
  compacted: boolean
}

export function compactImage(bytes: Uint8Array, opts: CompactOptions): CompactImage {
  const jpeg = isJpeg(bytes)
  if (!jpeg && !isPng(bytes)) throw new Error('not a PNG or JPEG picture')
  let img: RgbaImage
  try {
    img = jpeg ? decodeJpeg(bytes) : decodePng(bytes)
  } catch {
    // a picture the decoders don't read: as it is, when its size can be told
    const size = jpeg ? jpegSize(bytes) : null
    if (!size) throw new Error('the picture could not be decoded')
    return asIs(bytes, 'image/jpeg', size)
  }
  const original = { width: img.width, height: img.height, bytes: bytes.length }
  const trimmed = opts.trim === false ? img : trimMargins(img)
  const scaled = downscale(trimmed, opts.maxLongEdge)
  if (scaled === img && jpeg) return { ...asIs(bytes, 'image/jpeg', original), compacted: false }
  const out = encodePng(scaled)
  // the source was already smaller than the re-encoded copy, and nothing was cut or scaled
  if (scaled === img && out.length >= bytes.length)
    return asIs(bytes, jpeg ? 'image/jpeg' : 'image/png', original)
  return {
    bytes: out,
    mediaType: 'image/png',
    width: scaled.width,
    height: scaled.height,
    original,
    compacted: true,
  }
}

function asIs(
  bytes: Uint8Array,
  mediaType: CompactImage['mediaType'],
  size: { width: number; height: number },
): CompactImage {
  return {
    bytes,
    mediaType,
    width: size.width,
    height: size.height,
    original: { width: size.width, height: size.height, bytes: bytes.length },
    compacted: false,
  }
}

/** Width and height from a JPEG's frame header, without decoding it */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
      return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : null
    }
    i += 2 + len
  }
  return null
}

const TOLERANCE = 24
const close = (d: Uint8Array, p: number, c: readonly number[]) =>
  Math.abs(d[p]! - c[0]!) + Math.abs(d[p + 1]! - c[1]!) + Math.abs(d[p + 2]! - c[2]!) <= TOLERANCE

/**
 * Cuts rows and columns of the border's flat colour off each side, keeping a 2% pad. A side is
 * cut by at most 40%, and nothing is cut unless it saves at least 10% of the area (a smaller cut saves fewer tokens than the bigger re-encoded upload costs): a table is
 * never touched, only the empty frame around it.
 */
export function trimMargins(img: RgbaImage): RgbaImage {
  const { width: w, height: h, data: d } = img
  if (w < 32 || h < 32) return img
  const c = [d[0]!, d[1]!, d[2]!]
  const rowFlat = (y: number) => {
    let off = 0
    for (let x = 0; x < w; x++) if (!close(d, (y * w + x) * 4, c)) off++
    return off <= w * 0.005
  }
  const colFlat = (x: number, y0: number, y1: number) => {
    let off = 0
    for (let y = y0; y < y1; y++) if (!close(d, (y * w + x) * 4, c)) off++
    return off <= (y1 - y0) * 0.005
  }
  let top = 0
  while (top < h * 0.4 && rowFlat(top)) top++
  let bottom = h
  while (bottom > h * 0.6 && rowFlat(bottom - 1)) bottom--
  let left = 0
  while (left < w * 0.4 && colFlat(left, top, bottom)) left++
  let right = w
  while (right > w * 0.6 && colFlat(right - 1, top, bottom)) right--
  const padX = Math.round(w * 0.02)
  const padY = Math.round(h * 0.02)
  top = Math.max(0, top - padY)
  bottom = Math.min(h, bottom + padY)
  left = Math.max(0, left - padX)
  right = Math.min(w, right + padX)
  const nw = right - left
  const nh = bottom - top
  if (nw * nh > w * h * 0.9) return img
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++)
    out.set(d.subarray(((top + y) * w + left) * 4, ((top + y) * w + right) * 4), y * nw * 4)
  return { width: nw, height: nh, data: out }
}

/** Area-average scaling down to `maxLongEdge`; the same object when it is small enough already */
export function downscale(img: RgbaImage, maxLongEdge: number): RgbaImage {
  const long = Math.max(img.width, img.height)
  if (long <= maxLongEdge) return img
  const k = maxLongEdge / long
  const nw = Math.max(1, Math.round(img.width * k))
  const nh = Math.max(1, Math.round(img.height * k))
  const sx = img.width / nw
  const sy = img.height / nh
  const src = img.data
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)))
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += src[p]!
          g += src[p + 1]!
          b += src[p + 2]!
          a += src[p + 3]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const q = (y * nw + x) * 4
      out[q] = Math.round(r / n)
      out[q + 1] = Math.round(g / n)
      out[q + 2] = Math.round(b / n)
      out[q + 3] = Math.round(a / n)
    }
  }
  return { width: nw, height: nh, data: out }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, body.length)
  const name = new TextEncoder().encode(type)
  head.set(name, 4)
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc32([name, body]))
  const out = new Uint8Array(12 + body.length)
  out.set(head, 0)
  out.set(body, 8)
  out.set(tail, 8 + body.length)
  return out
}

/**
 * RGBA → PNG: 8-bit grey when every pixel is grey (smaller upload, same token count), RGB
 * otherwise; alpha is dropped (flattened on white). Rows use the "up" filter.
 */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width: w, height: h, data: d } = img
  const flat = (p: number, i: number) => {
    const a = d[p + 3]!
    return a === 255 ? d[p + i]! : Math.round((d[p + i]! * a + 255 * (255 - a)) / 255)
  }
  let grey = true
  for (let p = 0; p < d.length && grey; p += 4) {
    const r = flat(p, 0)
    if (Math.abs(r - flat(p, 1)) > 2 || Math.abs(r - flat(p, 2)) > 2) grey = false
  }
  const ch = grey ? 1 : 3
  const stride = w * ch
  const raw = new Uint8Array((stride + 1) * h)
  let prev = new Uint8Array(stride)
  let row = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      if (grey) row[x] = flat(p, 0)
      else {
        row[x * 3] = flat(p, 0)
        row[x * 3 + 1] = flat(p, 1)
        row[x * 3 + 2] = flat(p, 2)
      }
    }
    const o = y * (stride + 1)
    raw[o] = 2
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i]! - prev[i]!) & 0xff
    ;[prev, row] = [row, prev]
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = grey ? 0 : 2
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
