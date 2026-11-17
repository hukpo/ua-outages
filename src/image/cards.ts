import type { MinuteSlot } from '../schedule.js'
import { POSTER_MODEL } from './digit-model.js'
import { glyphDistance, inkMask, lineGlyphs, regions, textLines, withoutLargeBlobs } from './glyphs.js'
import type { Box, Mask, PixelTest } from './glyphs.js'
import type { RgbaImage } from './png.js'
import { GAP_VARIANCE, LINE_H, NOTE_H, NOTE_W, type Font, type PosterModel } from './template-codec.js'

/**
 * Reads "card" schedule posters: one coloured card per group, in reading order, each listing
 * its outage times as "HH:MM - HH:MM" lines (or a text like "відключень не прогнозується").
 *
 * No OCR. A text line is resampled to a fixed height and explained as a whole by the poster's
 * font: a dynamic program lays the pictures of "dd:dd-dd:dd" over the line, choosing every
 * digit and every position at once, so it doesn't matter that at Telegram's 471 px the digits
 * touch each other and the colons. Every line of a card has to be accounted for, every digit
 * has to beat its runner-up clearly, and the times have to make sense; anything else throws
 * instead of guessing.
 */

export interface CardLayout {
  /** Background colour of the cards */
  isCard: PixelTest
  /** Ink of the times inside the cards */
  isInk: PixelTest
  /** Ink of the date in the header above the cards */
  isHeaderInk: PixelTest
  /** Ink of a stamp next to the date that marks a re-issued poster ("ОНОВЛЕНИЙ") */
  isStamp?: PixelTest
  /** Expected number of cards */
  cards: number
}

export interface CardPoster {
  /** "YYYY-MM-DD" from the header, null when no date was read with confidence */
  date: string | null
  /**
   * The header word that looks most like a date, read without the limits: not to be trusted
   * alone, but enough to confirm a date known from elsewhere (the caption of the post)
   */
  dateGuess: string | null
  /** A stamp sits next to the date: the poster replaces an earlier one for the same day */
  stamped: boolean
  /** Per card in reading order: off intervals in minutes */
  cards: MinuteSlot[][]
}

// ---------------------------------------------------------------------------------------------
// A line of text as a fixed-height strip

/** Darkness of a line resampled so that its text is LINE_H rows tall; `data` row by row */
export interface Strip {
  width: number
  data: Float32Array
}

/** Bilinear darkness at a point; pixel centres are at +0.5 */
function sample(m: Mask, x: number, y: number): number {
  const fx = Math.min(m.width - 1, Math.max(0, x - 0.5))
  const fy = Math.min(m.height - 1, Math.max(0, y - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(m.width - 1, x0 + 1)
  const y1 = Math.min(m.height - 1, y0 + 1)
  const ax = fx - x0
  const ay = fy - y0
  const d = m.darkness
  return (
    (d[y0 * m.width + x0]! * (1 - ax) + d[y0 * m.width + x1]! * ax) * (1 - ay) +
    (d[y1 * m.width + x0]! * (1 - ax) + d[y1 * m.width + x1]! * ax) * ay
  )
}

/**
 * The rectangle [x0, x1) × [top, bottom) of the mask as a `width` × `height` picture: each
 * output pixel averages 3 × 3 interpolated samples, which serves a 12 px Telegram line (scaled
 * up) and a 38 px line of the original (scaled down) alike.
 */
function resample(
  m: Mask,
  x0: number,
  x1: number,
  top: number,
  bottom: number,
  width: number,
  height: number,
): Float32Array {
  const sx = (x1 - x0) / width
  const sy = (bottom - top) / height
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let j = 0; j < 3; j++)
        for (let i = 0; i < 3; i++)
          v += sample(m, x0 + (x + (i + 0.5) / 3) * sx, top + (y + (j + 0.5) / 3) * sy)
      data[y * width + x] = v / 9
    }
  return data
}

/** Columns [x0, x1) of the mask with the rows [top, bottom) (fractional) scaled to LINE_H */
export function lineStrip(m: Mask, x0: number, x1: number, top: number, bottom: number): Strip {
  const width = Math.max(1, Math.round(((x1 - x0) * LINE_H) / (bottom - top)))
  return { width, data: resample(m, x0, x1, top, bottom, width, LINE_H) }
}

/**
 * Top and bottom of the text in columns [x0, x1), looked for around rows [y0, y1), to a
 * fraction of a pixel: the first and last fully dark rows, moved out by how dark the
 * antialiased rows next to them are.
 */
export function textRows(
  m: Mask,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): { top: number; bottom: number } | null {
  const lo = Math.max(0, y0 - 2)
  const hi = Math.min(m.height, y1 + 2)
  // mean of the three darkest pixels of a row: one noisy pixel doesn't make a row "inked"
  const dark = (y: number) => {
    if (y < lo || y >= hi) return 0
    let a = 0
    let b = 0
    let c = 0
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(m.width, Math.ceil(x1)); x++) {
      const v = m.darkness[y * m.width + x]!
      if (v > a) [a, b, c] = [v, a, b]
      else if (v > b) [b, c] = [v, b]
      else if (v > c) c = v
    }
    return (a + b + c) / 3
  }
  let first = -1
  let last = -1
  for (let y = Math.max(lo, y0); y < Math.min(hi, y1); y++)
    if (dark(y) >= 0.8) {
      if (first === -1) first = y
      last = y
    }
  if (first === -1) return null
  return {
    top: first - Math.min(1, dark(first - 1) + dark(first - 2)),
    bottom: last + 1 + Math.min(1, dark(last + 1) + dark(last + 2)),
  }
}

// ---------------------------------------------------------------------------------------------
// Explaining a strip with a font

export interface Placement {
  ch: string
  /** First column of the character in the strip */
  x: number
  width: number
  /**
   * Mean squared difference to the template in units of each pixel's own variance: about 1
   * for a glyph like the ones the template was made from
   */
  cost: number
  /**
   * How much less likely the whole line gets with the best other character here (difference of
   * −2 log likelihood). Infinity where the pattern allows only one.
   */
  margin: number
}

export interface Decoded {
  text: string
  /** The same mean over everything from `start` on, glyphs and gaps */
  cost: number
  /** First column of the first character */
  start: number
  glyphs: Placement[]
}

export interface DecodeOptions {
  /** Most blank columns before each character of the pattern */
  gaps: readonly number[]
  /** Columns before the first character are not explained (an icon sits there) */
  freeStart?: boolean
  /** Most blank columns after the last character, default 3 */
  tail?: number
  /**
   * Columns a character may share with the one before it, default 0: the heavy digits of a
   * header date touch, and the antialiased edge of one lies in the first column of the next
   */
  overlap?: number
}

/**
 * Lays `pattern` (per position: the characters allowed there) over the strip in the most likely
 * way: every pixel is explained either by the template of a character (a Gaussian around its
 * average, per pixel) or as blank space between two characters. Characters the font lacks are not considered; null when the pattern
 * doesn't fit.
 */
export function decodeLine(
  strip: Strip,
  font: Font,
  pattern: readonly string[],
  opts: DecodeOptions,
): Decoded | null {
  const W = strip.width
  const K = pattern.length
  const tail = opts.tail ?? 3
  const overlap = opts.overlap ?? 0
  // columns [0, x) as blank space, and the squared part of it alone
  const blank = new Float64Array(W + 1)
  const ink = new Float64Array(W + 1)
  const blankBias = LINE_H * Math.log(GAP_VARIANCE)
  for (let x = 0; x < W; x++) {
    let s = 0
    for (let y = 0; y < LINE_H; y++) s += strip.data[y * W + x]! ** 2
    ink[x + 1] = ink[x]! + s / GAP_VARIANCE
    blank[x + 1] = ink[x + 1]! + (x + 1) * blankBias
  }
  // the characters of the pattern that the font has, each with its cost at every column
  const chars = [...new Set(pattern.join(''))].filter((ch) => font[ch])
  const widths = chars.map((ch) => font[ch]!.width)
  const match = chars.map((ch) => {
    const t = font[ch]!
    const costs = new Float64Array(W + 1).fill(Infinity)
    for (let x = 0; x + t.width <= W; x++) {
      let s = 0
      for (let y = 0; y < LINE_H; y++) {
        const o = y * W + x
        const p = y * t.width
        for (let i = 0; i < t.width; i++)
          s += t.weights[p + i]! * (strip.data[o + i]! - t.pixels[p + i]!) ** 2
      }
      costs[x] = s + t.bias
    }
    return costs
  })
  const allowed = pattern.map((set) => chars.flatMap((ch, c) => (set.includes(ch) ? [c] : [])))

  const N = W + 1
  // fwd[k][x]: least cost of the first k characters, the last of them ending at column x
  const fwd = new Float64Array((K + 1) * N).fill(Infinity)
  // what stands before the first character costs as much as clean blank space, whatever it is
  if (opts.freeStart) for (let x = 0; x < N; x++) fwd[x] = x * blankBias
  else fwd[0] = 0
  for (let k = 0; k < K; k++) {
    const from = k ? overlap : 0
    for (let x = 0; x < N; x++) {
      const base = fwd[k * N + x]!
      if (base === Infinity) continue
      for (let at = Math.max(0, x - from); at <= Math.min(W, x + opts.gaps[k]!); at++) {
        const before = base + (at > x ? blank[at]! - blank[x]! : 0)
        for (const c of allowed[k]!) {
          const end = at + widths[c]!
          if (end > W) continue
          const cost = before + match[c]![at]!
          if (cost < fwd[(k + 1) * N + end]!) fwd[(k + 1) * N + end] = cost
        }
      }
    }
  }
  // bwd[k][x]: least cost of characters k… and the tail, the one before them ending at x;
  // through[k][c]: least cost of a whole line that has character c at position k, and where
  const bwd = new Float64Array((K + 1) * N).fill(Infinity)
  for (let x = Math.max(0, W - tail); x < N; x++) bwd[K * N + x] = blank[W]! - blank[x]!
  const C = chars.length
  const through = new Float64Array(K * C).fill(Infinity)
  const where = new Int32Array(K * C)
  for (let k = K - 1; k >= 0; k--) {
    const from = k ? overlap : 0
    for (let x = 0; x < N; x++) {
      const before = fwd[k * N + x]!
      if (before === Infinity) continue
      let least = Infinity
      for (let at = Math.max(0, x - from); at <= Math.min(W, x + opts.gaps[k]!); at++) {
        const gap = at > x ? blank[at]! - blank[x]! : 0
        for (const c of allowed[k]!) {
          const end = at + widths[c]!
          if (end > W) continue
          const rest = gap + match[c]![at]! + bwd[(k + 1) * N + end]!
          if (rest < least) least = rest
          if (before + rest < through[k * C + c]!) {
            through[k * C + c] = before + rest
            where[k * C + c] = at
          }
        }
      }
      bwd[k * N + x] = least
    }
  }

  const glyphs: Placement[] = []
  for (let k = 0; k < K; k++) {
    let c = -1
    let second = Infinity
    let first = Infinity
    for (const i of allowed[k]!) {
      const v = through[k * C + i]!
      if (v < first) {
        second = first
        first = v
        c = i
      } else if (v < second) second = v
    }
    if (first === Infinity) return null
    const at = where[k * C + c]!
    const ch = chars[c]!
    const width = widths[c]!
    glyphs.push({
      ch,
      x: at,
      width,
      cost: (match[c]![at]! - font[ch]!.bias) / (width * LINE_H),
      margin: second - first,
    })
  }
  // the per-position winners come from one and the same best line unless two lines tie
  for (let k = 1; k < K; k++)
    if (glyphs[k]!.x < glyphs[k - 1]!.x + glyphs[k - 1]!.width - overlap) return null
  const start = glyphs[0]!.x
  // the squared parts alone: of the glyphs, and of the gaps (everything from `start` on that no glyph covers)
  let squares = ink[W]! - ink[start]!
  for (const g of glyphs) squares += g.cost * g.width * LINE_H - (ink[g.x + g.width]! - ink[g.x]!)
  return {
    text: glyphs.map((g) => g.ch).join(''),
    cost: squares / (Math.max(1, W - start) * LINE_H),
    start,
    glyphs,
  }
}

// ---------------------------------------------------------------------------------------------
// Time lines

const DIGITS = '0123456789'
/** "dd:dd-dd:dd" */
export const TIME_PATTERN: readonly string[] = [...'dd:dd-dd:dd'].map((c) => (c === 'd' ? DIGITS : c))
/** Blank columns allowed before each character: little inside a time, a space around the dash */
export const TIME_GAPS: readonly number[] = [0, 5, 5, 5, 5, 16, 16, 5, 5, 5, 5]
/** "dd.dd.dddd", and "d.dd.dddd": the first of November 2026 was written "1.11.2026" */
export const DATE_PATTERNS: readonly (readonly string[])[] = ['dd.dd.dddd', 'd.dd.dddd'].map((p) =>
  [...p].map((c) => (c === 'd' ? DIGITS : c)),
)
/** Blank columns allowed before each character of a date */
export const DATE_GAPS: readonly number[] = [2, 6, 6, 6, 6, 6, 6, 6, 6, 6]
export const DATE_OVERLAP = 2

/**
 * Limits of a confident reading, set from the labelled posters: `scripts/train-digits.ts --loo`
 * reads each with a model built without it and prints the worst values of the right readings
 * and the best of the wrong ones (the numbers below; the 566 px poster of 18.10.2026, which is
 * refused, left out). Costs are in units of the font's own variance: about 0.6 for a line of
 * the typography it was made from.
 */
export const LIMITS = {
  /**
   * A time line (its best cut) and each of its characters. Right readings: line up to 0.89,
   * character up to 2.63, digit margin from 150 but for a handful. No wrong reading passed.
   */
  time: { lineCost: 1.15, glyphCost: 2.8, margin: 100 },
  /**
   * The header date. Right: line up to 1.05, character up to 3.94, margin from 260. Wrong (a
   * digit that typography had shown on no other poster): character from 4.98, margin from 158.
   */
  date: { lineCost: 1.3, glyphCost: 4, margin: 200 },
  /**
   * Another cut of the same band that reads something else must cost this many times the best
   * one: 1.5 and more among the labelled lines
   */
  rival: 1.3,
  /**
   * A typography whose mean line cost is within this factor of the best one's is close enough
   * to be the poster's: it reads the poster too and must agree. The wrong one costs 1.25–2.5
   * times the right one among the labelled posters.
   */
  typography: 1.2,
  /** Columns before the first digit, i.e. the lightning icon and its gap: 29–47 seen */
  icon: [20, 56] as const,
  /** `glyphDistance` of a no-outages line to its template: worst seen 0.07; a time line is at 0.74+ */
  note: 0.3,
}

/** A row band of a card with ink in it, and the columns its ink spans */
export interface Band {
  start: number
  end: number
  x0: number
  x1: number
}

/**
 * The group's name ("4.1") at the top of a card: blue, but its outline and shadow are dark
 * enough to count as ink at some sizes. It is short, centred and above the times, while a time
 * line or a line of the no-outages text spans most of the card.
 */
const isLabel = (m: Mask, b: Band) =>
  b.x1 - b.x0 < 0.4 * m.width &&
  b.end < 0.3 * m.height &&
  Math.abs((b.x0 + b.x1) / 2 - m.width / 2) < 0.15 * m.width

function bandsOf(m: Mask, minHeight: number): Band[] {
  return textLines(m, minHeight)
    .map((line) => {
      const glyphs = lineGlyphs(m, line)
      return { ...line, x0: glyphs[0]!.x0, x1: glyphs[glyphs.length - 1]!.x1 }
    })
    .filter((b) => !isLabel(m, b))
}

/** Where the digits of a band are vertically: measured right of the (taller) icon */
export function bandRows(m: Mask, band: Band): { top: number; bottom: number } | null {
  return textRows(m, band.x0 + 0.4 * (band.x1 - band.x0), band.x1, band.start, band.end)
}

/**
 * Where exactly a line's text begins and ends vertically can't be measured to better than half
 * a pixel, which at Telegram size is 3% of its height: the band is cut out nine ways, at three
 * heights and three offsets, and the reader goes with the cut the font explains best.
 */
const HEIGHTS = [1, 0.96, 1.04]
const SHIFTS = [0, -0.025, 0.025]

/** The band as strips, the cut as measured first */
export function bandStrips(m: Mask, band: Band): Strip[] {
  const rows = bandRows(m, band)
  if (!rows) return []
  const mid = (rows.top + rows.bottom) / 2
  const h = rows.bottom - rows.top
  return HEIGHTS.flatMap((scale) =>
    SHIFTS.map((shift) => {
      const top = mid + shift * h - (scale * h) / 2
      // a pixel more on both sides: the antialiased edge of the first and last glyph
      return lineStrip(m, band.x0 - 1, band.x1 + 1, top, top + scale * h)
    }),
  )
}

export interface TimeLine {
  text: string
  decoded: Decoded
  /**
   * No other cut of the band that the font explains nearly as well reads another text. A cut
   * half a pixel off turns a "6" into a "5" or an "8" with full conviction, but explains the
   * line far worse than the right one.
   */
  agreed: boolean
}

type Limits = { lineCost: number; glyphCost: number; margin: number }

const confident = (d: Decoded, l: Limits = LIMITS.time) =>
  d.cost <= l.lineCost && d.glyphs.every((g) => g.cost <= l.glyphCost && g.margin >= l.margin)

const decodeTimeLine = (strip: Strip, font: Font) =>
  decodeLine(strip, font, TIME_PATTERN, { gaps: TIME_GAPS, freeStart: true })

/** The best-explained cut of a band as a time line in `font`, confident or not */
export function decodeTime(strips: readonly Strip[], font: Font): TimeLine | null {
  let best: Decoded | null = null
  const all: Decoded[] = []
  for (const strip of strips) {
    const d = decodeTimeLine(strip, font)
    if (!d) continue
    all.push(d)
    if (!best || d.cost < best.cost) best = d
  }
  if (!best) return null
  const { text, cost } = best
  return { text, decoded: best, agreed: all.every((d) => d.text === text || d.cost >= LIMITS.rival * cost) }
}

/** Why a line read by `decodeTime` can't be trusted, or null when it can */
function doubt(line: TimeLine | null): string | null {
  if (!line) return 'is not a time range'
  const d = line.decoded
  if (d.start < LIMITS.icon[0] || d.start > LIMITS.icon[1]) return 'is not a time range'
  if (!confident(d)) return `reads as "${line.text}" without confidence`
  if (!line.agreed) return `reads as "${line.text}" or as something else`
  return null
}

/** The band's ink as a NOTE_W × NOTE_H picture, and its width / height */
export function bandPicture(m: Mask, band: Band): { vector: Float32Array; aspect: number } {
  return {
    vector: resample(m, band.x0, band.x1, band.start, band.end, NOTE_W, NOTE_H),
    aspect: (band.x1 - band.x0) / (band.end - band.start),
  }
}

/** The bands are the lines of a card without outages ("відключень" / "не прогнозується") */
function isNote(m: Mask, bands: Band[], model: PosterModel): boolean {
  return Object.values(model.notes).some(
    (lines) =>
      lines.length === bands.length &&
      lines.every((t, i) => {
        const p = bandPicture(m, bands[i]!)
        return (
          Math.abs(Math.log(p.aspect / t.aspect)) < 0.2 && glyphDistance(p.vector, t.vector) <= LIMITS.note
        )
      }),
  )
}

function toMinutes(h: string, m: string): number | null {
  const hh = Number(h)
  const mm = Number(m)
  // the operator works in half hours (every time of the 29 labelled posters), its changes during
  // the day come at quarters; a minute like :08 is a misread
  if (hh > 23 || mm % 15) return null
  return hh * 60 + mm
}

function toSlot(text: string, card: number): MinuteSlot {
  const t = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(text)
  const from = t && toMinutes(t[1]!, t[2]!)
  let to = t && toMinutes(t[3]!, t[4]!)
  if (from === null || to === null || from === undefined || to === undefined || from === 1440)
    throw new Error(`card ${card}: "${text}" is not a time range`)
  if (to === 0) to = 1440
  if (to <= from) throw new Error(`card ${card}: time range "${text}" ends before it starts`)
  return { start: from, end: to, kind: 'off' }
}

function findCards(img: RgbaImage, layout: CardLayout): Box[] {
  const found = regions(img, layout.isCard, { minArea: (img.width * img.height) / (layout.cards * 8) })
  if (found.length !== layout.cards)
    throw new Error(
      `expected ${layout.cards} cards, found ${found.length}; the poster layout may have changed`,
    )
  return readingOrder(found)
}

/** The image has the cards of the layout: whether it is such a poster at all */
export function isCardPoster(img: RgbaImage, layout: CardLayout): boolean {
  return (
    regions(img, layout.isCard, { minArea: (img.width * img.height) / (layout.cards * 8) }).length ===
    layout.cards
  )
}

const minLineHeight = (card: Box) => Math.max(5, Math.round((card.y1 - card.y0) / 40))

/** Ink of every card with its text bands, in reading order: also what the model builder works on */
export function cardBands(img: RgbaImage, layout: CardLayout): { mask: Mask; bands: Band[] }[] {
  return findCards(img, layout).map((card) => {
    const mask = inkMask(img, card, layout.isInk)
    return { mask, bands: bandsOf(mask, minLineHeight(card)) }
  })
}

/**
 * A poster is set in one typography: the one that explains its time lines best, all of them
 * together, reads it. Every line of every card has to be accounted for (14.11.2026: a line the
 * old reader couldn't split into glyphs was skipped, and the card lost an outage), and another
 * typography that explains the poster nearly as well and reads all of it with confidence must
 * read the same.
 */
function readCards(img: RgbaImage, layout: CardLayout, model: PosterModel): MinuteSlot[][] {
  const cards = cardBands(img, layout)
  const lines: { card: number; strips: Strip[] }[] = []
  const notes = cards.map(({ mask, bands }, c) => {
    if (!bands.length) throw new Error(`card ${c + 1} is empty`)
    if (isNote(mask, bands, model)) return true
    for (const band of bands) lines.push({ card: c, strips: bandStrips(mask, band) })
    return false
  })
  const slots: MinuteSlot[][] = cards.map(() => [])
  if (!lines.length) return slots
  // which typography: by the cut of each line as measured, which is enough to tell them apart
  const ranked = Object.entries(model.times)
    .map(([name, font]) => {
      let cost = 0
      for (const l of lines) cost += (l.strips[0] && decodeTimeLine(l.strips[0], font)?.cost) ?? Infinity
      return { name, font, cost: cost / lines.length }
    })
    .sort((a, b) => a.cost - b.cost)
  const best = ranked[0]
  if (!best) throw new Error('the model has no typography')
  const read = lines.map((l) => decodeTime(l.strips, best.font))
  const texts: string[][] = cards.map(() => [])
  read.forEach((line, i) => {
    const n = lines[i]!.card + 1
    const why = doubt(line)
    if (why)
      throw new Error(
        `card ${n}: line ${texts[n - 1]!.length + 1} ${why} (neither is the card "відключень не прогнозується"; typography "${best.name}")`,
      )
    texts[n - 1]!.push(line!.text)
  })
  for (const other of ranked.slice(1)) {
    if (other.cost > LIMITS.typography * best.cost) break
    const theirs = lines.map((l) => decodeTime(l.strips, other.font))
    if (theirs.every((l) => !doubt(l)) && theirs.some((l, i) => l!.text !== read[i]!.text))
      throw new Error(`typographies "${best.name}" and "${other.name}" read different times`)
  }
  texts.forEach((card, c) => {
    if (notes[c]) return
    slots[c] = card.map((text) => toSlot(text, c + 1))
    for (let i = 1; i < card.length; i++)
      if (slots[c]![i]!.start < slots[c]![i - 1]!.end)
        throw new Error(`card ${c + 1}: "${card[i]}" starts before "${card[i - 1]}" ends`)
  })
  return slots
}

/** Cards sorted into reading order: rows top to bottom, then left to right. */
function readingOrder(cards: Box[]): Box[] {
  const h = Math.min(...cards.map((c) => c.y1 - c.y0))
  return [...cards].sort((a, b) => (Math.abs(a.y0 - b.y0) < h / 2 ? a.x0 - b.x0 : a.y0 - b.y0))
}

// ---------------------------------------------------------------------------------------------
// Header date

/** Glyphs split where the gap is wider than the glyphs are tall: separate texts on one band */
function words(boxes: Box[]): Box[][] {
  const out: Box[][] = []
  for (const b of boxes) {
    const last = out[out.length - 1]?.at(-1)
    const gap = last ? b.x0 - last.x1 : Infinity
    if (last && gap < Math.max(last.y1 - last.y0, b.y1 - b.y0)) out[out.length - 1]!.push(b)
    else out.push([b])
  }
  return out
}

/** Header words about as long as a date, each as a strip of its own height */
export function headerWords(img: RgbaImage, layout: CardLayout): { box: Box; strip: Strip }[] {
  const bottom = Math.min(...findCards(img, layout).map((c) => c.y0))
  // without the logo, which would join the lines next to it into one
  const m = withoutLargeBlobs(inkMask(img, { x0: 0, y0: 0, x1: img.width, y1: bottom }, layout.isHeaderInk))
  const out: { box: Box; strip: Strip }[] = []
  for (const line of textLines(m, Math.max(6, Math.round(img.height / 120))))
    for (const word of words(lineGlyphs(m, line))) {
      const box = {
        x0: word[0]!.x0,
        x1: word[word.length - 1]!.x1,
        y0: Math.min(...word.map((b) => b.y0)),
        y1: Math.max(...word.map((b) => b.y1)),
      }
      // "14.11.2026" is 4.5–5.5 times wider than tall
      const aspect = (box.x1 - box.x0) / (box.y1 - box.y0)
      if (aspect < 3.5 || aspect > 7) continue
      const rows = textRows(m, box.x0, box.x1, box.y0, box.y1)
      if (rows) out.push({ box, strip: lineStrip(m, box.x0 - 1, box.x1 + 1, rows.top, rows.bottom) })
    }
  return out
}

/** The word as a date in `font`, in the form of it that the font explains better */
export function decodeDate(strip: Strip, font: Font): Decoded | null {
  let best: Decoded | null = null
  for (const pattern of DATE_PATTERNS) {
    const d = decodeLine(strip, font, pattern, { gaps: DATE_GAPS, overlap: DATE_OVERLAP })
    if (d && (!best || d.cost < best.cost)) best = d
  }
  return best
}

/** "DD.MM.YYYY" in the header (the part of the image above the cards), and whether a stamp follows it */
function readHeader(
  img: RgbaImage,
  layout: CardLayout,
  model: PosterModel,
): Pick<CardPoster, 'date' | 'dateGuess' | 'stamped'> {
  const found: { date: string; box: Box }[] = []
  let guess: { date: string; cost: number; box: Box } | null = null
  // like the times: every typography that reads a word with confidence counts, and they must agree
  for (const { box, strip } of headerWords(img, layout))
    for (const font of Object.values(model.dates)) {
      const d = decodeDate(strip, font)
      if (!d) continue
      const [, day, month, year] = /^(\d\d?)\.(\d\d)\.(\d{4})$/.exec(d.text)!
      const date = `${year}-${month}-${day!.padStart(2, '0')}`
      // a real calendar date
      const t = new Date(`${date}T00:00:00Z`)
      if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== date) continue
      if (!guess || d.cost < guess.cost) guess = { date, cost: d.cost, box }
      if (confident(d, LIMITS.date)) found.push({ date, box })
    }
  const dateGuess = guess?.date ?? null
  // the stamp sits right of the date, on its rows
  const stamped = (box: Box) => {
    let stamp = 0
    if (layout.isStamp)
      for (let y = box.y0; y < box.y1; y++)
        for (let x = box.x1; x < img.width; x++) {
          const o = (y * img.width + x) * 4
          if (layout.isStamp(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!)) stamp++
        }
    // a word in letters as tall as the date: far more than the specks JPEG leaves around blue ink
    return stamp > (box.y1 - box.y0) ** 2 / 2
  }
  // a date that isn't read for sure still stands where the date stands: the caption of the post
  // may confirm it, and the poster is then a re-issue or not all the same
  if (new Set(found.map((f) => f.date)).size !== 1)
    return { date: null, dateGuess, stamped: !!guess && stamped(guess.box) }
  const { date, box } = found[0]!
  return { date, dateGuess, stamped: stamped(box) }
}

export function readCardPoster(
  img: RgbaImage,
  layout: CardLayout,
  model: PosterModel = POSTER_MODEL,
): CardPoster {
  return { ...readHeader(img, layout, model), cards: readCards(img, layout, model) }
}
