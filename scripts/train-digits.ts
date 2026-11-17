/**
 * Builds the font model (src/image/digit-model.ts) the poster reader matches against, from
 * labelled posters in test/fixtures/chernihiv/posters (labels.json: file → date, the times on
 * each card, and the names of the typography of its time lines and of its date). Rerun after
 * adding posters; when the operator changes a font, give the new posters a new name there.
 *
 *   npx tsx scripts/train-digits.ts           rebuild the model
 *   npx tsx scripts/train-digits.ts --check   read every labelled poster and compare
 *   npx tsx scripts/train-digits.ts --loo     the same, each poster read by a model built without it,
 *                                             then how sure the right readings were (for LIMITS)
 *   npx tsx scripts/train-digits.ts --dump a.jpg …   print what the reader sees, for labelling
 *
 * How it learns: lines whose characters stand apart (every line of the 1200 px original, some
 * at Telegram size) are cut at the gaps and give the first templates; then every labelled line
 * is aligned to its known text with those templates, and the templates are made again from
 * where the characters were found, three times over.
 *
 * If the model's format changed and the old file no longer loads, empty it first:
 * `export const POSTER_MODEL = decodeModel({ times: {}, dates: {}, notes: {} })`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DATE_GAPS,
  DATE_OVERLAP,
  TIME_GAPS,
  bandPicture,
  bandStrips,
  cardBands,
  decodeDate,
  decodeLine,
  decodeTime,
  headerWords,
  readCardPoster,
  type Decoded,
  type Strip,
} from '../src/image/cards.js'
import { glyphDistance } from '../src/image/glyphs.js'
import { decodeJpeg } from '../src/image/jpeg.js'
import type { RgbaImage } from '../src/image/png.js'
import {
  LINE_H,
  encodeModel,
  makeTemplate,
  mean,
  type Font,
  type GlyphTemplate,
  type LineTemplate,
  type PosterModel,
} from '../src/image/template-codec.js'
import { CHERNIHIV_POSTER } from '../src/providers/chernihiv.js'

const DIR = 'test/fixtures/chernihiv/posters'
/** `header`: the date as the poster writes it, when not DD.MM.YYYY */
type Label = { date: string; cards: string[]; times: string; dates: string; header?: string }
const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8')) as Record<string, Label>
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const cardText = (slots: { start: number; end: number }[]) =>
  slots.map((s) => `${fmt(s.start)}-${s.end === 1440 ? '00:00' : fmt(s.end)}`).join(' ')
const images = new Map<string, RgbaImage>()
const image = (file: string) => {
  if (!images.has(file)) images.set(file, decodeJpeg(readFileSync(join(DIR, file))))
  return images.get(file)!
}

/** A labelled line: the cuts of its band (the first as measured) and its text */
interface Sample {
  strips: Strip[]
  text: string
  /** Leading ink runs that aren't text (the icon of a time line) */
  skip: number
}
type Run = { x0: number; x1: number }

/** Column runs of the strip that hold ink darker than `threshold` */
function runs(strip: Strip, threshold: number): Run[] {
  const out: Run[] = []
  let start = -1
  for (let x = 0; x <= strip.width; x++) {
    let ink = false
    if (x < strip.width)
      for (let y = 0; y < LINE_H; y++) if (strip.data[y * strip.width + x]! > threshold) ink = true
    if (ink && start === -1) start = x
    if (!ink && start !== -1) {
      out.push({ x0: start, x1: x })
      start = -1
    }
  }
  return out
}

/**
 * The strip's ink as `count` characters after `skip` leading runs, or null. Touching
 * characters come apart at a stricter threshold; if they still don't, the widest run is two of
 * them (a bold "07") and is cut at its thinnest column near the middle. The cuts only start
 * the templates off; `refit` settles them.
 */
function cuts(strip: Strip, skip: number, count: number): Run[] | null {
  for (const threshold of [0.35, 0.5, 0.65, 0.8]) {
    const found = runs(strip, threshold).slice(skip)
    // the stricter threshold shaved the antialiased edge off both sides
    const pad = threshold > 0.5 ? 1 : 0
    if (found.length === count) return found.map((r) => ({ x0: r.x0 - pad, x1: r.x1 + pad }))
  }
  const out = runs(strip, 0.35).slice(skip)
  if (out.length > count || out.length < count - 2) return null
  while (out.length < count) {
    const i = out.reduce((best, r, j) => (r.x1 - r.x0 > out[best]!.x1 - out[best]!.x0 ? j : best), 0)
    const { x0, x1 } = out[i]!
    let cut = -1
    let least = Infinity
    for (let x = Math.round(x0 + 0.35 * (x1 - x0)); x <= Math.round(x0 + 0.65 * (x1 - x0)); x++) {
      let ink = 0
      for (let y = 0; y < LINE_H; y++) ink += strip.data[y * strip.width + x]!
      if (ink < least) [least, cut] = [ink, x]
    }
    out.splice(i, 1, { x0, x1: cut }, { x0: cut + 1, x1 })
  }
  return out
}

/** The time lines of a poster with their labels, card by card */
function timeLines(file: string): { card: number; strips: Strip[]; text: string }[] {
  const out: { card: number; strips: Strip[]; text: string }[] = []
  cardBands(image(file), CHERNIHIV_POSTER).forEach(({ mask, bands }, i) => {
    const times = labels[file]!.cards[i]!.split(' ').filter(Boolean)
    if (!times.length) return
    if (times.length !== bands.length)
      throw new Error(`${file} card ${i + 1}: ${bands.length} lines, the label has ${times.length}`)
    bands.forEach((band, j) => {
      const strips = bandStrips(mask, band)
      if (!strips.length) throw new Error(`${file} card ${i + 1} line ${j + 1}: no text rows`)
      out.push({ card: i + 1, strips, text: times[j]! })
    })
  })
  return out
}

/** Every header word that could be the date: the one that aligns best with the label is it */
const headerDate = (file: string) => {
  const [y, m, d] = labels[file]!.date.split('-')
  return labels[file]!.header ?? `${d}.${m}.${y}`
}

function dateCandidates(file: string): Sample[] {
  return headerWords(image(file), CHERNIHIV_POSTER).map(({ strip }) => ({
    strips: [strip],
    text: headerDate(file),
    skip: 0,
  }))
}

const window = (strip: Strip, x: number, width: number) => {
  const out = new Float32Array(width * LINE_H)
  for (let y = 0; y < LINE_H; y++)
    for (let i = 0; i < width; i++)
      out[y * width + i] = x + i >= 0 && x + i < strip.width ? strip.data[y * strip.width + x + i]! : 0
  return out
}

/** Spread given to every pixel of a template before its samples have been aligned */
const LOOSE = 0.2

const loose = (width: number, pixels: Float32Array) =>
  makeTemplate(width, pixels, new Float32Array(width * LINE_H).fill(LOOSE))

/**
 * Template of a character from its samples. The spread of a pixel is pulled towards `prior`
 * as if three more samples had shown it: two samples that happen to agree prove little.
 */
function template(width: number, samples: Float32Array[], prior: number): GlyphTemplate {
  const pixels = mean(samples)
  const spread = new Float32Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    let v = 3 * prior ** 2
    for (const s of samples) v += (s[i]! - pixels[i]!) ** 2
    spread[i] = Math.sqrt(v / (samples.length + 3))
  }
  return makeTemplate(width, pixels, spread)
}

/**
 * The digits that are easy to take for one another get one width, so that choosing between
 * them compares the same columns ("1" and "4" are plainly narrower and wider).
 */
const SAME_WIDTH = '02356789'

/** The template cropped or padded with blank columns to `width`, centred */
function fit(t: GlyphTemplate, width: number): GlyphTemplate {
  if (t.width === width) return t
  const pixels = new Float32Array(width * LINE_H)
  const shift = Math.round((width - t.width) / 2)
  for (let y = 0; y < LINE_H; y++)
    for (let x = 0; x < t.width; x++)
      if (x + shift >= 0 && x + shift < width) pixels[y * width + x + shift] = t.pixels[y * t.width + x]!
  return loose(width, pixels)
}

/** First templates: characters cut at the gaps, at the median width of their kind */
function cutFont(samples: Sample[]): Font {
  const boxes: Record<string, (Run & { strip: Strip })[]> = {}
  for (const s of samples) {
    const strip = s.strips[0]!
    cuts(strip, s.skip, s.text.length)?.forEach((c, k) => (boxes[s.text[k]!] ??= []).push({ strip, ...c }))
  }
  const widths: Record<string, number> = {}
  for (const [ch, list] of Object.entries(boxes)) {
    const sorted = list.map((b) => b.x1 - b.x0).sort((a, b) => a - b)
    widths[ch] = sorted[Math.floor(sorted.length / 2)]!
  }
  const common = Math.max(0, ...[...SAME_WIDTH].map((ch) => widths[ch] ?? 0))
  const font: Font = {}
  for (const [ch, list] of Object.entries(boxes)) {
    const near = list.filter((b) => Math.abs(b.x1 - b.x0 - widths[ch]!) <= 1)
    const width = SAME_WIDTH.includes(ch) ? common : widths[ch]!
    font[ch] = loose(
      width,
      mean(near.map((b) => window(b.strip, Math.round((b.x0 + b.x1 - width) / 2), width))),
    )
  }
  return font
}

/** The line aligned to its known text: the cut of its band that the font explains best */
function align(s: Sample, font: Font, gaps: readonly number[]): { strip: Strip; d: Decoded } | null {
  const overlap = gaps === DATE_GAPS ? DATE_OVERLAP : 0
  let best: { strip: Strip; d: Decoded } | null = null
  for (const strip of s.strips) {
    const d = decodeLine(strip, font, [...s.text], { gaps, freeStart: s.skip > 0, overlap })
    if (d && (!best || d.cost < best.d.cost)) best = { strip, d }
  }
  return best
}

/**
 * Templates made again from where each character of each line aligns best. `lines` holds, per
 * line, its candidates (header words): the one that fits the text best is the text.
 */
function refit(font: Font, lines: Sample[][], gaps: readonly number[]): Font {
  const windows: Record<string, Float32Array[]> = {}
  for (const candidates of lines) {
    let best: { strip: Strip; d: Decoded } | null = null
    for (const s of candidates) {
      const a = align(s, font, gaps)
      if (a && (!best || a.d.cost < best.d.cost)) best = a
    }
    if (!best) continue
    for (const g of best.d.glyphs) (windows[g.ch] ??= []).push(window(best.strip, g.x, g.width))
  }
  // the typical spread of a pixel in this typography
  let sum = 0
  let n = 0
  for (const list of Object.values(windows)) {
    const m = mean(list)
    for (const w of list) for (let i = 0; i < m.length; i++) sum += (w[i]! - m[i]!) ** 2
    n += list.length * m.length
  }
  const prior = n ? Math.sqrt(sum / n) : LOOSE
  const out: Font = {}
  for (const [ch, t] of Object.entries(font))
    out[ch] = windows[ch] ? template(t.width, windows[ch], prior) : t
  return out
}

/** One font per typography; a character a typography never shows is borrowed from another one */
function trainFonts(byStyle: Record<string, Sample[][]>, gaps: readonly number[], quiet: boolean) {
  const first: Record<string, Font> = {}
  for (const [style, lines] of Object.entries(byStyle)) first[style] = cutFont(lines.flat())
  const fonts: Record<string, Font> = {}
  for (const [style, lines] of Object.entries(byStyle)) {
    let font = { ...first[style]! }
    const own = [...SAME_WIDTH].map((c) => font[c]).find((t) => t)
    const borrowed: string[] = []
    for (const other of Object.values(first))
      for (const [ch, t] of Object.entries(other))
        if (!font[ch]) {
          font[ch] = own && SAME_WIDTH.includes(ch) ? fit(t, own.width) : t
          borrowed.push(ch)
        }
    for (let i = 0; i < 3; i++) font = refit(font, lines, gaps)
    const seen = new Set(lines.flat().flatMap((s) => [...s.text]))
    // a character this typography never showed can't be read in it: a line with one fails loudly
    const unseen = borrowed.filter((ch) => !seen.has(ch))
    for (const ch of unseen) delete font[ch]
    if (unseen.length && !quiet) console.log(`"${style}" never shows ${unseen.join(' ')}: it can't read them`)
    fonts[style] = Object.fromEntries(Object.entries(font).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
  return fonts
}

function train(files: string[], quiet = false): PosterModel {
  const group = (key: 'times' | 'dates') => {
    const out: Record<string, string[]> = {}
    for (const f of files) (out[labels[f]![key]] ??= []).push(f)
    return out
  }
  const map = <T>(o: Record<string, string[]>, f: (file: string) => T[]) =>
    Object.fromEntries(Object.entries(o).map(([style, list]) => [style, list.flatMap(f)]))
  const model: PosterModel = {
    times: trainFonts(
      map(group('times'), (f) => timeLines(f).map((l) => [{ strips: l.strips, text: l.text, skip: 1 }])),
      TIME_GAPS,
      quiet,
    ),
    dates: trainFonts(
      map(group('dates'), (f) => [dateCandidates(f)]),
      DATE_GAPS,
      quiet,
    ),
    notes: {},
  }
  for (const [style, list] of Object.entries(group('times'))) {
    const notes: { vector: Float32Array; aspect: number }[][] = []
    for (const f of list)
      cardBands(image(f), CHERNIHIV_POSTER).forEach(({ mask, bands }, i) => {
        if (labels[f]!.cards[i]) return
        bands.forEach((b, j) => (notes[j] ??= []).push(bandPicture(mask, b)))
      })
    if (notes.length)
      model.notes[style] = notes.map((samples): LineTemplate => ({
        vector: mean(samples.map((p) => p.vector)),
        aspect: samples.reduce((s, p) => s + p.aspect, 0) / samples.length,
      }))
  }
  return model
}

function check(file: string, model: PosterModel): string[] {
  const want = labels[file]!
  try {
    const p = readCardPoster(image(file), CHERNIHIV_POSTER, model)
    const got = p.cards.map(cardText)
    const diffs = got.flatMap((g, i) =>
      g === want.cards[i] ? [] : [`WRONG card ${i + 1}: ${g} ≠ ${want.cards[i]}`],
    )
    if (p.date !== want.date) diffs.push(`${p.date ? 'WRONG ' : ''}date ${p.date} ≠ ${want.date}`)
    return diffs
  } catch (e) {
    return [(e as Error).message]
  }
}

const args = process.argv.slice(2)
const files = Object.keys(labels)
if (args[0] === '--dump') {
  for (const f of args.slice(1)) {
    try {
      const p = readCardPoster(decodeJpeg(readFileSync(f)), CHERNIHIV_POSTER)
      console.log(JSON.stringify({ [f]: { date: p.date, stamped: p.stamped, cards: p.cards.map(cardText) } }))
    } catch (e) {
      console.log(f, 'ERROR', (e as Error).message)
    }
  }
} else if (args[0] === '--check' || args[0] === '--loo') {
  const { POSTER_MODEL } = await import('../src/image/digit-model.js')
  let bad = 0
  /** Every time line and date read without the limits, by the typography of its label */
  const lines: Record<string, unknown>[] = []
  // `--loo a.jpg b.jpg`: only these
  for (const file of args.length > 1 ? args.slice(1) : files) {
    const model =
      args[0] === '--loo'
        ? train(
            files.filter((f) => f !== file),
            true,
          )
        : POSTER_MODEL
    const diffs = check(file, model)
    if (diffs.length) bad++
    console.log(diffs.length ? '✗' : '✓', file, diffs.join('; '))
    const stats = (kind: string, want: string, d: Decoded | null | undefined, agreed: boolean) =>
      lines.push({
        file,
        kind,
        want,
        text: d?.text,
        ok: d?.text === want,
        agreed,
        line: d?.cost,
        glyph: d && Math.max(...d.glyphs.map((g) => g.cost)),
        margin: d && Math.min(...d.glyphs.map((g) => g.margin)),
        start: d?.start,
        gaps: d?.glyphs.map((g, k) => (k ? g.x - d.glyphs[k - 1]!.x - d.glyphs[k - 1]!.width : 0)),
      })
    const font = model.times[labels[file]!.times]
    if (font)
      for (const l of timeLines(file)) {
        const t = decodeTime(l.strips, font)
        stats('time', l.text, t?.decoded, t?.agreed ?? false)
      }
    const dateFont = model.dates[labels[file]!.dates]
    const dates = headerWords(image(file), CHERNIHIV_POSTER)
      .map(({ strip }) => (dateFont ? decodeDate(strip, dateFont) : null))
      .filter((x) => x !== null)
      .sort((a, b) => a.cost - b.cost)
    stats('date', headerDate(file), dates[0], true)
    // the next best header word, and the date in the other typographies: how far anything else is from reading as a date
    if (dates[1]) lines.push({ file, kind: 'not-date', line: dates[1].cost })
    for (const [name, font] of Object.entries(model.dates))
      if (name !== labels[file]!.dates)
        for (const { strip } of headerWords(image(file), CHERNIHIV_POSTER)) {
          const o = decodeDate(strip, font)
          if (o)
            lines.push({
              file,
              kind: 'not-date',
              line: o.cost,
              glyph: Math.max(...o.glyphs.map((g) => g.cost)),
            })
        }
    // a time line in the other typographies
    for (const [name, other] of Object.entries(model.times))
      if (name !== labels[file]!.times)
        for (const l of timeLines(file)) {
          const t = decodeTime(l.strips, other)
          if (t)
            lines.push({
              file,
              kind: 'other-time',
              want: l.text,
              text: t.text,
              ok: t.text === l.text,
              line: t.decoded.cost,
              glyph: Math.max(...t.decoded.glyphs.map((g) => g.cost)),
              margin: Math.min(...t.decoded.glyphs.map((g) => g.margin)),
            })
        }
    cardBands(image(file), CHERNIHIV_POSTER).forEach(({ mask, bands }, i) => {
      const note = !labels[file]!.cards[i]
      bands.forEach((b, j) => {
        const t = model.notes[labels[file]!.times]?.[note ? j : 0]
        if (t)
          lines.push({
            file,
            kind: note ? 'note' : 'not-note',
            distance: glyphDistance(bandPicture(mask, b).vector, t.vector),
          })
      })
    })
  }
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(lines))
  for (const kind of ['time', 'date']) {
    const of = lines.filter((l) => l.kind === kind)
    const right = of.filter((l) => l.ok)
    const num = (l: Record<string, unknown>, k: string) => l[k] as number
    console.log(`${kind}: ${right.length} of ${of.length} right without the limits`)
    for (const l of of.filter((l) => !l.ok))
      console.log(
        `  ${l.file} "${l.want}" read as "${l.text}": margin ${num(l, 'margin')?.toFixed(1)}, glyph ${num(l, 'glyph')?.toFixed(2)}, line ${num(l, 'line')?.toFixed(2)}, cuts agree: ${l.agreed}`,
      )
    const worst = (k: string, sign: number) =>
      [...right]
        .sort((a, b) => sign * (num(a, k) - num(b, k)))
        .slice(0, 6)
        .map((l) => num(l, k).toFixed(2))
        .join(' ')
    console.log(`  right readings: least margins ${worst('margin', 1)}`)
    console.log(`  worst glyph costs ${worst('glyph', -1)}; worst line costs ${worst('line', -1)}`)
    console.log(`  cuts disagreeing: ${right.filter((l) => !l.agreed).length}`)
    if (kind === 'time') {
      const starts = right.map((l) => num(l, 'start'))
      console.log(`  icon ${Math.min(...starts)}…${Math.max(...starts)} columns`)
      console.log(
        `  widest gaps ${TIME_GAPS.map((_, k) => Math.max(...right.map((l) => (l.gaps as number[])[k]!))).join(' ')}`,
      )
    }
  }
  const distances = (kind: string) => lines.filter((l) => l.kind === kind).map((l) => l.distance as number)
  console.log(
    `no-outages lines: distance up to ${Math.max(...distances('note')).toFixed(3)}; time lines from ${Math.min(...distances('not-note')).toFixed(3)}`,
  )
  console.log(
    `other header words, and dates in another typography, read as a date: line cost from ${Math.min(...lines.filter((l) => l.kind === 'not-date').map((l) => l.line as number)).toFixed(2)}`,
  )
  const others = lines.filter((l) => l.kind === 'other-time')
  const n = (l: Record<string, unknown>, k: string) => (l[k] as number).toFixed(2)
  console.log(
    `time lines in another typography: ${others.filter((l) => !l.ok).length} of ${others.length} read wrong; the wrong ones with the least line cost:`,
  )
  for (const l of others
    .filter((l) => !l.ok)
    .sort((a, b) => (a.line as number) - (b.line as number))
    .slice(0, 8))
    console.log(
      `  ${l.file} "${l.want}" as "${l.text}": line ${n(l, 'line')}, glyph ${n(l, 'glyph')}, margin ${n(l, 'margin')}`,
    )
  const right = others.filter((l) => l.ok)
  console.log(
    `  right ones: line cost ${Math.min(...right.map((l) => l.line as number)).toFixed(2)}…${Math.max(...right.map((l) => l.line as number)).toFixed(2)}`,
  )
  console.log(`${files.length - bad} of ${files.length} read exactly`)
  process.exitCode = bad ? 1 : 0
} else {
  const model = train(files)
  for (const kind of ['times', 'dates'] as const)
    for (const [style, font] of Object.entries(model[kind]))
      console.log(
        kind,
        style,
        Object.entries(font)
          .map(([ch, t]) => `${ch}:${t.width}`)
          .join(' '),
      )
  console.log(
    'notes',
    Object.entries(model.notes)
      .map(([s, l]) => `${s}:${l.length}`)
      .join(' '),
  )
  writeFileSync(
    'src/image/digit-model.ts',
    `// Generated by scripts/train-digits.ts from the posters in ${DIR} — do not edit by hand.\n` +
      `import { decodeModel } from './template-codec.js'\n\n` +
      `export const POSTER_MODEL = decodeModel(${JSON.stringify(encodeModel(model), null, 2)})\n`,
  )
}
