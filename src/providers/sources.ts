import { OutageError } from '../errors.js'
import { compareGroups } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule, SourceStatus } from '../types.js'
import type { ProviderContext } from './provider.js'

/**
 * Several official channels of one operator (its site, its API, its Telegram channel) read as
 * one schedule: every channel is asked, each day comes from the channel that published it last,
 * and a channel that fails costs nothing while another still answers.
 *
 * ```ts
 * getSchedules: (ctx) =>
 *   mergeSources(ctx, 'chernihiv', [
 *     { id: 'site', url: POSTER_URL, read: readPoster },
 *     { id: 'telegram:@chernigivoblenergo', url: 'https://t.me/s/chernigivoblenergo', read: readChannelPosters },
 *   ])
 * ```
 */

/** What one channel says, as returned by `SourceSpec.read`. */
export interface SourceRead {
  /**
   * Per day ("YYYY-MM-DD"): every group's schedule for that date, and when this channel
   * published that day (ISO; null when it doesn't say). A day the channel says nothing about is
   * left out or given `unknown` days: both mean "not published here". `cancelled`: the channel
   * called that day's schedule off; its days are `unknown` (neither the old hours nor "no
   * outages"), and that is what it has published for the date.
   */
  days: Record<
    string,
    { schedules: Record<GroupId, DaySchedule>; publishedAt: string | null; cancelled?: boolean }
  >
  /** Groups this channel knows of, listed in the result even when no day names them */
  groups?: GroupId[]
  /** Where exactly it was read (e.g. the post), when more precise than `SourceSpec.url` */
  url?: string
}

export interface SourceSpec {
  /** Stable name of the channel: 'site', 'api', 'telegram:@channel'. Ends up in `SourceStatus.id` */
  id: string
  /** Where a person can see the same data, or null */
  url: string | null
  /**
   * Reads the channel. Throw an `OutageError` when it can't be read; return `days: {}` when it
   * answers and publishes nothing. Runs concurrently with the other channels on the same `ctx`.
   */
  read: (ctx: ProviderContext) => Promise<SourceRead>
}

export interface MergeOptions {
  /** Groups the region always has: listed (as `unknown`) even when no channel names them */
  groups?: readonly GroupId[]
}

/**
 * Reads every channel in parallel and merges them into one `RegionSchedule` with `sources` set.
 *
 * - A channel that throws is listed in `sources` with `ok: false` and its error; the rest still
 *   give a result. When every channel fails, the first one's error is thrown (the primary: put
 *   it first). A cancelled call (`ctx.signal`) rejects with the signal's reason instead.
 * - Per date the winner is the channel with the newest `publishedAt` for that date. No timestamp
 *   loses to a timestamp; a tie, or no timestamps at all, goes to the earlier spec.
 * - A channel's day counts only if it has published data for it (some group's status isn't
 *   `unknown`, or the day is `cancelled`: a cancellation is a publication like any other, so a
 *   newer one beats an older schedule and leaves the date `unknown`, with the channel that
 *   cancelled named in `sources` as the one the date came from), so a channel that says nothing about tomorrow never hides one that has it. A
 *   date nobody has published data for stays in the result as `unknown` days.
 * - When a loser also has published data for a date and its outage times (or `emergency`
 *   status) differ from the winner's in a group both published, it gets `disagrees: true`.
 * - `updatedAt` is the newest `publishedAt` among the winning days; `groups` is the sorted union
 *   of every channel's groups and `opts.groups`; a group the winner doesn't have on a day gets
 *   an `unknown` day; days are sorted by date. With no dates at all, every group gets today as
 *   `unknown`, like `unpublished()`.
 */
export async function mergeSources(
  ctx: ProviderContext,
  region: RegionId,
  specs: readonly SourceSpec[],
  opts: MergeOptions = {},
): Promise<RegionSchedule> {
  // an async wrapper, so a reader that throws before its first await counts as a failed channel too
  const settled = await Promise.allSettled(specs.map(async (s) => s.read(ctx)))
  if (ctx.signal?.aborted) throw ctx.signal.reason
  const reads = settled.map((r) => (r.status === 'fulfilled' ? r.value : null))
  if (specs.length && reads.every((r) => !r)) throw (settled[0] as PromiseRejectedResult).reason

  const statuses: SourceStatus[] = specs.map((spec, i) => {
    const r = settled[i]!
    const base = { id: spec.id, url: reads[i]?.url ?? spec.url, dates: [], updatedAt: null }
    if (r.status === 'fulfilled') return { ...base, ok: true }
    const e: unknown = r.reason
    // anything that isn't an OutageError is a bug in the reader: the channel couldn't be read
    const error =
      e instanceof OutageError
        ? { code: e.code, message: e.message }
        : { code: 'parse' as const, message: e instanceof Error ? e.message : String(e) }
    return { ...base, ok: false, error }
  })

  const groupSet = new Set<GroupId>(opts.groups ?? [])
  const dateSet = new Set<string>()
  for (const r of reads) {
    if (!r) continue
    for (const g of r.groups ?? []) groupSet.add(g)
    for (const [date, day] of Object.entries(r.days)) {
      dateSet.add(date)
      for (const g of Object.keys(day.schedules)) groupSet.add(g)
    }
  }
  const groups = [...groupSet].sort(compareGroups)
  const dates = [...dateSet].sort()
  if (!dates.length) dates.push(kyivDate(ctx.now()))

  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of groups) schedules[g] = []
  let updated = -Infinity
  for (const date of dates) {
    let winner = -1
    let winnerAt = -Infinity
    const published: number[] = []
    reads.forEach((r, i) => {
      const day = r?.days[date]
      if (!day || !hasPublished(day)) return
      published.push(i)
      const at = time(day.publishedAt)
      // strictly newer: a tie stays with the earlier spec
      if (winner === -1 || at > winnerAt) {
        winner = i
        winnerAt = at
      }
    })
    const won = winner === -1 ? undefined : reads[winner]!.days[date]!
    for (const g of groups)
      schedules[g]!.push(
        won?.schedules[g] ? { ...won.schedules[g], date } : { date, status: 'unknown', intervals: [] },
      )
    if (!won) continue
    const status = statuses[winner]!
    status.dates.push(date)
    if (winnerAt > updated) updated = winnerAt
    if (winnerAt > time(status.updatedAt)) status.updatedAt = won.publishedAt
    for (const i of published) {
      const other = reads[i]!.days[date]!
      // a schedule on one channel and a cancellation on the other is a disagreement too
      if (i !== winner && (!won.cancelled !== !other.cancelled || differ(won.schedules, other.schedules)))
        statuses[i]!.disagrees = true
    }
  }
  // a channel that won no day still says when it last published something
  reads.forEach((r, i) => {
    if (!r || statuses[i]!.dates.length) return
    let newest = -Infinity
    for (const day of Object.values(r.days)) {
      const at = time(day.publishedAt)
      if (hasPublished(day) && at > newest) {
        newest = at
        statuses[i]!.updatedAt = day.publishedAt
      }
    }
  })

  return {
    region,
    groups,
    schedules,
    updatedAt: Number.isFinite(updated) ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(ctx.now()),
    sources: statuses,
  }
}

const hasPublished = (day: SourceRead['days'][string]) =>
  !!day.cancelled || Object.values(day.schedules).some((d) => d.status !== 'unknown')

/** Instant of a `publishedAt`; none (or unreadable) sorts before every real one */
function time(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

/** Two channels' versions of one day differ in a group both have published */
function differ(a: Record<GroupId, DaySchedule>, b: Record<GroupId, DaySchedule>): boolean {
  for (const [g, x] of Object.entries(a)) {
    const y = b[g]
    if (!y || x.status === 'unknown' || y.status === 'unknown') continue
    if ((x.status === 'emergency') !== (y.status === 'emergency')) return true
    if (x.intervals.length !== y.intervals.length) return true
    for (const [i, p] of x.intervals.entries()) {
      const q = y.intervals[i]!
      if (
        p.kind !== q.kind ||
        Date.parse(p.from) !== Date.parse(q.from) ||
        Date.parse(p.to) !== Date.parse(q.to)
      )
        return true
    }
  }
  return false
}
