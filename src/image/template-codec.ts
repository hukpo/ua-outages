import { GLYPH_H, GLYPH_W } from './glyphs.js'

/** Average glyph vector (see `glyphVector`) and width/height ratio of one digit */
export interface DigitTemplate {
  vector: Float32Array
  aspect: number
}

/**
 * Digit model for one glyph size: the average of each digit, plus a weight per cell that is
 * high where samples of the same digit agree (Fisher-style), so cells that tell 6 from 8 count
 * more than edge cells that wobble with JPEG noise.
 */
export interface DigitModel {
  digits: Record<string, DigitTemplate>
  weights: Float32Array
}

/** Stored form: float32 arrays as base64 */
export interface EncodedModel {
  digits: Record<string, { aspect: number; vector: string }>
  weights: string
}

const SIZE = GLYPH_W * GLYPH_H
const toBase64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
function fromBase64(s: string): Float32Array {
  const b = Buffer.from(s, 'base64')
  if (b.length !== SIZE * 4) throw new Error('digit model has the wrong size')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
}

export function encodeModel(m: DigitModel): EncodedModel {
  const digits: EncodedModel['digits'] = {}
  for (const [k, t] of Object.entries(m.digits))
    digits[k] = { aspect: Math.round(t.aspect * 1000) / 1000, vector: toBase64(t.vector) }
  return { digits, weights: toBase64(m.weights) }
}

export function decodeModel(m: EncodedModel): DigitModel {
  const digits: Record<string, DigitTemplate> = {}
  for (const [k, t] of Object.entries(m.digits))
    digits[k] = { aspect: t.aspect, vector: fromBase64(t.vector) }
  return { digits, weights: fromBase64(m.weights) }
}

/** Builds a model from labelled glyph samples. */
export function trainModel(samples: { digit: string; vector: Float32Array; aspect: number }[]): DigitModel {
  const sums: Record<string, { v: Float32Array; aspect: number; n: number }> = {}
  for (const s of samples) {
    const t = (sums[s.digit] ??= { v: new Float32Array(SIZE), aspect: 0, n: 0 })
    s.vector.forEach((x, i) => (t.v[i]! += x))
    t.aspect += s.aspect
    t.n++
  }
  const digits: Record<string, DigitTemplate> = {}
  for (const d of Object.keys(sums).sort()) {
    const t = sums[d]!
    digits[d] = { vector: t.v.map((x) => x / t.n), aspect: t.aspect / t.n }
  }
  // within-digit variance per cell; the small constant keeps rare clean cells from dominating
  const variance = new Float32Array(SIZE)
  for (const s of samples)
    s.vector.forEach((x, i) => (variance[i]! += (x - digits[s.digit]!.vector[i]!) ** 2 / samples.length))
  return { digits, weights: variance.map((v) => 1 / (v + 0.01)) }
}

/** Distance of a glyph to a digit template under the model's cell weights */
export function modelDistance(
  model: DigitModel,
  t: DigitTemplate,
  vector: Float32Array,
  aspect: number,
): number {
  let s = 0
  for (let i = 0; i < SIZE; i++) s += model.weights[i]! * (vector[i]! - t.vector[i]!) ** 2
  return (Math.sqrt(s) + Math.abs(Math.log(aspect / t.aspect))) / 10
}
