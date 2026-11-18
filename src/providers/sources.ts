import { OutageError } from '../errors.js'
import { compareGroups } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule, SourceStatus } from '../types.js'
import { dayPublication, foldOne, foldPublications, time, type SourcedPublication } from './fold.js'
import { isWhole, type Publication } from './posts.js'
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
    {
      schedules: Record<GroupId, DaySchedule>
      publishedAt: string | null
      cancelled?: boolean
      /**
       * A newer post of the channel about the day couldn't be read (why): the day is as the posts
       * read make it, and may be behind (it is read again on a later poll)
       */
      unread?: string
      /** Only part of the day was published, with no whole day under it: `unknown` too, as of then */
      partial?: boolean
    }
  >
  /**
   * What a reader of posts or pictures publishes, as it was published (whole days, windows,
   * corrections, cancellations): layered with every other channel's publications, oldest first
   */
  publications?: SourcePublication[]
  /**
   * Its posts or pictures that couldn't be read (yet): each flags the days it may be about, until
   * a newer whole day of any channel stands in for it
   */
  unread?: SourceUnread[]
  /** Groups this channel knows of, listed in the result even when no day names them */
  groups?: GroupId[]
  /** Where exactly it was read (e.g. the post), when more precise than `SourceSpec.url` */
  url?: string
}

/** One publication of a channel (see `Publication`) */
export interface SourcePublication {
  date: string
  /** When it was published, ISO; null when the channel doesn't say */
  at: string | null
  /** Among the same time, the higher is newer (a message id) */
  seq?: number
  pub: Publication
}

/** A post or picture of a channel that couldn't be read (yet) */
export interface SourceUnread {
  /** The days it may be about */
  days: string[]
  at: string | null
  seq?: number
  message: string
}

export interface SourceSpec {
  /** Stable name of the channel: 'site', 'api', 'telegram:@channel'. Ends up in `SourceStatus.id` */
  id: string
  /** Where a person can see the same data, or null */
  url: string | null
  /** `false` for a channel that isn't the operator's own (a community mirror); copied to `SourceStatus` */
  official?: false
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
    const base = {
      id: spec.id,
      url: reads[i]?.url ?? spec.url,
      dates: [],
      updatedAt: null,
      ...(spec.official === false ? { official: false as const } : {}),
    }
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
  const pubs: SourcedPublication[] = []
  reads.forEach((r, source) => {
    if (!r) return
    for (const g of r.groups ?? []) groupSet.add(g)
    for (const [date, day] of Object.entries(r.days)) {
      dateSet.add(date)
      for (const g of Object.keys(day.schedules)) groupSet.add(g)
      // a source that gives days: each is one whole publication, as of when it says
      const pub = dayPublication(date, day.schedules, day)
      if (pub) pubs.push({ source, date, at: time(day.publishedAt), iso: day.publishedAt, seq: 0, pub })
    }
    for (const p of r.publications ?? []) {
      dateSet.add(p.date)
      for (const g of Object.keys(p.pub.groups)) groupSet.add(g)
      pubs.push({ source, date: p.date, at: time(p.at), iso: p.at, seq: p.seq ?? 0, pub: p.pub })
    }
  })
  // a post or picture that couldn't be read: its days flagged, until a newer whole day of any
  // channel stands in for it (the same time is newer only on the same channel, by its order)
  const today = kyivDate(ctx.now())
  const flagged = new Map<number, Map<string, string>>()
  reads.forEach((r, source) => {
    for (const u of r?.unread ?? []) {
      const at = time(u.at)
      for (const date of u.days) {
        if (date < today) continue
        // with no time of its own (a page), only a newer one on its own page is known to be newer
        const covered = pubs.some(
          (p) =>
            p.date === date &&
            isWhole(p.pub) &&
            ((p.at > at && Number.isFinite(at)) ||
              (p.at === at && p.source === source && p.seq > (u.seq ?? 0))),
        )
        if (covered) continue
        const mine = flagged.get(source) ?? new Map<string, string>()
        if (!mine.has(date)) mine.set(date, u.message)
        flagged.set(source, mine)
        dateSet.add(date)
      }
    }
  })
  const groups = [...groupSet].sort(compareGroups)
  const dates = [...dateSet].sort()
  if (!dates.length) dates.push(kyivDate(ctx.now()))

  // every source's publications, together
  const folded = foldPublications(pubs, groups)
  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of groups) schedules[g] = []
  let updated = -Infinity
  let updatedIso: string | null = null
  for (const date of dates) {
    const day = folded.get(date)
    for (const g of groups) schedules[g]!.push(day?.groups[g] ?? { date, status: 'unknown', intervals: [] })
    if (!day) continue
    const status = statuses[day.winner]!
    status.dates.push(date)
    if (day.at > updated) {
      updated = day.at
      updatedIso = day.iso
    }
    if (day.at > time(status.updatedAt)) status.updatedAt = day.iso
    // another source that published the day another way: behind, or the trace if the newer is wrong
    for (const i of day.sources) {
      if (i === day.winner) continue
      const own = foldOne(pubs, i, date, groups)
      // a schedule on one channel and a cancellation on the other is a disagreement too
      if (own.cancelled !== day.cancelled || differ(day.groups, own.days)) statuses[i]!.disagrees = true
    }
  }
  // the days a channel couldn't read, and why
  reads.forEach((r, i) => {
    const unread = [
      ...Object.entries(r?.days ?? {})
        .filter(([, d]) => d.unread)
        .map(([date, d]) => ({ date, message: d.unread! })),
      ...[...(flagged.get(i) ?? [])].map(([date, message]) => ({ date, message })),
    ].sort((a, b) => a.date.localeCompare(b.date))
    if (unread.length) statuses[i]!.unread = unread
  })
  // a channel that won no day still says when it last published something
  statuses.forEach((status, i) => {
    if (status.dates.length) return
    const newest = pubs.filter((p) => p.source === i).sort((a, b) => b.at - a.at)[0]
    if (newest && Number.isFinite(newest.at)) status.updatedAt = newest.iso ?? toKyivIso(new Date(newest.at))
  })

  return {
    region,
    groups,
    schedules,
    updatedAt: Number.isFinite(updated) ? updatedIso : null,
    fetchedAt: toKyivIso(ctx.now()),
    sources: statuses,
  }
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
