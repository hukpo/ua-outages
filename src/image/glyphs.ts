import type { Span } from './grid.js'
import type { RgbaImage } from './png.js'

/**
 * Building blocks for reading short printed text (times, dates) out of an image without OCR:
 * find coloured regions, threshold the ink inside them, split it into lines and glyphs, and
 * turn each glyph into a small fixed-size bitmap for template matching.
 */

/** Pixel box, [x0, x1) × [y0, y1) */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type PixelTest = (r: number, g: number, b: number) => boolean

/** A thresholded crop of the image: `bits` 1 = ink; `darkness` 0..1 keeps antialiased edges */
export interface Mask {
  width: number
  height: number
  bits: Uint8Array
  darkness: Float32Array
}

/**
 * Bounding boxes of the large connected regions whose pixels pass `test`, e.g. the coloured
 * cards of a schedule. Works on a coarse grid of `cell`-pixel squares, so text and noise inside
 * a region don't split it. Sorted top to bottom, then left to right.
 */
export function regions(
  img: RgbaImage,
  test: PixelTest,
  opts: { cell?: number; minArea?: number } = {},
): Box[] {
  const cell = opts.cell ?? 4
  const minArea = opts.minArea ?? 0
  const gw = Math.floor(img.width / cell)
  const gh = Math.floor(img.height / cell)
  const grid = new Uint8Array(gw * gh)
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let n = 0
      for (let y = gy * cell; y < (gy + 1) * cell; y++)
        for (let x = gx * cell; x < (gx + 1) * cell; x++) {
          const o = (y * img.width + x) * 4
          if (test(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!)) n++
        }
      grid[gy * gw + gx] = n * 2 >= cell * cell ? 1 : 0
    }

  const seen = new Uint8Array(gw * gh)
  const out: Box[] = []
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || seen[i]) continue
    const box = { x0: gw, y0: gh, x1: 0, y1: 0 }
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()!
      const x = j % gw
      const y = (j - x) / gw
      box.x0 = Math.min(box.x0, x)
      box.y0 = Math.min(box.y0, y)
      box.x1 = Math.max(box.x1, x + 1)
      box.y1 = Math.max(box.y1, y + 1)
      for (const k of [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, j - gw, j + gw])
        if (k >= 0 && k < grid.length && grid[k] && !seen[k]) {
          seen[k] = 1
          stack.push(k)
        }
    }
    const px = { x0: box.x0 * cell, y0: box.y0 * cell, x1: box.x1 * cell, y1: box.y1 * cell }
    if ((px.x1 - px.x0) * (px.y1 - px.y0) >= minArea) out.push(px)
  }
  return out
}

/** Thresholds a box of the image: pixels passing `isInk` become 1. */
export function inkMask(img: RgbaImage, box: Box, isInk: PixelTest): Mask {
  const width = box.x1 - box.x0
  const height = box.y1 - box.y0
  const bits = new Uint8Array(width * height)
  const darkness = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = ((box.y0 + y) * img.width + box.x0 + x) * 4
      const r = img.data[o]!
      const g = img.data[o + 1]!
      const b = img.data[o + 2]!
      bits[y * width + x] = isInk(r, g, b) ? 1 : 0
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      darkness[y * width + x] = Math.min(1, Math.max(0, (190 - luma) / 140))
    }
  return { width, height, bits, darkness }
}

const rowInk = (m: Mask, y: number, x0 = 0, x1 = m.width) => {
  let n = 0
  for (let x = x0; x < x1; x++) n += m.bits[y * m.width + x]!
  return n
}
const colInk = (m: Mask, x: number, y0: number, y1: number) => {
  let n = 0
  for (let y = y0; y < y1; y++) n += m.bits[y * m.width + x]!
  return n
}

/**
 * A copy of the mask without connected ink blobs taller than `factor` × the median blob
 * height, e.g. a logo next to two lines of text that would otherwise join them into one.
 */
export function withoutLargeBlobs(m: Mask, factor = 2.5): Mask {
  const { width, height } = m
  const label = new Int32Array(width * height).fill(-1)
  const blobs: { y0: number; y1: number; pixels: number[] }[] = []
  for (let i = 0; i < m.bits.length; i++) {
    if (!m.bits[i] || label[i] !== -1) continue
    const blob = { y0: height, y1: 0, pixels: [] as number[] }
    const stack = [i]
    label[i] = blobs.length
    while (stack.length) {
      const j = stack.pop()!
      blob.pixels.push(j)
      const x = j % width
      const y = (j - x) / width
      if (y < blob.y0) blob.y0 = y
      if (y + 1 > blob.y1) blob.y1 = y + 1
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const k = ny * width + nx
          if (m.bits[k] && label[k] === -1) {
            label[k] = blobs.length
            stack.push(k)
          }
        }
    }
    blobs.push(blob)
  }
  const heights = blobs.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] ?? 0
  const bits = m.bits.slice()
  const darkness = m.darkness.slice()
  for (const b of blobs)
    if (b.y1 - b.y0 > factor * median)
      for (const j of b.pixels) {
        bits[j] = 0
        darkness[j] = 0
      }
  return { width, height, bits, darkness }
}

/** Runs of consecutive indexes where `has(i)` is true, gaps up to `bridge` joined. */
function runs(length: number, has: (i: number) => boolean, bridge = 0): Span[] {
  const out: Span[] = []
  let start = -1
  let lastInk = -Infinity
  for (let i = 0; i <= length; i++) {
    const ink = i < length && has(i)
    if (ink) {
      if (start === -1 || i - lastInk - 1 > bridge) {
        if (start !== -1) out.push({ start, end: lastInk + 1 })
        start = i
      }
      lastInk = i
    }
  }
  if (start !== -1) out.push({ start, end: lastInk + 1 })
  return out
}

/** Text lines: bands of rows with ink, at least `minHeight` tall. */
export function textLines(m: Mask, minHeight = 5): Span[] {
  return runs(m.height, (y) => rowInk(m, y) > 0).filter((s) => s.end - s.start >= minHeight)
}

/** Glyphs of one line, left to right: column runs of ink, each trimmed to its own ink rows. */
export function lineGlyphs(m: Mask, line: Span): Box[] {
  return runs(m.width, (x) => colInk(m, x, line.start, line.end) > 0).map((s) => {
    const rows = runs(line.end - line.start, (i) => rowInk(m, line.start + i, s.start, s.end) > 0)
    return {
      x0: s.start,
      x1: s.end,
      y0: line.start + rows[0]!.start,
      y1: line.start + rows[rows.length - 1]!.end,
    }
  })
}

/** Number of separate vertical ink parts in a glyph (2 for ":"). */
export function verticalParts(m: Mask, g: Box): number {
  return runs(g.y1 - g.y0, (i) => rowInk(m, g.y0 + i, g.x0, g.x1) > 0).length
}

export const GLYPH_W = 10
export const GLYPH_H = 16

/**
 * Darkness of a glyph box resampled to GLYPH_W × GLYPH_H (area-weighted, so it behaves the
 * same for a 15 px and a 40 px tall glyph), values 0..1.
 */
export function glyphVector(m: Mask, g: Box): Float32Array {
  const out = new Float32Array(GLYPH_W * GLYPH_H)
  const w = g.x1 - g.x0
  const h = g.y1 - g.y0
  const sx = GLYPH_W / w
  const sy = GLYPH_H / h
  for (let y = g.y0; y < g.y1; y++) {
    // the pixel covers [y, y+1) → cells [cy0, cy1) in glyph space
    const fy0 = (y - g.y0) * sy
    const fy1 = fy0 + sy
    for (let x = g.x0; x < g.x1; x++) {
      const v = m.darkness[y * m.width + x]!
      if (!v) continue
      const fx0 = (x - g.x0) * sx
      const fx1 = fx0 + sx
      for (let cy = Math.floor(fy0); cy < Math.min(GLYPH_H, Math.ceil(fy1)); cy++) {
        const oy = Math.min(fy1, cy + 1) - Math.max(fy0, cy)
        for (let cx = Math.floor(fx0); cx < Math.min(GLYPH_W, Math.ceil(fx1)); cx++) {
          const ox = Math.min(fx1, cx + 1) - Math.max(fx0, cx)
          out[cy * GLYPH_W + cx]! += v * ox * oy
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i]!)
  return out
}

/**
 * Shape distance between two glyph vectors: 1 − normalized correlation, 0 (same) … 2. Ignores
 * overall darkness and stroke weight, which change with image size and JPEG quality.
 */
export function glyphDistance(a: Float32Array, b: Float32Array): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= n
  mb /= n
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    ab += x * y
    aa += x * x
    bb += y * y
  }
  return aa && bb ? 1 - ab / Math.sqrt(aa * bb) : 1
}
