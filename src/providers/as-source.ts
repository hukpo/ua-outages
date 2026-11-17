import type { DaySchedule, GroupId, RegionSchedule } from '../types.js'
import type { SourceRead } from './sources.js'

/**
 * A provider's whole result as one `mergeSources` channel, so a region with a single channel
 * reports `sources` like the others: every day it has, published at the result's `updatedAt`.
 */
export function asSource(schedule: RegionSchedule): SourceRead {
  const days: SourceRead['days'] = {}
  for (const [group, list] of Object.entries(schedule.schedules) as [GroupId, DaySchedule[]][])
    for (const day of list)
      (days[day.date] ??= { schedules: {}, publishedAt: schedule.updatedAt }).schedules[group] = day
  return { days, groups: schedule.groups }
}

/** Dates remembered at most; a channel has two or three days at a time */
const REMEMBERED_DAYS = 8

/**
 * For a channel with one change time for everything it shows (YASNO's newest `updatedOn`, DTEK's
 * `fact.update`): that time moves when tomorrow comes out or another day changes, and would then
 * date today's untouched hours as new, so that they beat a correction another channel published
 * in between. The returned function remembers, per date, the content it last saw and the earliest
 * time that content came with, and gives a day whose content didn't change that time again.
 *
 * One memory per channel of one provider (so per client). The first reading of a day can't know
 * better and keeps the channel's time, as does a day whose content changed. At most
 * `REMEMBERED_DAYS` dates are kept, and none older than the oldest the channel still shows.
 */
export function steadyStamps(): (read: SourceRead) => SourceRead {
  const seen = new Map<string, { content: string; publishedAt: string | null }>()
  return (read) => {
    const days: SourceRead['days'] = {}
    for (const [date, day] of Object.entries(read.days)) {
      const content = contentOf(day)
      const before = seen.get(date)
      const publishedAt =
        before?.content === content ? earlier(before.publishedAt, day.publishedAt) : day.publishedAt
      seen.set(date, { content, publishedAt })
      days[date] = { ...day, publishedAt }
    }
    const oldest = Object.keys(read.days).sort()[0]
    const dates = [...seen.keys()].sort()
    dates.forEach((date, i) => {
      if ((oldest && date < oldest) || i < dates.length - REMEMBERED_DAYS) seen.delete(date)
    })
    return { ...read, days }
  }
}

/** What a day says, whatever order its groups come in */
function contentOf(day: SourceRead['days'][string]): string {
  const groups = Object.keys(day.schedules).sort()
  return JSON.stringify([
    !!day.cancelled,
    groups.map((g) => [g, day.schedules[g]!.status, day.schedules[g]!.intervals]),
  ])
}

/** The earlier of two times; one that is missing or unreadable gives way to the other */
function earlier(a: string | null, b: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  if (!Number.isFinite(ta)) return b
  if (!Number.isFinite(tb)) return a
  return ta <= tb ? a : b
}
