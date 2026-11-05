/** Region ids, one per grid operator area. Cities with their own operator get their own id. */
export type RegionId =
  | 'kyiv'
  | 'kyiv-region'
  | 'dnipro'
  | 'dnipro-region'
  | 'odesa'
  | 'donetsk'
  | 'lviv'
  | 'ivano-frankivsk'
  | 'zakarpattia'
  | 'ternopil'
  | 'rivne'
  | 'volyn'
  | 'chernivtsi'
  | 'khmelnytskyi'
  | 'vinnytsia'
  | 'zhytomyr'
  | 'chernihiv'
  | 'cherkasy'
  | 'kirovohrad'
  | 'sumy'
  | 'kharkiv'
  | 'poltava'
  | 'zaporizhzhia'
  | 'mykolaiv'
  | 'kherson'

/** Outage group (queue, "черга"), normalized to "<queue>.<subqueue>", e.g. "3.1". */
export type GroupId = string

export interface RegionInfo {
  id: RegionId
  /** Ukrainian name, e.g. "Львівська область" */
  name: string
  /** Grid operator that publishes the schedule, e.g. "Львівобленерго" */
  operator: string
  /** Page where people can see the schedule themselves */
  website: string
  capabilities: {
    schedule: boolean
    /** Can find a group from a street address */
    addressSearch: boolean
  }
}

/**
 * - `off`: power is scheduled to be off
 * - `maybe`: possible outage ("можливе відключення"), depends on the grid situation
 */
export type IntervalKind = 'off' | 'maybe'

export interface Interval {
  /** ISO 8601 with the Kyiv offset, e.g. "2026-11-05T08:00:00+02:00" */
  from: string
  to: string
  kind: IntervalKind
}

/**
 * - `scheduled`: a schedule applies for this day (intervals may still be empty)
 * - `no-outages`: the operator says there are no outages that day
 * - `emergency`: emergency outages ("аварійні") — the planned schedule doesn't apply
 * - `unknown`: not published yet or the source didn't say
 */
export type DayStatus = 'scheduled' | 'no-outages' | 'emergency' | 'unknown'

export interface DaySchedule {
  /** Calendar day in Kyiv, "YYYY-MM-DD" */
  date: string
  status: DayStatus
  /** Sorted, non-overlapping */
  intervals: Interval[]
}

export interface GroupSchedule {
  region: RegionId
  group: GroupId
  days: DaySchedule[]
  /** When the operator last changed the schedule, ISO; null if the source doesn't say */
  updatedAt: string | null
  /** When this SDK fetched it, ISO */
  fetchedAt: string
}

export interface RegionSchedule {
  region: RegionId
  /** Every group the operator publishes, sorted */
  groups: GroupId[]
  /** group → days */
  schedules: Record<GroupId, DaySchedule[]>
  updatedAt: string | null
  fetchedAt: string
}

// --- address search ---

export interface City {
  id: string
  name: string
  /** District / community, when the source gives it */
  district?: string
}

export interface Street {
  id: string
  name: string
  cityId?: string
}

export interface House {
  id: string
  /** House number as the operator writes it, e.g. "12", "12-А", "12 корп. 3" */
  number: string
  streetId: string
}

export interface AddressQuery {
  /** Needed in regions with more than one settlement */
  city?: string
  street: string
  house: string
}

export interface GroupMatch {
  region: RegionId
  group: GroupId
  /** Address as the operator spells it */
  address: { city?: string; street: string; house: string }
  /** Some addresses belong to several groups (e.g. a building with two inputs) */
  otherGroups?: GroupId[]
}

// --- health ---

export type HealthStatus =
  /** Fetched and parsed, data looks current */
  | 'ok'
  /** Fetched and parsed, but the operator hasn't updated it for a while */
  | 'stale'
  /** Fetched fine, but there is no schedule (often simply means no outages now) */
  | 'empty'
  /** Network error, unexpected format, blocked by a firewall, … */
  | 'error'

export interface RegionHealth {
  region: RegionId
  status: HealthStatus
  latencyMs: number
  groups: number
  updatedAt: string | null
  /** Human-readable reason for anything that isn't `ok` */
  message?: string
  /** Result of the sample address lookup, when requested */
  address?: { ok: boolean; group?: GroupId; message?: string }
}
