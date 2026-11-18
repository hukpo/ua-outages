import { makeDay, type MinuteSlot } from '../schedule.js'
import { kyivDate, kyivMinuteOfDay } from '../time.js'
import type { DaySchedule, DayStatus, GroupId, Interval } from '../types.js'
import { layerPublications, type Publication } from './posts.js'

/**
 * One fold for every source of a region. Whatever a source is (a JSON API, an HTML table, posts,
 * pictures), what it says about a day is a `Publication`: the day, when it was published, the
 * part of the day it covers, and each group's hours. All of a region's publications, of all its
 * sources, are put together here, oldest first, the way `layerPublications` documents: a whole
 * day replaces what was before, a window or an update replaces its hours, a correction adds to
 * them, a cancellation leaves the day not known.
 */

/** A publication with where it came from and when */
export interface SourcedPublication {
  /** Index of the source (its `SourceSpec`) */
  source: number
  date: string
  /** Published at, ms; -Infinity when the source doesn't say (it sorts before every real one) */
  at: number
  /** Among the same time and source, the higher is newer */
  seq: number
  pub: Publication
  /** The time as the source wrote it, kept for `updatedAt` */
  iso?: string | null
}

/** A day as the fold made it */
export interface FoldedDay {
  groups: Record<GroupId, DaySchedule>
  /** Sources that published something about the day, by index */
  sources: number[]
  /** The source of the newest publication about the day (it shaped the day last), and when */
  winner: number
  at: number
  /** …as the source wrote it */
  iso: string | null
  cancelled: boolean
}

/** Instant of an ISO time; none (or unreadable) sorts before every real one */
export function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

/** A day's intervals → minute slots of that day (Kyiv wall clock; the next midnight is 1440) */
export function intervalsToSlots(date: string, intervals: readonly Interval[]): MinuteSlot[] {
  return intervals.map((i) => {
    const from = new Date(i.from)
    const to = new Date(i.to)
    return {
      start: kyivDate(from) === date ? kyivMinuteOfDay(from) : 0,
      end: kyivDate(to) === date ? kyivMinuteOfDay(to) : 1440,
      kind: i.kind,
    }
  })
}

/** A whole day, as a source that gives days (an API, a table) has it → one publication */
export function dayPublication(
  date: string,
  schedules: Record<GroupId, DaySchedule>,
  opts: { cancelled?: boolean; partial?: boolean } = {},
): Publication | null {
  if (opts.cancelled) return { groups: {}, from: 0, cancelled: true }
  const groups: Record<GroupId, MinuteSlot[] | null> = {}
  const status: Record<GroupId, DayStatus> = {}
  let published = !!opts.partial
  for (const [g, d] of Object.entries(schedules)) {
    if (d.status === 'unknown') {
      groups[g] = null
      continue
    }
    published = true
    groups[g] = intervalsToSlots(date, d.intervals)
    if (d.status !== 'scheduled') status[g] = d.status
  }
  // a day that says nothing ("not published here") is no publication
  if (!published) return null
  return { groups, from: 0, omitted: 'unknown', ...(Object.keys(status).length ? { status } : {}) }
}

/** Oldest first: by time; among the same time, a later source in the list is older (the earlier spec wins a tie), then by `seq` */
const order = (a: SourcedPublication, b: SourcedPublication) =>
  a.at - b.at || b.source - a.source || a.seq - b.seq || 0

/** Layered publications → each group's day */
function toDays(
  date: string,
  pubs: readonly Publication[],
  groups: readonly GroupId[],
): {
  days: Record<GroupId, DaySchedule>
  cancelled: boolean
} {
  const day = layerPublications(pubs)
  const out: Record<GroupId, DaySchedule> = {}
  for (const g of new Set([...groups, ...Object.keys(day.groups)])) {
    const slots = day.groups[g]
    if (day.cancelled || slots === null) out[g] = { date, status: 'unknown', intervals: [] }
    else if (slots) out[g] = makeDay(date, slots, day.status[g])
    // a group the day's whole list leaves out: none, when that list names only the groups that
    // have outages; otherwise not known
    else
      out[g] =
        day.based && day.omitted === 'none' ? makeDay(date, []) : { date, status: 'unknown', intervals: [] }
  }
  return { days: out, cancelled: day.cancelled }
}

/**
 * Every publication of every source → per date, the day as they make it together, and which
 * sources published what (for `SourceStatus`)
 */
export function foldPublications(
  pubs: readonly SourcedPublication[],
  groups: readonly GroupId[],
): Map<string, FoldedDay> {
  const byDate = new Map<string, SourcedPublication[]>()
  for (const p of pubs) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
  const out = new Map<string, FoldedDay>()
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!.sort(order)
    const newest = list.at(-1)!
    const { days, cancelled } = toDays(
      date,
      list.map((p) => p.pub),
      groups,
    )
    out.set(date, {
      groups: days,
      sources: [...new Set(list.map((p) => p.source))],
      winner: newest.source,
      at: newest.at,
      iso: newest.iso ?? (Number.isFinite(newest.at) ? new Date(newest.at).toISOString() : null),
      cancelled,
    })
  }
  return out
}

/** What one source alone makes of a day (to tell whether it disagrees with the result) */
export function foldOne(
  pubs: readonly SourcedPublication[],
  source: number,
  date: string,
  groups: readonly GroupId[],
): { days: Record<GroupId, DaySchedule>; cancelled: boolean } {
  return toDays(
    date,
    pubs
      .filter((p) => p.source === source && p.date === date)
      .sort(order)
      .map((p) => p.pub),
    groups,
  )
}
