import { compareGroups, makeDay } from '../schedule.js'
import { addDays, kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, RegionId, RegionSchedule } from '../types.js'
import { findUaDate, parseGroupLines } from './ua-text.js'

/**
 * Operators that publish each day's schedule as a news post ("ГПВ на 6 листопада":
 * "1.1 00:00-03:00; 08:00-13:30"). Corrections arrive as newer posts for the same date.
 */
export interface SchedulePost {
  title: string
  /** HTML or text */
  body: string
  /** When the post was published or last edited, ISO */
  publishedAt: string
}

/**
 * Newest post per date wins. Posts without group lines (announcements, emergency notices)
 * are ignored. Only yesterday and later is kept.
 */
export function postsToSchedule(region: RegionId, posts: readonly SchedulePost[], now: Date): RegionSchedule {
  const byDate = new Map<string, { at: number; groups: ReturnType<typeof parseGroupLines> }>()
  const from = addDays(kyivDate(now), -1)

  for (const p of posts) {
    const at = Date.parse(p.publishedAt)
    const ref = Number.isFinite(at) ? new Date(at) : now
    // the title names the day; fall back to the first date in the text
    const date = findUaDate(p.title, ref) ?? findUaDate(p.body.replace(/<[^>]+>/g, ' ').slice(0, 600), ref)
    if (!date || date < from) continue
    // a schedule is published at most a couple of days ahead; anything else is a misread
    if (Math.abs(Date.parse(date) - Date.parse(kyivDate(ref))) > 3 * 86_400_000) continue
    const groups = parseGroupLines(p.body)
    if (!Object.keys(groups).length) continue
    const prev = byDate.get(date)
    if (!prev || at > prev.at) byDate.set(date, { at, groups })
  }

  const dates = [...byDate.keys()].sort()
  const groupSet = new Set<string>()
  for (const d of byDate.values()) for (const g of Object.keys(d.groups)) groupSet.add(g)
  const groups = [...groupSet].sort(compareGroups)

  const schedules: Record<string, DaySchedule[]> = {}
  for (const g of groups)
    schedules[g] = dates.map((d) => {
      const slots = byDate.get(d)!.groups[g]
      // a group missing from that day's post: we don't know, rather than "no outages"
      return slots ? makeDay(d, slots) : { date: d, status: 'unknown' as const, intervals: [] }
    })

  const newest = Math.max(0, ...[...byDate.values()].map((d) => d.at).filter(Number.isFinite))
  return {
    region,
    groups,
    schedules,
    updatedAt: newest ? toKyivIso(new Date(newest)) : null,
    fetchedAt: toKyivIso(now),
  }
}
