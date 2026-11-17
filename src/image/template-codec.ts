/**
 * The poster reader's font model (src/image/digit-model.ts, built by scripts/train-digits.ts):
 * for every typography the operator has used, an average picture of each character of the time
 * lines and of the header date, at one fixed text height.
 */

/** Height every text line is resampled to before matching, px */
export const LINE_H = 24
/** Size of a whole-line picture (`LineTemplate`) */
export const NOTE_W = 48
export const NOTE_H = 8

/**
 * One character as its labelled samples show it, `width` × LINE_H, row by row: the average
 * darkness (0..1) of every pixel and how much it varies from sample to sample. The pixels of a
 * stroke's edge move with the sub-pixel position of the glyph and with JPEG noise, the ones
 * that tell a 6 from an 8 don't; matching weighs each by its steadiness.
 */
export interface GlyphTemplate {
  width: number
  pixels: Float32Array
  /** Standard deviation per pixel */
  spread: Float32Array
  /** 1 / variance per pixel (derived, with a floor under the variance) */
  weights: Float32Array
  /** Σ log variance (derived): what makes templates of different steadiness comparable */
  bias: number
}

/** No pixel is trusted more than this: σ of 0.07 on the 0..1 darkness scale */
const MIN_VARIANCE = 0.005
/**
 * Variance of a pixel that should be blank (between characters): the edge of a glyph leaks
 * into it at small sizes
 */
export const GAP_VARIANCE = 0.04

export function makeTemplate(width: number, pixels: Float32Array, spread: Float32Array): GlyphTemplate {
  const weights = new Float32Array(pixels.length)
  let bias = 0
  for (let i = 0; i < pixels.length; i++) {
    const v = Math.max(MIN_VARIANCE, spread[i]! ** 2)
    weights[i] = 1 / v
    bias += Math.log(v)
  }
  return { width, pixels, spread, weights, bias }
}

/** One typeface at one weight: its digits and punctuation */
export type Font = Record<string, GlyphTemplate>

/** A fixed line of words ("відключень", "не прогнозується") as one NOTE_W × NOTE_H picture */
export interface LineTemplate {
  /** Width / height of the line's ink */
  aspect: number
  vector: Float32Array
}

export interface PosterModel {
  /** Fonts of the "HH:MM - HH:MM" lines, by typography name */
  times: Record<string, Font>
  /** Fonts of the header date "DD.MM.YYYY" */
  dates: Record<string, Font>
  /** The lines of a card without outages, top to bottom, by typography name */
  notes: Record<string, LineTemplate[]>
}

type EncodedFont = Record<string, { width: number; pixels: string; spread: string }>
/** Stored form: darkness as bytes, base64 */
export interface EncodedModel {
  times: Record<string, EncodedFont>
  dates: Record<string, EncodedFont>
  notes: Record<string, { aspect: number; vector: string }[]>
}

const toBase64 = (a: Float32Array) =>
  Buffer.from(Uint8Array.from(a, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255))).toString('base64')
function fromBase64(s: string, size: number): Float32Array {
  const b = Buffer.from(s, 'base64')
  if (b.length !== size) throw new Error('poster model: a template has the wrong size')
  return Float32Array.from(b, (v) => v / 255)
}

const mapValues = <A, B>(o: Record<string, A>, f: (a: A) => B): Record<string, B> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))

const encodeFont = (f: Font): EncodedFont =>
  mapValues(f, (g) => ({ width: g.width, pixels: toBase64(g.pixels), spread: toBase64(g.spread) }))
const decodeFont = (f: EncodedFont): Font =>
  mapValues(f, (g) =>
    makeTemplate(g.width, fromBase64(g.pixels, g.width * LINE_H), fromBase64(g.spread, g.width * LINE_H)),
  )

export function encodeModel(m: PosterModel): EncodedModel {
  return {
    times: mapValues(m.times, encodeFont),
    dates: mapValues(m.dates, encodeFont),
    notes: mapValues(m.notes, (lines) =>
      lines.map((l) => ({ aspect: Math.round(l.aspect * 1000) / 1000, vector: toBase64(l.vector) })),
    ),
  }
}

export function decodeModel(m: EncodedModel): PosterModel {
  return {
    times: mapValues(m.times, decodeFont),
    dates: mapValues(m.dates, decodeFont),
    notes: mapValues(m.notes, (lines) =>
      lines.map((l) => ({ aspect: l.aspect, vector: fromBase64(l.vector, NOTE_W * NOTE_H) })),
    ),
  }
}

/** Average of equally sized pictures */
export function mean(samples: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(samples[0]!.length)
  for (const s of samples) for (let i = 0; i < out.length; i++) out[i]! += s[i]! / samples.length
  return out
}
