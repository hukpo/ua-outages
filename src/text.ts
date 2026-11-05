/**
 * Address text normalization. Operators and people spell the same street differently:
 * "вул. Шевченка", "вулиця Тараса Шевченка", "Шевченка вул.", apostrophes ’ ' ʼ `.
 */

const STREET_TYPES = [
  'вулиця',
  'вул',
  'проспект',
  'просп',
  'пр-т',
  'пр',
  'провулок',
  'пров',
  'бульвар',
  'бульв',
  'бул',
  'площа',
  'пл',
  'шосе',
  'узвіз',
  'набережна',
  'наб',
  'тупик',
  'проїзд',
  'майдан',
  'алея',
  'дорога',
  'урочище',
  'масив',
  'мікрорайон',
  'мкр',
  'квартал',
  'кв-л',
]

const SETTLEMENT_TYPES = ['місто', 'м', 'село', 'с', 'селище', 'смт', 'сел', 'с-ще', 'хутір', 'х']

const typeRe = (types: string[]) =>
  new RegExp(`(^|\\s)(${types.map((t) => t.replace(/[-.]/g, '\\$&')).join('|')})\\.?(?=\\s|$)`, 'g')

const STREET_RE = typeRe(STREET_TYPES)
const SETTLEMENT_RE = typeRe(SETTLEMENT_TYPES)

/** Lowercase, unify apostrophes and dashes, collapse whitespace, drop punctuation. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’'ʼ`´‘]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/ё/g, 'е')
    .replace(/["«»„“”]/g, ' ')
    .replace(/[,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeStreet(s: string): string {
  return normalizeText(s).replace(/\./g, '. ').replace(STREET_RE, ' ').replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function normalizeSettlement(s: string): string {
  return normalizeText(s).replace(/\./g, '. ').replace(SETTLEMENT_RE, ' ').replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** "12-А", "12 а", "12a" (latin), "№12А" → "12а". Keeps building parts: "12 к 3" → "12к3". */
export function normalizeHouse(s: string): string {
  return normalizeText(s)
    .replace(/№/g, '')
    .replace(/[a]/g, 'а')
    .replace(/[b]/g, 'б')
    .replace(/[v]/g, 'в')
    .replace(/корп(ус)?\.?/g, 'к')
    .replace(/буд(инок)?\.?/g, '')
    .replace(/[\s\-/.]+/g, '')
}

/**
 * How well `candidate` matches `query`, 0..1. Exact normalized match = 1; every query word
 * found as a word prefix scores high; otherwise 0.
 */
export function matchScore(query: string, candidate: string, kind: 'street' | 'settlement' = 'street'): number {
  const norm = kind === 'street' ? normalizeStreet : normalizeSettlement
  const q = norm(query)
  const c = norm(candidate)
  if (!q || !c) return 0
  if (q === c) return 1
  const cWords = c.split(' ')
  const qWords = q.split(' ')
  const allFound = qWords.every((w) => cWords.some((cw) => cw.startsWith(w)))
  if (!allFound) return c.includes(q) ? 0.5 : 0
  // prefer candidates that don't have many extra words ("Шевченка" vs "Тараса Шевченка")
  return 0.6 + 0.35 * (qWords.length / cWords.length)
}

/** Picks the single best match, or null when nothing fits or two candidates tie at the top. */
export function bestMatch<T>(
  query: string,
  items: readonly T[],
  name: (t: T) => string,
  kind: 'street' | 'settlement' = 'street',
): { item: T; score: number; ambiguous: boolean } | null {
  const scored = items
    .map((item) => ({ item, score: matchScore(query, name(item), kind) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return null
  const ambiguous = scored.length > 1 && scored[1]!.score === top.score && top.score < 1
  return { ...top, ambiguous }
}
