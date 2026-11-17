import { intervalAt, nextOutage } from './schedule.js'
import { kyivDate } from './time.js'
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
 *    is `off` if its queue is among them and the emergency is passed over if not. Otherwise
 *    it is `maybe`, unless the hourly schedule still applies alongside and has the house off now;
 * 3. the group's schedule for today: an outage now is `off` (until the end of the run of
 *    outages), a "possible" half hour `maybe`, a day the schedule marks as emergency `maybe`, a
 *    published day without an outage now `on`, an unpublished one `unknown`.
 *
 * Exported for tests; `OutageClient.getHouseStatus` reads the inputs.
 */
export function decideHouseStatus(i: HouseStatusInputs): Omit<HouseStatus, 'fetchedAt'> {
  const groups: GroupId[] = i.match
    ? [i.match.group, ...(i.match.otherGroups ?? [])]
    : (i.outage?.groups ?? [])
  const days = i.days ?? []
  const today = days.find((d) => d.date === kyivDate(i.now))
  const scheduled = today ? intervalAt([today], i.now) : null
  // back-to-back outages are one, past midnight too
  const endOfOutage = () => nextOutage(days, i.now, { includeCurrent: true })?.to ?? scheduled!.to

  const base = {
    region: i.region,
    address: i.match?.address ?? i.outage?.address ?? null,
    groups,
    scheduled,
    nextOutage: nextOutage(days, i.now),
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

  // 1. the house itself
  if (i.outage) return result('off', 'house-outage', i.outage.to)

  // 2. the region's emergency
  const e = i.emergency
  if (e?.state === 'active') {
    const mine = e.kind === 'sgav' ? i.match?.emergency?.sgav : i.match?.emergency?.gav
    const named = e.queues && mine?.length && e.area === null
    if (named && mine!.some((q) => e.queues!.includes(q))) return result('off', 'emergency', null)
    if (!named) {
      if (scheduled?.kind === 'off' && e.scheduleApplies !== false)
        return result('off', 'schedule', endOfOutage())
      return result('maybe', 'emergency', null)
    }
    // the operator named the queues that are off, and the house's isn't one of them
  }

  // 3. the schedule
  if (!today) return result('unknown', 'none', null)
  if (scheduled?.kind === 'off') return result('off', 'schedule', endOfOutage())
  if (scheduled?.kind === 'maybe') return result('maybe', 'schedule', scheduled.to)
  if (today.status === 'emergency') return result('maybe', 'emergency', null)
  if (today.status === 'unknown') return result('unknown', 'none', null)
  return result('on', 'schedule', null)
}
