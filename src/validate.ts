import { OutageError } from './errors.js'
import { addDays, kyivInstant } from './time.js'
import type { RegionId, RegionSchedule } from './types.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const STATUSES: ReadonlySet<unknown> = new Set(['scheduled', 'no-outages', 'emergency', 'unknown'])
/** A clock that runs ahead, or an operator's timestamp without a zone, is fine; a day ahead isn't */
const MAX_AHEAD_MS = 24 * 3600_000

const isIso = (v: unknown): v is string =>
  typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v))

/**
 * Checks that a provider's result is a well-formed schedule, and throws a `parse` error naming
 * the region and the first violation otherwise. The client runs it on every result before
 * caching it, so parser garbage (a site that changed, a misread table) is an error instead of
 * a schedule somebody acts on. Custom providers are checked too.
 *
 * Rules:
 * - `region` is the one asked for; `fetchedAt` is an ISO instant; `updatedAt` is null or an ISO
 *   instant at most 24 h after `now`;
 * - `groups` are distinct non-empty strings, and `schedules` has exactly those keys;
 * - a group's days have real, distinct "YYYY-MM-DD" dates and one of the four statuses;
 * - intervals have ISO `from` < `to` and a `kind` of `off` or `maybe`, lie within their day in
 *   Kyiv time (ending at the next midnight is allowed; the day is 23 or 25 h long when the
 *   clocks change), and are sorted and non-overlapping;
 * - a `no-outages` day has no intervals. An `unknown` day may have them: YASNO shows a
 *   preliminary schedule under "WaitingForSchedule".
 *
 * How far a date is from today isn't checked: operators that publish through news posts
 * legitimately return their last schedule however old it is (`assessFreshness` reports that as
 * `behind`).
 */
export function validateSchedule(schedule: RegionSchedule, region: RegionId, now: Date = new Date()): void {
  const fail = (what: string): never => {
    throw new OutageError('parse', `${region}: the provider returned an invalid schedule: ${what}`, {
      region,
    })
  }
  const s = schedule as unknown as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return fail('not an object')
  if (s.region !== region) fail(`region is ${JSON.stringify(s.region)}`)
  if (!isIso(s.fetchedAt)) fail(`fetchedAt is ${JSON.stringify(s.fetchedAt)}`)
  if (s.updatedAt !== null) {
    if (!isIso(s.updatedAt)) fail(`updatedAt is ${JSON.stringify(s.updatedAt)}`)
    else if (Date.parse(s.updatedAt) - now.getTime() > MAX_AHEAD_MS)
      fail(`updatedAt ${s.updatedAt} is in the future`)
  }
  const { groups, schedules } = schedule
  if (!Array.isArray(groups)) return fail('groups is not a list')
  if (!schedules || typeof schedules !== 'object' || Array.isArray(schedules))
    return fail('schedules is not an object')
  const seen = new Set<unknown>()
  for (const g of groups) {
    if (typeof g !== 'string' || !g) fail(`group ${JSON.stringify(g)} is not a name`)
    if (seen.has(g)) fail(`group ${g} is listed twice`)
    seen.add(g)
    if (!Array.isArray(schedules[g])) fail(`group ${g} has no days in schedules`)
  }
  for (const g of Object.keys(schedules)) if (!seen.has(g)) fail(`schedules has group ${g}, groups doesn't`)

  /** date → [start, end] of the Kyiv day; the same few dates repeat in every group */
  const bounds = new Map<string, [number, number]>()
  for (const g of groups) {
    const dates = new Set<string>()
    for (const d of schedules[g]!) {
      if (!d || typeof d !== 'object') fail(`group ${g} has a day that is not an object`)
      const at = `group ${g}, ${String(d.date)}`
      if (typeof d.date !== 'string' || !DATE.test(d.date) || addDays(d.date, 0) !== d.date)
        fail(`group ${g} has the date ${JSON.stringify(d.date)}`)
      if (dates.has(d.date)) fail(`${at}: the date is listed twice`)
      dates.add(d.date)
      if (!STATUSES.has(d.status)) fail(`${at}: status is ${JSON.stringify(d.status)}`)
      if (!Array.isArray(d.intervals)) fail(`${at}: intervals is not a list`)
      if (d.status === 'no-outages' && d.intervals.length) fail(`${at}: a no-outages day has intervals`)
      if (!d.intervals.length) continue
      let day = bounds.get(d.date)
      if (!day) {
        day = [kyivInstant(d.date, 0).getTime(), kyivInstant(d.date, 1440).getTime()]
        bounds.set(d.date, day)
      }
      let prev = day[0]
      for (const i of d.intervals) {
        if (!i || typeof i !== 'object') fail(`${at}: an interval is not an object`)
        const span = `${String(i.from)} – ${String(i.to)}`
        if (!isIso(i.from) || !isIso(i.to)) fail(`${at}: interval ${span} is not ISO`)
        if (i.kind !== 'off' && i.kind !== 'maybe') fail(`${at}: interval kind is ${JSON.stringify(i.kind)}`)
        const from = Date.parse(i.from)
        const to = Date.parse(i.to)
        if (!(from < to)) fail(`${at}: interval ${span} doesn't end after it starts`)
        if (from < day[0] || to > day[1]) fail(`${at}: interval ${span} is outside its day`)
        if (from < prev) fail(`${at}: interval ${span} overlaps the one before or is out of order`)
        prev = to
      }
    }
  }
}
