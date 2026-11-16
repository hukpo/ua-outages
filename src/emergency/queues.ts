import type { EmergencyQueues } from '../types.js'

/**
 * One emergency queue value as an operator writes it → queue names. Blanks and "not included"
 * markers ("Не входить", "Не залучено", "в чергу не включено") give none; a comma list gives
 * several; an АЧР frequency suffix is dropped ("10 (48.2Гц)" → "10"); a reserve marker is kept
 * ("1(Р)"). A queue "0" is outside the 1–10 rotation and counts as none.
 */
export function queueNames(raw: string | number | null | undefined): string[] {
  if (raw === null || raw === undefined) return []
  const out: string[] = []
  for (const part of String(raw).split(/[,;]/)) {
    const s = part
      .trim()
      // the АЧР trigger frequency: "10 (48.2Гц)"
      .replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*Гц\s*\)\s*$/i, '')
      .replace(/\s+/g, '')
    const m = /^(\d{1,2})(\([РрPp]\))?$/.exec(s)
    if (!m || Number(m[1]) === 0) continue
    out.push(m[2] ? `${Number(m[1])}(Р)` : String(Number(m[1])))
  }
  return out
}

/** "2" < "10" < "10(Р)"; numbers first, a reserve queue after the plain one. */
export function compareQueues(a: string, b: string): number {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1
  return a.length - b.length || a.localeCompare(b)
}

/** Distinct, sorted numerically. */
export function sortQueues(list: Iterable<string>): string[] {
  return [...new Set(list)].sort(compareQueues)
}

/**
 * Raw per-schedule values (one or many per address, e.g. one per customer account) → the
 * `GroupMatch.emergency` block: distinct and sorted, empty schedules left out, `undefined`
 * when nothing is known.
 */
export function emergencyQueues(raw: {
  gav?: Iterable<string | number | null | undefined>
  sgav?: Iterable<string | number | null | undefined>
  achr?: Iterable<string | number | null | undefined>
}): EmergencyQueues | undefined {
  const out: EmergencyQueues = {}
  for (const key of ['gav', 'sgav', 'achr'] as const) {
    const values = raw[key]
    if (!values) continue
    const list = sortQueues([...values].flatMap((v) => queueNames(v)))
    if (list.length) out[key] = list
  }
  return Object.keys(out).length ? out : undefined
}

/** Two blocks merged (several rows or connections of one address). */
export function mergeEmergency(
  a: EmergencyQueues | undefined,
  b: EmergencyQueues | undefined,
): EmergencyQueues | undefined {
  if (!a) return b
  if (!b) return a
  return emergencyQueues({
    gav: [...(a.gav ?? []), ...(b.gav ?? [])],
    sgav: [...(a.sgav ?? []), ...(b.sgav ?? [])],
    achr: [...(a.achr ?? []), ...(b.achr ?? [])],
  })
}
