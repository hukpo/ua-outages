import { addDays, kyivDate, kyivMinuteOfDay, parseClock } from './time.js'
import type { DaySchedule, Freshness, FreshnessIssueCode, GroupSchedule, RegionSchedule } from './types.js'

export interface FreshnessOptions {
  /** The moment to judge at, default now */
  now?: Date
  /** `updatedAt` older than this, with today not published, is `not-updated`. Default 36 */
  staleAfterHours?: number
  /** `fetchedAt` older than this is `fetched-long-ago`. Default 30 */
  fetchedStaleAfterMinutes?: number
  /**
   * Kyiv wall-clock time ("HH:MM") by which the operator normally has tomorrow out. Past it,
   * a missing tomorrow is listed as `tomorrow-missing`. Default: not checked.
   */
  tomorrowExpectedAt?: string
}

/** Issues that make a schedule `stale`; the others are only listed */
const STALE: ReadonlySet<FreshnessIssueCode> = new Set([
  'behind',
  'not-updated',
  'last-good',
  'fetched-long-ago',
])

/**
 * Says whether a schedule can be shown as current, and why not. Pure: it reads only the object
 * and the clock, so it also works on a schedule the app stored earlier.
 *
 * "Published" below means a day whose status isn't `unknown` (so `no-outages` and `emergency`
 * count); dates are Kyiv calendar days.
 *
 * | issue               | when                                                                         | state         |
 * | ------------------- | ---------------------------------------------------------------------------- | ------------- |
 * | `nothing-published` | no day of any group is published                                             | `unpublished` |
 * | `behind`            | something is published, but nothing for today or later                       | `stale`       |
 * | `not-updated`       | published, but not today, and `updatedAt` older than `staleAfterHours`       | `stale`       |
 * | `last-good`         | `stale` is set: the last good result stands in for a failed fetch            | `stale`       |
 * | `fetched-long-ago`  | `fetchedAt` older than `fetchedStaleAfterMinutes` (not next to `last-good`)  | `stale`       |
 * | `source-failed`     | some `sources[].ok` is false                                                 | unchanged     |
 * | `sources-disagree`  | some `sources[].disagrees` is true                                           | unchanged     |
 * | `tomorrow-missing`  | `tomorrowExpectedAt` given, Kyiv time past it, tomorrow not published        | unchanged     |
 * | `partial`           | today published for some groups, `unknown` (or absent) for others            | unchanged     |
 *
 * `state` is `stale` when any stale-making issue is present, else `unpublished` when nothing is
 * published, else `fresh`. An old `updatedAt` alone is fine while today is covered (a schedule
 * published two days ahead), and an operator that publishes nothing is `unpublished` however
 * long ago it last said so: silence is not staleness.
 *
 * ```ts
 * const f = assessFreshness(await outages.getSchedules('lviv', { staleIfError: true }))
 * if (f.state === 'stale') warn(f.issues.map((i) => i.message).join('; '))
 * ```
 */
export function assessFreshness(
  schedule: RegionSchedule | GroupSchedule,
  opts: FreshnessOptions = {},
): Freshness {
  const now = opts.now ?? new Date()
  const today = kyivDate(now)
  const tomorrow = addDays(today, 1)
  const groups: DaySchedule[][] = 'days' in schedule ? [schedule.days] : Object.values(schedule.schedules)

  let coveredThrough: string | null = null
  let todayGroups = 0
  let hasTomorrow = false
  for (const days of groups) {
    for (const d of days) {
      if (d.status === 'unknown') continue
      if (coveredThrough === null || d.date > coveredThrough) coveredThrough = d.date
      if (d.date === today) todayGroups++
      if (d.date === tomorrow) hasTomorrow = true
    }
  }

  const minutesSince = (iso: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000))
  const ageMinutes =
    schedule.updatedAt && Number.isFinite(Date.parse(schedule.updatedAt))
      ? minutesSince(schedule.updatedAt)
      : null
  const fetchedMinutesAgo = minutesSince(schedule.fetchedAt)

  const issues: Freshness['issues'] = []
  const add = (code: FreshnessIssueCode, message: string) => issues.push({ code, message })

  if (coveredThrough === null) add('nothing-published', 'The operator publishes no schedule right now')
  else if (coveredThrough < today)
    add('behind', `The newest published day is ${coveredThrough}, nothing for ${today} or later`)
  const staleAfterHours = opts.staleAfterHours ?? 36
  if (coveredThrough !== null && !todayGroups && ageMinutes !== null && ageMinutes > staleAfterHours * 60)
    add(
      'not-updated',
      `Not updated for ${Math.floor(ageMinutes / 60)} h (since ${schedule.updatedAt}) and ${today} isn't published`,
    )
  if (schedule.stale)
    add(
      'last-good',
      `Last good result from ${schedule.stale.since}; the operator couldn't be read (${schedule.stale.error.code}: ${schedule.stale.error.message})`,
    )
  // the age of a last good result is what `last-good` already reports
  else if (!(fetchedMinutesAgo <= (opts.fetchedStaleAfterMinutes ?? 30)))
    add('fetched-long-ago', `Fetched ${fetchedMinutesAgo} min ago (${schedule.fetchedAt})`)

  const failed = schedule.sources?.filter((s) => !s.ok) ?? []
  if (failed.length)
    add(
      'source-failed',
      `Failed: ${failed.map((s) => `${s.id}${s.error ? ` (${s.error.code}: ${s.error.message})` : ''}`).join(', ')}`,
    )
  const disagree = schedule.sources?.filter((s) => s.disagrees) ?? []
  if (disagree.length)
    add(
      'sources-disagree',
      `Different outage times than the newest source: ${disagree.map((s) => s.id).join(', ')}`,
    )

  if (opts.tomorrowExpectedAt !== undefined) {
    const at = parseClock(opts.tomorrowExpectedAt)
    if (at === null)
      throw new RangeError(`tomorrowExpectedAt: expected "HH:MM", got "${opts.tomorrowExpectedAt}"`)
    if (!hasTomorrow && kyivMinuteOfDay(now) >= at)
      add(
        'tomorrow-missing',
        `${tomorrow} isn't published although it is past ${opts.tomorrowExpectedAt} in Kyiv`,
      )
  }
  if (todayGroups > 0 && todayGroups < groups.length)
    add('partial', `${today} is published for ${todayGroups} of ${groups.length} groups`)

  return {
    state: issues.some((i) => STALE.has(i.code))
      ? 'stale'
      : coveredThrough === null
        ? 'unpublished'
        : 'fresh',
    today: todayGroups ? 'published' : 'missing',
    tomorrow: hasTomorrow ? 'published' : 'missing',
    coveredThrough,
    ageMinutes,
    fetchedMinutesAgo,
    issues,
  }
}
