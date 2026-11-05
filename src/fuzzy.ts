/**
 * Forgiving name search for streets and settlements. People rarely know the official name:
 * they skip the street type or first name, misspell a letter, type Russian-style "и" for "і",
 * put words in another order, or stop halfway through a word. This ranks candidates for all of
 * that without a dictionary.
 */
import { normalizeSettlement, normalizeStreet, streetType } from './text.js'

export type NameKind = 'street' | 'settlement'

/**
 * Letters people mix up, mapped to one representative, so "Перемоги" ~ "Перемогі",
 * "Гетьмана" ~ "Гетмана", "Днепр" ~ "Дніпро", "Киевская" ~ "Київська". Russian е and
 * Ukrainian і/и stand for the same sound in most place names, so all of them fold together.
 */
const FOLD: Record<string, string> = {
  і: 'и',
  ї: 'и',
  ы: 'и',
  й: 'и',
  е: 'и',
  є: 'и',
  э: 'и',
  ё: 'и',
  ґ: 'г',
  ъ: '',
  ь: '',
  "'": '',
}

/** Name → comparable tokens: lowercase, without types, folded letters, split on spaces/dashes. */
export function tokens(name: string, kind: NameKind): string[] {
  const base = kind === 'street' ? normalizeStreet(name) : normalizeSettlement(name)
  return base
    .replace(/[-/]/g, ' ')
    .split(' ')
    .map((w) => [...w].map((ch) => FOLD[ch] ?? ch).join(''))
    .filter(Boolean)
}

/** Optimal string alignment distance (Levenshtein + adjacent swaps), capped for speed. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2 = new Array<number>(b.length + 1)
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!
    prev = cur
  }
  return prev[b.length]!
}

/** Penalty per candidate word the query didn't mention. */
const UNMATCHED_WORD_COST = 0.06

/** Credit for a query word that matches nothing in the candidate, relative to a perfect match. */
const MISSING_WORD_CREDIT = 0.4

/** Typos allowed in a query word of this length. */
const allowedTypos = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : 2)

/** How well one query word matches one candidate word, 0..1. */
export function wordScore(q: string, c: string): number {
  if (q === c) return 1
  // still typing: "хрещ" → "хрещатик"
  if (c.startsWith(q)) return q.length === 1 ? 0.6 : 0.92
  // an initial: "Хмельницького Б." for "Богдана"
  if (c.length === 1 && q.startsWith(c)) return 0.8
  const max = allowedTypos(q.length)
  if (max > 0) {
    // a typo in a whole word, or in the part typed so far
    const whole = editDistance(q, c, max)
    const prefix = c.length > q.length ? editDistance(q, c.slice(0, q.length), max) : max + 1
    const d = Math.min(whole, prefix)
    if (d <= max) return (whole <= prefix ? 0.88 : 0.82) - 0.08 * d
  }
  // a fragment from the middle: "щатик"
  if (q.length >= 3 && c.includes(q)) return 0.6
  return 0
}

/**
 * Score of a candidate name for a query, 0..1. Every query word is matched to its best
 * candidate word; longer words weigh more, so a skipped first name or a stray word costs
 * little while the main name must match. Returns 0 when the longest query word matches nothing.
 */
export function fuzzyScore(query: string, candidate: string, kind: NameKind = 'street'): number {
  const q = tokens(query, kind)
  const c = tokens(candidate, kind)
  if (!q.length || !c.length) return 0

  let weighted = 0
  let weights = 0
  // the longest query word carries the meaning; it must match something other than an initial
  let longest = { len: 0, ok: false }
  const used = new Set<number>()
  for (const w of q) {
    let best = 0
    let bestIdx = -1
    let bestReal = 0
    c.forEach((cw, i) => {
      const s = wordScore(w, cw) * (used.has(i) ? 0.7 : 1)
      if (s > best) {
        best = s
        bestIdx = i
      }
      if (cw.length > 1 && s > bestReal) bestReal = s
    })
    if (bestIdx >= 0) used.add(bestIdx)
    // a query word with no counterpart (a first name the operator omits) is a small loss, not a miss
    weighted += (best || MISSING_WORD_CREDIT) * w.length
    weights += w.length
    // on a tie the later word wins: surnames come last ("Генерала Карпенка")
    if (w.length >= longest.len) longest = { len: w.length, ok: bestReal > 0 }
  }
  if (!longest.ok) return 0

  let score = weighted / weights
  // candidate words the query didn't mention ("Гоголя" in "Городоцька-Гоголя") cost a little
  score -= UNMATCHED_WORD_COST * (c.length - used.size)
  // the exact name wins outright; anything else (reordered, partial, misspelled) stays below it
  score = q.join(' ') === c.join(' ') ? 1 : Math.min(score, 0.97)
  // "просп. Яворницького" asked: "вул. Яворницького" is a different street
  if (kind === 'street') {
    const qt = streetType(query)
    const ct = qt ? streetType(candidate) : null
    if (qt && ct && qt !== ct) score *= 0.9
  }
  return Math.max(0, Math.min(1, score))
}

export interface Ranked<T> {
  item: T
  score: number
}

/** Ranks items by name for a query: best first, shorter names first on ties. */
export function rankByName<T>(
  query: string,
  items: readonly T[],
  name: (t: T) => string,
  kind: NameKind,
  opts: { limit?: number; minScore?: number } = {},
): Ranked<T>[] {
  const min = opts.minScore ?? 0.5
  const ranked = items
    .map((item) => ({ item, score: fuzzyScore(query, name(item), kind) }))
    .filter((r) => r.score >= min)
    .sort(
      (a, b) =>
        b.score - a.score ||
        name(a.item).length - name(b.item).length ||
        name(a.item).localeCompare(name(b.item), 'uk'),
    )
  return opts.limit ? ranked.slice(0, opts.limit) : ranked
}

/**
 * Substrings to send to an operator whose server only does substring search, so a typo in
 * one part of the word still finds the street: "Хрищатик" → "Хри", "щат", "тик".
 */
export function searchFragments(query: string, kind: NameKind, count = 3): string[] {
  const base = kind === 'street' ? normalizeStreet(query) : normalizeSettlement(query)
  const word = base.split(/[\s-]+/).sort((a, b) => b.length - a.length)[0] ?? ''
  if (word.length < 6) return []
  const size = word.length >= 9 ? 4 : 3
  const out = new Set<string>()
  for (let k = 0; k < count; k++) {
    const start = Math.round(((word.length - size) * k) / Math.max(1, count - 1))
    out.add(word.slice(start, start + size))
  }
  return [...out]
}
