import type { IntervalKind } from '../types.js'
import type { Rgb } from './grid.js'
import { pixel, type RgbaImage } from './png.js'

/**
 * Reader of the Zakarpattiaoblenergo schedule picture: one wide table, a row per sub-queue
 * (1-1 … 6-2) and a header cell per half-hour (00:00 … 23:30). The two columns on the left
 * name the queue and the sub-queue on the queue's colour; a half-hour without power is filled
 * with that same colour, one with power is white. The picture has no legend: that the colour
 * is "off" follows from the pictures themselves (17.10.2026: one coloured two-hour block per
 * sub-queue of queues 1–3 and nothing else).
 *
 * Nothing is placed by fixed fractions of the picture. The rows are the twelve coloured cells
 * of the sub-queue column, as its rulings cut them (the rulings across the body are too faint
 * in places after Telegram's downscaling: between queues they are double lines two pixels
 * apart). The body is ruled only at the hours, so the half-hour columns come from the header,
 * where every cell has its own line. Telegram
 * serves it 800 px wide (a column is ~15 px) as a JPEG, so each cell is judged on its inner
 * part only and must be plainly white or plainly its row's colour: anything else throws, as
 * does a table that isn't 12 rows by 48 columns.
 */

/** Rows × half-hours of the table */
const ROWS = 12
const COLUMNS = 48
/** A ruling is darker than what is two pixels to either side of it by at least this much */
const LINE_CONTRAST = 30
/** Share of the header band that a ruling between two half-hours must cross */
const HEADER_COVER = 0.9
/** Channels of a white cell stay above this (JPEG ringing next to a ruling included) */
const WHITE_MIN = 215
/** A queue colour has at least this spread between its channels: white and grey have none */
const COLOUR_SPREAD = 60
/** The brightest channel of a filled cell is at least this; of a ruling drawn over it, less */
const FILL_MIN = 185
/** Distance within which a pixel is its row's colour */
const COLOUR_NEAR = 70
/** Share of a cell's inner pixels that must agree */
const CELL_AGREE = 0.85

const lum = (img: RgbaImage, x: number, y: number) => {
  const [r, g, b] = pixel(img, x, y)
  return (r + g + b) / 3
}
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * Centres of the rulings that cross a band: positions along `axis` where at least `cover` of
 * the band's pixels are darker than both neighbours two pixels away. A ruling blurred over two
 * pixels gives one centre between them.
 */
function rulings(
  img: RgbaImage,
  axis: 'x' | 'y',
  band: { from: number; to: number },
  cover: number,
): number[] {
  const len = axis === 'x' ? img.width : img.height
  const at = (i: number, j: number) => (axis === 'x' ? lum(img, i, j) : lum(img, j, i))
  const score: number[] = new Array<number>(len).fill(0)
  const span = band.to - band.from
  for (let i = 2; i < len - 2; i++) {
    let n = 0
    for (let j = band.from; j < band.to; j++)
      if (at(i, j) < Math.min(at(i - 2, j), at(i + 2, j)) - LINE_CONTRAST) n++
    score[i] = n / span
  }
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    if (score[i]! < cover) continue
    let sum = 0
    let weight = 0
    let j = i
    for (; j < len && score[j]! >= cover; j++) {
      sum += j * score[j]!
      weight += score[j]!
    }
    out.push(sum / weight)
    i = j
  }
  return out
}

/**
 * The run of `n + 1` evenly spaced rulings among `lines`: the edges of `n` equal cells. Every
 * edge must be there, and only one such run may exist.
 */
function evenRun(lines: number[], n: number): number[] | null {
  const found: number[][] = []
  for (let a = 0; a < lines.length; a++)
    for (let b = lines.length - 1; b > a; b--) {
      const step = (lines[b]! - lines[a]!) / n
      if (step < 4) break
      const tol = Math.max(1.5, step * 0.15)
      const run: number[] = []
      for (let k = 0; k <= n; k++) {
        const want = lines[a]! + k * step
        const hit = lines.find((x) => Math.abs(x - want) <= tol)
        if (hit === undefined) break
        run.push(hit)
      }
      if (run.length === n + 1 && new Set(run).size === n + 1) found.push(run)
    }
  // the same run found from a neighbouring ruling of a double line is still one run
  const distinct = found.filter(
    (run, i) => !found.slice(0, i).some((other) => other.every((x, k) => Math.abs(x - run[k]!) <= 3)),
  )
  return distinct.length === 1 ? distinct[0]! : null
}

/**
 * Reads the picture into 12 rows of 48 half-hour cells (`off` or `null` = power on), rows in
 * the order 1.1 … 6.2. Throws an `Error` naming what is wrong when the picture isn't this table
 * or a cell isn't clearly white or its row's colour.
 */
export function readQueueColourTable(img: RgbaImage): (IntervalKind | null)[][] {
  if (img.width < 400 || img.width < img.height * 2) throw new Error('not a wide table picture')

  // rows: the sub-queue column on the left holds twelve cells filled with the queues' colours,
  // each closed by the table's rulings. A pixel column that crosses exactly those twelve (not
  // the digits in them, not the queue column with its six tall cells) gives their edges
  const columns: Run[][] = []
  for (let x = 0; x < img.width * 0.2; x++) {
    const runs = colouredRuns(img, x)
    const size = runs[0] ? runs[0].bottom - runs[0].top : 0
    if (runs.length === ROWS && size >= 6 && runs.every((r) => Math.abs(r.bottom - r.top - size) <= 3))
      columns.push(runs)
  }
  if (columns.length < 4) throw new Error(`no column of ${ROWS} coloured sub-queue cells on the left`)
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const top = median(columns.map((c) => c[i]!.top))
    const bottom = median(columns.map((c) => c[i]!.bottom))
    return { top, bottom, size: bottom - top }
  })
  const rowHeight = rows.reduce((a, r) => a + r.size, 0) / ROWS
  // the header cells (one per half-hour, taller than two rows) end where the first row starts
  const header = { top: rows[0]!.top - rowHeight * 2, bottom: rows[0]!.top - 3 }
  if (header.top < 0) throw new Error('no header row above the table')

  // columns: every half-hour has its own cell in the header
  const xs = rulings(
    img,
    'x',
    { from: Math.ceil(header.top + 2), to: Math.floor(header.bottom - 1) },
    HEADER_COVER,
  )
  const edges = evenRun(xs, COLUMNS)
  if (!edges) throw new Error(`no ${COLUMNS} equal header cells found (${xs.length} vertical lines)`)
  const cell = (edges[COLUMNS]! - edges[0]!) / COLUMNS
  if (cell < 8) throw new Error(`cells of ${cell.toFixed(1)} px are too small to read`)

  // the sub-queue column is the one just left of the time cells; its cells carry the row colour
  const left = xs.filter((x) => x < edges[0]! - cell * 0.5)
  const [labelFrom, labelTo] = left.slice(-2) as [number | undefined, number | undefined]
  if (labelFrom === undefined || labelTo === undefined) throw new Error('no label columns left of the table')
  // beside the centred "1-1", not on it
  const labelX = Math.round(labelFrom + (labelTo - labelFrom) * 0.15)
  const colours = rows.map((r, i) => {
    const c = mean(img, labelX - 1, labelX + 1, r.top + r.size * 0.3, r.bottom - r.size * 0.3)
    if (Math.max(...c) - Math.min(...c) < COLOUR_SPREAD)
      throw new Error(`row ${i + 1} has no queue colour: rgb(${c.map(Math.round).join(',')})`)
    return c
  })
  // six queues of two rows each, every queue its own colour
  for (let q = 0; q < ROWS / 2; q++) {
    if (distance(colours[q * 2]!, colours[q * 2 + 1]!) > 40)
      throw new Error(`rows ${q * 2 + 1} and ${q * 2 + 2} aren't one queue's colour`)
    for (let o = 0; o < q; o++)
      if (distance(colours[q * 2]!, colours[o * 2]!) < 40)
        throw new Error(`queues ${o + 1} and ${q + 1} have the same colour`)
  }

  return rows.map((r, i) => {
    const y0 = Math.ceil(r.top + r.size * 0.25)
    const y1 = Math.floor(r.bottom - r.size * 0.25)
    const out: (IntervalKind | null)[] = []
    for (let c = 0; c < COLUMNS; c++) {
      const w = edges[c + 1]! - edges[c]!
      const x0 = Math.ceil(edges[c]! + w * 0.25)
      const x1 = Math.floor(edges[c + 1]! - w * 0.25)
      let white = 0
      let coloured = 0
      let n = 0
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const p = pixel(img, x, y)
          n++
          if (Math.min(...p) >= WHITE_MIN) white++
          else if (distance(p, colours[i]!) <= COLOUR_NEAR) coloured++
        }
      if (white >= n * CELL_AGREE) out.push(null)
      else if (coloured >= n * CELL_AGREE) out.push('off')
      else
        throw new Error(
          `cell ${c + 1} of row ${i + 1} is neither white nor the row's colour (${white} white, ${coloured} coloured of ${n} px)`,
        )
    }
    return out
  })
}

interface Run {
  /** First pixel row of the run, and the one after its last */
  top: number
  bottom: number
}

/** Vertical runs of saturated pixels in one pixel column */
function colouredRuns(img: RgbaImage, x: number): Run[] {
  const out: Run[] = []
  let top = -1
  for (let y = 0; y <= img.height; y++) {
    const p = y < img.height ? pixel(img, x, y) : null
    // a ruling over a colour keeps the hue but is dark
    const max = p ? Math.max(p[0], p[1], p[2]) : 0
    const on = !!p && max >= FILL_MIN && max - Math.min(p[0], p[1], p[2]) >= COLOUR_SPREAD
    if (on && top === -1) top = y
    else if (!on && top !== -1) {
      out.push({ top, bottom: y })
      top = -1
    }
  }
  return out
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Mean colour of a box (inclusive pixel bounds) */
function mean(img: RgbaImage, x0: number, x1: number, y0: number, y1: number): Rgb {
  const sum: Rgb = [0, 0, 0]
  let n = 0
  for (let y = Math.ceil(y0); y <= Math.floor(y1); y++)
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
      const p = pixel(img, x, y)
      sum[0] += p[0]
      sum[1] += p[1]
      sum[2] += p[2]
      n++
    }
  return [sum[0] / n, sum[1] / n, sum[2] / n]
}
