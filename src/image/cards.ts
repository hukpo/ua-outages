import type { MinuteSlot } from '../schedule.js'
import {
  glyphVector,
  inkMask,
  lineGlyphs,
  regions,
  textLines,
  verticalParts,
  withoutLargeBlobs,
} from './glyphs.js'
import type { Box, Mask, PixelTest } from './glyphs.js'
import type { RgbaImage } from './png.js'
import { DIGIT_MODEL } from './digit-model.js'
import { modelDistance } from './template-codec.js'

/**
 * Reads "card" schedule posters: one coloured card per group, in reading order, each listing
 * its outage times as "HH:MM - HH:MM" lines (or a text like "відключень не прогнозується").
 * Digits are recognised by template matching against the poster's font, so no OCR is
 * needed. Anything that doesn't read cleanly throws instead of guessing.
 */

export interface CardLayout {
  /** Background colour of the cards */
  isCard: PixelTest
  /** Ink of the times inside the cards */
  isInk: PixelTest
  /** Ink of the date in the header above the cards */
  isHeaderInk: PixelTest
  /** Expected number of cards */
  cards: number
}

export interface CardPoster {
  /** "YYYY-MM-DD" from the header, null when no date was found */
  date: string | null
  /** Per card in reading order: off intervals in minutes */
  cards: MinuteSlot[][]
}

/** Recognised glyph: a digit, ':', '-', '.', or '?' for anything else (letters, icons) */
type Glyph = { ch: string; box: Box }

/** Above this distance a glyph is not a digit of the poster font (typical 0.9, worst seen 2.5) */
const MAX_DISTANCE = 3.5
/** The runner-up digit must be at least this much further (smallest gap seen 0.15, typical 0.9) */
const MIN_MARGIN = 0.1

export function classifyDigit(m: Mask, box: Box): { digit: string | null; distance: number; margin: number } {
  const vector = glyphVector(m, box)
  const aspect = (box.x1 - box.x0) / (box.y1 - box.y0)
  let best: string | null = null
  let bestD = Infinity
  let second = Infinity
  for (const [digit, t] of Object.entries(DIGIT_MODEL.digits)) {
    const d = modelDistance(DIGIT_MODEL, t, vector, aspect)
    if (d < bestD) {
      second = bestD
      bestD = d
      best = digit
    } else if (d < second) second = d
  }
  const margin = second - bestD
  const ok = bestD <= MAX_DISTANCE && margin >= MIN_MARGIN
  return { digit: ok ? best : null, distance: bestD, margin }
}

/**
 * Glyphs of one text line by shape: ':' '-' '.', 'd' for a digit-sized glyph (not yet
 * recognised), '?' for anything else (letters of other sizes, icons).
 */
function lineShapes(m: Mask, line: { start: number; end: number }): Glyph[] {
  return shapes(m, lineGlyphs(m, line))
}

function shapes(m: Mask, glyphBoxes: Box[]): Glyph[] {
  // digit height: the median glyph height (icons are taller, punctuation shorter)
  const heights = glyphBoxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
  const H = heights[Math.floor(heights.length / 2)] ?? 0
  const boxes = splitTouching(m, glyphBoxes, H)
  // baseline: bottom of the digit-sized glyphs; a dash floats mid-height, a dot sits on it
  const bottoms = boxes
    .filter((b) => b.y1 - b.y0 >= 0.85 * H)
    .map((b) => b.y1)
    .sort((a, b) => a - b)
  const baseline = bottoms[Math.floor(bottoms.length / 2)] ?? 0
  return boxes.map((box) => {
    const h = box.y1 - box.y0
    const w = box.x1 - box.x0
    if (verticalParts(m, box) === 2 && h > 0.5 * H && h < 0.9 * H && w < 0.4 * H) return { ch: ':', box }
    if (h < 0.35 * H) return { ch: (box.y0 + box.y1) / 2 < baseline - 0.25 * H ? '-' : '.', box }
    if (h >= 0.85 * H && h <= 1.15 * H && w <= 0.8 * H) return { ch: 'd', box }
    return { ch: '?', box }
  })
}

/**
 * Bold fonts set tight make neighbouring digits touch ("07" as one blob). A digit-tall glyph
 * about as wide as two digits is cut at the column with the least ink near its middle.
 */
function splitTouching(m: Mask, boxes: Box[], H: number): Box[] {
  const digitTall = (b: Box) => b.y1 - b.y0 >= 0.85 * H && b.y1 - b.y0 <= 1.15 * H
  const widths = boxes
    .filter((b) => digitTall(b) && b.x1 - b.x0 <= 0.8 * H)
    .map((b) => b.x1 - b.x0)
    .sort((a, b) => a - b)
  const W = widths[Math.floor(widths.length / 2)]
  if (!W) return boxes
  return boxes.flatMap((b) => {
    const w = b.x1 - b.x0
    if (!digitTall(b) || w < 1.7 * W || w > 2.3 * W) return [b]
    let cut = -1
    let least = Infinity
    for (let x = Math.round(b.x0 + 0.35 * w); x <= Math.round(b.x0 + 0.65 * w); x++) {
      let ink = 0
      for (let y = b.y0; y < b.y1; y++) ink += m.bits[y * m.width + x]!
      if (ink < least) [least, cut] = [ink, x]
    }
    return [trimRows(m, { ...b, x1: cut }), trimRows(m, { ...b, x0: cut })]
  })
}

/** The box shrunk vertically to the rows that have ink in its columns */
function trimRows(m: Mask, b: Box): Box {
  let { y0, y1 } = b
  const rowHas = (y: number) => {
    for (let x = b.x0; x < b.x1; x++) if (m.bits[y * m.width + x]) return true
    return false
  }
  while (y0 < y1 && !rowHas(y0)) y0++
  while (y1 > y0 && !rowHas(y1 - 1)) y1--
  return { ...b, y0, y1 }
}

/** Recognises the digit-shaped glyphs ('?' when unsure). */
const recognise = (m: Mask, shapes: Glyph[]): Glyph[] =>
  shapes.map((g) => (g.ch === 'd' ? { ch: classifyDigit(m, g.box).digit ?? '?', box: g.box } : g))

/**
 * A time line has two colons between digit-sized glyphs; group labels and
 * "відключень не прогнозується" don't. Decided by shape, before reading any digit, so a
 * time line with an unreadable digit is reported rather than skipped.
 */
const isTimeLine = (shapes: Glyph[]) =>
  shapes.filter((g) => g.ch === ':').length >= 2 && shapes.filter((g) => g.ch === 'd').length >= 6

/** Digit-sized glyphs on both sides of a dash: a time line even if its colons were missed */
function looksLikeTimeRange(shapes: Glyph[]): boolean {
  const dash = shapes.findIndex((g) => g.ch === '-')
  if (dash === -1) return false
  const count = (gs: Glyph[]) => gs.filter((g) => g.ch === 'd').length
  return count(shapes.slice(0, dash)) >= 3 && count(shapes.slice(dash + 1)) >= 3
}

function findCards(img: RgbaImage, layout: CardLayout): Box[] {
  const found = regions(img, layout.isCard, { minArea: (img.width * img.height) / (layout.cards * 8) })
  if (found.length !== layout.cards)
    throw new Error(
      `expected ${layout.cards} cards, found ${found.length}; the poster layout may have changed`,
    )
  return readingOrder(found)
}

const minLineHeight = (card: Box) => Math.max(5, Math.round((card.y1 - card.y0) / 40))

/**
 * Unrecognised digit glyphs of every time line, per card: what the template builder
 * (scripts/train-digits.ts) pairs with known times.
 */
export function posterTimeGlyphs(img: RgbaImage, layout: CardLayout): { mask: Mask; lines: Box[][] }[] {
  return findCards(img, layout).map((card) => {
    const mask = inkMask(img, card, layout.isInk)
    const lines = textLines(mask, minLineHeight(card))
      .map((l) => lineShapes(mask, l))
      .filter(isTimeLine)
      .map((gs) => gs.filter((g) => g.ch === 'd').map((g) => g.box))
    return { mask, lines }
  })
}

const text = (glyphs: Glyph[]) => glyphs.map((g) => g.ch).join('')

const TIME_LINE = /(\d\d):(\d\d)-(\d\d):(\d\d)$/

function toMinutes(h: string, m: string): number | null {
  const hh = Number(h)
  const mm = Number(m)
  if (hh > 24 || mm > 59 || (hh === 24 && mm)) return null
  return hh * 60 + mm
}

/** Reads one card's off intervals. Throws on a line that looks like a time but doesn't parse. */
function readCard(img: RgbaImage, card: Box, layout: CardLayout, index: number): MinuteSlot[] {
  const m = inkMask(img, card, layout.isInk)
  const slots: MinuteSlot[] = []
  for (const line of textLines(m, minLineHeight(card))) {
    const shapes = lineShapes(m, line)
    if (!isTimeLine(shapes)) {
      if (looksLikeTimeRange(shapes))
        throw new Error(`card ${index + 1}: a line looks like a time range but its colons weren't found`)
      continue
    }
    const glyphs = recognise(m, shapes).filter((g) => g.ch !== '.')
    const s = text(glyphs)
    const t = TIME_LINE.exec(s)
    const from = t && toMinutes(t[1]!, t[2]!)
    let to = t && toMinutes(t[3]!, t[4]!)
    if (from === null || to === null || from === undefined || to === undefined)
      throw new Error(`card ${index + 1}: can't read the time line "${s}"`)
    if (to === 0) to = 1440
    if (to <= from) throw new Error(`card ${index + 1}: time range "${s}" ends before it starts`)
    slots.push({ start: from, end: to, kind: 'off' })
  }
  return slots
}

/** Cards sorted into reading order: rows top to bottom, then left to right. */
function readingOrder(cards: Box[]): Box[] {
  const h = Math.min(...cards.map((c) => c.y1 - c.y0))
  return [...cards].sort((a, b) => (Math.abs(a.y0 - b.y0) < h / 2 ? a.x0 - b.x0 : a.y0 - b.y0))
}

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

/** Header words that read as a date shape "dd.dd.dddd", with their digit glyphs */
function headerDateWords(
  img: RgbaImage,
  bottom: number,
  layout: CardLayout,
): { mask: Mask; glyphs: Glyph[] }[] {
  const m = withoutLargeBlobs(inkMask(img, { x0: 0, y0: 0, x1: img.width, y1: bottom }, layout.isHeaderInk))
  const out: { mask: Mask; glyphs: Glyph[] }[] = []
  for (const line of textLines(m, Math.max(6, Math.round(img.height / 120))))
    for (const word of words(lineGlyphs(m, line))) {
      const glyphs = shapes(m, word)
      if (/^d?d\.dd\.dddd$/.test(text(glyphs))) out.push({ mask: m, glyphs })
    }
  return out
}

/** Digit glyphs of the header date, for the template builder */
export function posterDateGlyphs(img: RgbaImage, layout: CardLayout): { mask: Mask; boxes: Box[] }[] {
  const top = Math.min(...findCards(img, layout).map((c) => c.y0))
  return headerDateWords(img, top, layout).map(({ mask, glyphs }) => ({
    mask,
    boxes: glyphs.filter((g) => g.ch === 'd').map((g) => g.box),
  }))
}

/** "DD.MM.YYYY" (or "D.MM.YYYY") anywhere in the header (the part of the image above the cards). */
function readHeaderDate(img: RgbaImage, bottom: number, layout: CardLayout): string | null {
  for (const { mask, glyphs } of headerDateWords(img, bottom, layout)) {
    const d = /^(\d{1,2})\.(\d\d)\.(\d{4})$/.exec(text(recognise(mask, glyphs)))
    if (d) return `${d[3]}-${d[2]}-${d[1]!.padStart(2, '0')}`
  }
  return null
}

export function readCardPoster(img: RgbaImage, layout: CardLayout): CardPoster {
  const cards = findCards(img, layout)
  const top = Math.min(...cards.map((c) => c.y0))
  return {
    date: readHeaderDate(img, top, layout),
    cards: cards.map((c, i) => readCard(img, c, layout, i)),
  }
}
