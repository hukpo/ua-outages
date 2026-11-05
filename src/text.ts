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

/** Canonical street type of a name ("просп. X" → "просп"), or null when it has none. */
export function streetType(s: string): string | null {
  const words = normalizeText(s).replace(/\./g, ' ').split(' ')
  for (const w of words) {
    const canon = TYPE_CANON[w]
    if (canon) return canon
  }
  return null
}

const TYPE_CANON: Record<string, string> = {
  вулиця: 'вул', вул: 'вул',
  проспект: 'просп', просп: 'просп', 'пр-т': 'просп', пр: 'просп',
  провулок: 'пров', пров: 'пров',
  бульвар: 'бул', бульв: 'бул', бул: 'бул',
  площа: 'пл', пл: 'пл',
  набережна: 'наб', наб: 'наб',
  шосе: 'шосе', узвіз: 'узвіз', тупик: 'тупик', проїзд: 'проїзд', майдан: 'майдан', алея: 'алея',
  мікрорайон: 'мкр', мкр: 'мкр', квартал: 'кв-л', 'кв-л': 'кв-л',
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
  // "просп. Яворницького" and "вул. Яворницького" are different streets: when the query names
  // a type, a candidate of another type ranks lower
  const qt = kind === 'street' ? streetType(query) : null
  const ct = qt ? streetType(candidate) : null
  const typeFactor = qt && ct && qt !== ct ? 0.85 : 1
  if (q === c) return typeFactor
  const cWords = c.split(' ')
  const qWords = q.split(' ')
  // a one-letter word is an initial: "Хмельницького Б." matches "Богдана Хмельницького"
  const wordMatches = (w: string, cw: string) => cw.startsWith(w) || (cw.length === 1 && w.startsWith(cw))
  const allFound = qWords.every((w) => cWords.some((cw) => wordMatches(w, cw)))
  if (!allFound) return c.includes(q) ? 0.5 * typeFactor : 0
  // prefer candidates that don't have many extra words ("Шевченка" vs "Тараса Шевченка")
  return (0.6 + 0.35 * (qWords.length / cWords.length)) * typeFactor
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
  // equal scores mean the query can't tell them apart ("Яворницького" → вул. or пров.?)
  const ambiguous = scored.length > 1 && scored[1]!.score === top.score
  return { ...top, ambiguous }
}
