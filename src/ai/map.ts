import type { Announcement } from '../emergency/status.js'
import type { MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { RegionId } from '../types.js'
import type { ClockInterval, PostEvent, PostRegion } from './types.js'
import { clockMinutes } from './validate.js'

/**
 * Checked processor answers → the SDK's own internal shapes: `Announcement`s for the emergency
 * state machine (`foldEvents`), minute slots for the schedule layering (`layerPublications`).
 */

/** "HH:MM" on `day` as an instant; as an end, "24:00" (or "23:59") is the next midnight */
function clockInstant(day: string, hhmm: string, end = false): Date {
  const m = clockMinutes(hhmm, end)
  return m === 1440 ? kyivInstant(addDays(day, 1), 0) : kyivInstant(day, m)
}

/**
 * When an event took effect: its time on its day. A day of its own without a time: the start of
 * that day ("Завтра діятимуть ГАВ" is not in force tonight). No day named: the day of the post,
 * or the day before when that would put it more than 12 h after the post ("О 23:55 скасовано"
 * posted at 00:20 is last night); "сьогодні о 19:00" posted at 00:30 is tonight.
 */
export function eventInstant(
  ev: Pick<PostEvent, 'date' | 'at'> & { dateNamed?: boolean },
  posted: string,
): { at: string; timed: boolean } {
  const postedMs = Date.parse(posted)
  const postDay = kyivDate(new Date(postedMs))
  if (!ev.at) {
    if (ev.date && ev.date !== postDay) return { at: toKyivIso(kyivInstant(ev.date, 0)), timed: true }
    return { at: posted, timed: false }
  }
  let t = clockInstant(ev.date ?? postDay, ev.at)
  if (!ev.date && !ev.dateNamed && t.getTime() - postedMs > 12 * 3600_000)
    t = clockInstant(addDays(postDay, -1), ev.at)
  return { at: toKyivIso(t), timed: true }
}

const ACTION = { start: 'apply', cancel: 'cancel', change: 'update' } as const

/** The emergency events of one post about `region` → announcements, in post order */
export function toAnnouncements(
  events: readonly PostEvent[],
  region: RegionId,
  regionInfo: PostRegion,
  posted: string,
): Announcement[] {
  const out: Announcement[] = []
  for (const ev of events) {
    if (ev.kind === 'gpv' || ev.kind === 'other' || !ev.action || !ev.regions.includes(region)) continue
    const { at, timed } = eventInstant(ev, posted)
    const fullVolume =
      ev.kind === 'gav' && regionInfo.emergencyQueues.length ? regionInfo.emergencyQueues.length : null
    let queues: string[] | null = ev.queues.length ? ev.queues : null
    let count = ev.queueCount ?? (queues ? queues.length : null)
    // "в повному обсязі": all ten of an operator with a fixed ГАВ set
    if (ev.allQueues && !queues && fullVolume) {
      queues = [...regionInfo.emergencyQueues]
      count = fullVolume
    } else if (ev.allQueues && count === null) count = fullVolume
    const day = ev.date ?? kyivDate(new Date(Date.parse(at)))
    out.push({
      action: ACTION[ev.action],
      kind: ev.kind,
      at,
      timed,
      queues,
      restored: ev.queuesRestored.length ? ev.queuesRestored : null,
      count,
      all: ev.allQueues,
      add: ev.additive,
      again: ev.again,
      partial: ev.action === 'cancel' && !ev.allQueues && (!!queues || count !== null),
      scheduleApplies: ev.gpvApplies,
      area: ev.area,
      edited: ev.addedInEdit,
      until: ev.until ? toKyivIso(clockInstant(day, ev.until, true)) : null,
    })
  }
  return out
}

/** Clock intervals → minute slots of one day */
export function toSlots(list: readonly ClockInterval[]): MinuteSlot[] {
  return list.map((i) => ({ start: clockMinutes(i.from), end: clockMinutes(i.to, true), kind: i.kind }))
}
