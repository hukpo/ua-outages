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
