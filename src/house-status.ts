import { intervalAt, nextOutage } from './schedule.js'
import { addDays, kyivDate } from './time.js'
import type {
  DaySchedule,
  EmergencyStatus,
  GroupId,
  GroupMatch,
  HouseOutage,
  HouseStatus,
  HouseStatusGap,
  RegionId,
} from './types.js'

export interface HouseStatusInputs {
  region: RegionId
  now: Date
  /** `findGroup` of the address; null when it failed */
  match: GroupMatch | null
  /** `getHouseOutage`; null when none or not available */
  outage: HouseOutage | null
  /** `getEmergency`; null when not available */
  emergency: EmergencyStatus | null
  /** The days of the house's first group; null when not available */
  days: DaySchedule[] | null
  gaps: HouseStatusGap[]
}

/**
 * The state of a house from what was read about it, most specific first:
 *
 * 1. the operator's record of the house: it names this house, so it wins;
 * 2. a ГАВ / СГАВ in force in the region. When the operator names the queues that are off, the
 *    house's own emergency queue is known and the emergency covers the whole region, the house
 *    is `off` if its queue is among them; if not, the emergency passes it over (and with the
 *    schedule suspended, `scheduleApplies: false`, nothing else has it off). Otherwise it is
 *    `maybe`, unless the operator says the hourly schedule still applies alongside
 *    (`scheduleApplies: true`) and that has the house off now;
 * 3. the group's schedule. Only days the operator published as `scheduled` are read, today
 *    and tomorrow: an outage now is `off` (until the end of the run of outages, past midnight
 *    when tomorrow is published), a "possible" half hour `maybe`, a day marked emergency
 *    `maybe`, a `no-outages` day or a published day without an outage now `on`, anything else
 *    `unknown`.
 *
 * `on` needs every part the region has: a per-house record or emergency feed that failed (a
 * gap with a code other than `unsupported`), or an emergency status that is `unknown`, makes
 * it `unknown` instead. A read that failed is not a read that found nothing.
 *
 * Exported for tests; `OutageClient.getHouseStatus` reads the inputs.
 */
export function decideHouseStatus(i: HouseStatusInputs): Omit<HouseStatus, 'fetchedAt'> {
  const groups: GroupId[] = i.match
    ? [i.match.group, ...(i.match.otherGroups ?? [])]
    : (i.outage?.groups ?? [])
  const date = kyivDate(i.now)
  const tomorrow = addDays(date, 1)
  const today = (i.days ?? []).find((d) => d.date === date)
  // what the operator published: preliminary slots of an unknown day, or the slots of a day it
  // suspended, don't say when power goes or comes back
  const published = (i.days ?? []).filter(
    (d) => d.status === 'scheduled' && (d.date === date || d.date === tomorrow),
  )
  const scheduled = today?.status === 'scheduled' ? intervalAt([today], i.now) : null
  // back-to-back outages are one, past midnight too
  const endOfOutage = () => nextOutage(published, i.now, { includeCurrent: true })?.to ?? scheduled!.to

  const base = {
    region: i.region,
    address: i.match?.address ?? i.outage?.address ?? null,
    groups,
    scheduled,
    nextOutage: nextOutage(published, i.now),
    houseOutage: i.outage,
    emergency: i.emergency,
    gaps: i.gaps,
  }
  const result = (state: HouseStatus['state'], basis: HouseStatus['basis'], until: string | null) => ({
    ...base,
    state,
    basis,
    until,
  })
  // `on` only when nothing the region has could have said otherwise
  const doubt =
    i.emergency?.state === 'unknown' ||
    i.gaps.some((g) => (g.part === 'house-outage' || g.part === 'emergency') && g.code !== 'unsupported')
  const on = (basis: HouseStatus['basis']) =>
    doubt ? result('unknown', 'none', null) : result('on', basis, null)

  // 1. the house itself
  if (i.outage) return result('off', 'house-outage', i.outage.to)

  // 2. the region's emergency
  const e = i.emergency
  if (e?.state === 'active') {
    const mine = e.kind === 'sgav' ? i.match?.emergency?.sgav : i.match?.emergency?.gav
    const named = !!e.queues?.length && !!mine?.length && e.area === null
    if (named && mine!.some((q) => e.queues!.includes(q))) return result('off', 'emergency', null)
    if (!named) {
      if (scheduled?.kind === 'off' && e.scheduleApplies === true)
        return result('off', 'schedule', endOfOutage())
      return result('maybe', 'emergency', null)
    }
    // the operator named the queues that are off, and the house's isn't one of them
    if (e.scheduleApplies === false) return on('emergency')
  }

  // 3. the schedule
  if (!today) return result('unknown', 'none', null)
  if (today.status === 'emergency') return result('maybe', 'emergency', null)
  if (today.status === 'no-outages') return on('schedule')
  if (today.status !== 'scheduled') return result('unknown', 'none', null)
  if (scheduled?.kind === 'off') return result('off', 'schedule', endOfOutage())
  if (scheduled?.kind === 'maybe') return result('maybe', 'schedule', scheduled.to)
  return on('schedule')
}
