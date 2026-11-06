import { pixel, type RgbaImage } from './png.js'

/**
 * Finds the cell grid of a schedule table in an image and reads cell colours. Tables are
 * located by their shape (a run of equal-sized cells separated by thin lines), not by fixed
 * coordinates, so small template changes or another image size don't break parsing.
 */

export type Rgb = [number, number, number]

/** [start, end) in pixels along one axis */
export interface Span {
  start: number
  end: number
}

export interface Grid {
  columns: Span[]
  rows: Span[]
}

const near = (a: Rgb, b: Rgb, tol: number) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol

/** Runs of uniform colour along a row (axis 'x') or column (axis 'y') at least `minLen` long. */
export function uniformRuns(
  img: RgbaImage,
  axis: 'x' | 'y',
  at: number,
  opts: { minLen?: number; tolerance?: number } = {},
): Span[] {
  const len = axis === 'x' ? img.width : img.height
  const minLen = opts.minLen ?? 8
  const tol = opts.tolerance ?? 14
  const get = (i: number) => (axis === 'x' ? pixel(img, i, at) : pixel(img, at, i))
  const out: Span[] = []
  let start = 0
  let ref = get(0)
  for (let i = 1; i <= len; i++) {
    const c = i < len ? get(i) : null
    if (!c || !near(c, ref, tol)) {
      if (i - start >= minLen) out.push({ start, end: i })
      if (c) {
        start = i
        ref = c
      }
    }
  }
  return out
}

/**
 * Maximal sequences of consecutive spans of nearly equal size separated by thin gaps:
 * the cells of one table row or column.
 */
export function regularSequences(
  spans: Span[],
  opts: { sizeTolerance?: number; maxGap?: number } = {},
): Span[][] {
  const tol = opts.sizeTolerance ?? 3
  const maxGap = opts.maxGap ?? 5
  const out: Span[][] = []
  let cur: Span[] = []
  const size = (s: Span) => s.end - s.start
  for (const s of spans) {
    const last = cur[cur.length - 1]
    if (last && s.start - last.end <= maxGap && Math.abs(size(s) - size(cur[0]!)) <= tol) cur.push(s)
    else {
      if (cur.length > 1) out.push(cur)
      cur = [s]
    }
  }
  if (cur.length > 1) out.push(cur)
  return out
}

/**
 * The `n` consecutive spans with the most even sizes. A detected run often picks up a
 * neighbour of similar size (the bottom of a header, blank space under the table); the real
 * cells are the most uniform window.
 */
export function bestWindow(seq: Span[], n: number): Span[] | null {
  if (seq.length < n) return null
  let best: Span[] | null = null
  let bestScore = Infinity
  for (let off = 0; off + n <= seq.length; off++) {
    const w = seq.slice(off, off + n)
    const sizes = w.map((s) => s.end - s.start)
    const mean = sizes.reduce((a, b) => a + b, 0) / n
    const score = sizes.reduce((a, b) => a + (b - mean) ** 2, 0)
    if (score < bestScore) {
      bestScore = score
      best = w
    }
  }
  return best
}

/**
 * Finds tables with `columns` equal time cells and `rows` equal group rows. Probes many
 * horizontal lines, keeps the column layout seen most often, then probes down the middle of
 * the first time column for the rows. Returns one grid per table found (top to bottom).
 */
export function findGrids(img: RgbaImage, columns: number, rows: number): Grid[] {
  // 1) column layout: the most common run of `columns` equal cells across probe rows
  const layouts = new Map<string, { cols: Span[]; hits: number }>()
  const step = Math.max(2, Math.floor(img.height / 400))
  for (let y = 0; y < img.height; y += step) {
    for (const seq of regularSequences(uniformRuns(img, 'x', y))) {
      const cols = bestWindow(seq, columns)
      if (!cols) continue
      const key = cols.map((c) => `${c.start >> 2}`).join(',')
      const e = layouts.get(key) ?? { cols, hits: 0 }
      e.hits++
      layouts.set(key, e)
    }
  }
  const best = [...layouts.values()].sort((a, b) => b.hits - a.hits)[0]
  if (!best) return []
  const cols = best.cols

  // 2) rows: probe down two time columns, keep sequences of exactly `rows` equal cells
  const probes = [cols[0]!, cols[Math.floor(cols.length / 2)]!].map((c) => Math.floor((c.start + c.end) / 2))
  const found = new Map<string, Span[]>()
  for (const x of probes)
    for (const seq of regularSequences(uniformRuns(img, 'y', x, { minLen: 6 }), { sizeTolerance: 4 })) {
      const r = bestWindow(seq, rows)
      if (r) found.set(`${r[0]!.start >> 2}`, r)
    }
  return [...found.values()]
    .sort((a, b) => a[0]!.start - b[0]!.start)
    .map((r) => ({ columns: cols, rows: r }))
}

/** Average colour of a small box around a point (smooths antialiasing and JPEG noise). */
export function sample(img: RgbaImage, x: number, y: number, radius = 2): Rgb {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const [pr, pg, pb] = pixel(img, x + dx, y + dy)
      r += pr
      g += pg
      b += pb
      n++
    }
  return [r / n, g / n, b / n]
}

/** Name of the closest palette colour, or null when nothing is within `maxDistance`. */
export function classify<K extends string>(c: Rgb, palette: Record<K, Rgb>, maxDistance = 40): K | null {
  let best: K | null = null
  let bestD = Infinity
  for (const [k, p] of Object.entries(palette) as [K, Rgb][]) {
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return bestD <= maxDistance ? best : null
}
