/**
 * Region ids, one per grid operator area. Not covered: Vinnytsia (data behind a bot check),
 * Kherson (no public schedule), Luhansk and Crimea.
 */
export type RegionId =
  | 'kyiv'
  | 'kyiv-region'
  | 'dnipro'
  | 'dnipro-cek'
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
  | 'chernihiv'
  | 'zhytomyr'
  | 'cherkasy'
  | 'kirovohrad'
  | 'sumy'
  | 'kharkiv'
  | 'poltava'
  | 'zaporizhzhia'
  | 'mykolaiv'
  // АТ «Укрзалізниця»: homes wired to the railway's grid, one per oblast page (two branches in Vinnytsia and Sumy)
  | 'uz-kyiv'
  | 'uz-vinnytsia'
  | 'uz-vinnytsia-odesa'
  | 'uz-volyn'
  | 'uz-dnipro'
  | 'uz-donetsk'
  | 'uz-zhytomyr'
  | 'uz-zakarpattia'
  | 'uz-zaporizhzhia'
  | 'uz-ivano-frankivsk'
  | 'uz-kyiv-region'
  | 'uz-kirovohrad'
  | 'uz-lviv'
  | 'uz-mykolaiv'
  | 'uz-odesa'
  | 'uz-poltava'
  | 'uz-rivne'
  | 'uz-sumy'
  | 'uz-sumy-south'
  | 'uz-ternopil'
  | 'uz-kharkiv'
  | 'uz-kherson'
  | 'uz-khmelnytskyi'
  | 'uz-cherkasy'
  | 'uz-chernivtsi'
  | 'uz-chernihiv'

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
    /** False when the operator publishes the schedule only as an image; `getSchedules` then throws `unsupported` */
    schedule: boolean
    /** Can find a group from a street address (`findGroup`) */
    addressSearch: boolean
    /** Has street/settlement directories for autocomplete (`searchStreets`); filled in by the client */
    streetSearch?: boolean
    /** `getEmergency` has a source for this region (ГАВ / СГАВ announcements); filled in by the client */
    emergency: boolean
  }
}

/**
 * What a provider declares about itself: `RegionInfo` without the capabilities the client
 * works out (`streetSearch`, `emergency`).
 */
export type ProviderInfo = Omit<RegionInfo, 'capabilities'> & {
  capabilities: Omit<RegionInfo['capabilities'], 'emergency' | 'streetSearch'> &
    Partial<Pick<RegionInfo['capabilities'], 'emergency' | 'streetSearch'>>
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

/**
 * Silence is never "no outages": only `no-outages` days, or `scheduled` days without intervals,
 * mean that. When the operator publishes nothing, its groups are listed with `unknown` days, or,
 * when the SDK can't tell which groups it has, `groups` is empty. Both mean "not published".
 */
export interface RegionSchedule {
  region: RegionId
  /** Every group the operator publishes, sorted. Empty: nothing published and groups unknown, not "no outages" */
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
  /** How well it matched the search, 0..1 (search results only) */
  score?: number
  /** District / community, when the source gives it */
  district?: string
}

export interface Street {
  id: string
  name: string
  /** How well it matched the search, 0..1 (search results only) */
  score?: number
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
  /** District or community, to tell apart villages with the same name */
  district?: string
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
  /** Emergency queues of the address (ГАВ, СГАВ, АЧР); omitted when the operator says nothing */
  emergency?: EmergencyQueues
}

/**
 * Emergency schedules besides ГПВ: ГАВ, СГАВ (special ГАВ), АЧР (automatic frequency load
 * shedding). Their queues are numbered separately from ГПВ groups ("3", "10"; Mykolaiv also
 * has reserve queues "1(Р)").
 */
export interface EmergencyQueues {
  /** ГАВ queues, distinct, sorted numerically, as the operator writes them ("3", "10", "1(Р)") */
  gav?: string[]
  sgav?: string[]
  achr?: string[]
}

// --- emergency status ---

export type EmergencyState = 'active' | 'inactive' | 'unknown'

/**
 * What `getEmergency` knows about ГАВ / СГАВ / emergency shutdowns in a region right now.
 *
 * How to tell the cases apart:
 * - in force: `state: 'active'`, `since` and `message` (the newest announcement) set;
 * - cancelled: `state: 'inactive'` with `message` (the cancellation post, or the source's own
 *   signal) and `endedAt` both set;
 * - ended by the TTL: `state: 'inactive'`, `inferred: true`, `endedAt` set, `message` = the last
 *   announcement;
 * - nothing announced in the lookback window (48 h): `state: 'inactive'`, `kind`, `message` and
 *   `endedAt` all null;
 * - can't be told: `state: 'unknown'` (the newest post can't be read; a partial or area-only
 *   cancel with nothing known before it, e.g. "скасовано ГАВ для 6-10 черг"; or a source failed
 *   while the others said nothing is in force).
 *
 * A post that takes effect later ("О 19:00 - заміна черг" posted 18:52, "з 18:00 будуть
 * застосовуватися") counts only from that time.
 */
export interface EmergencyStatus {
  region: RegionId
  /**
   * active: ГАВ / СГАВ / emergency shutdowns are in force now.
   * inactive: the last word was a cancellation, or nothing announced recently.
   * unknown: the source answered but can't be read with confidence (never thrown for "nothing posted").
   */
  state: EmergencyState
  /** What is (or was last) in force; null when nothing was announced in the lookback window */
  kind: 'gav' | 'sgav' | 'emergency' | null
  /** ГПВ still applies alongside ("Також продовжують діяти ГПВ") true; suspended false; not said null */
  scheduleApplies: boolean | null
  /** Start: the time named in the text ("з 10:35", "О 9:44"), else the post time. ISO with the Kyiv offset */
  since: string | null
  /**
   * For inactive: when it was cancelled (time in the text, else the post time; for an "UPD …
   * скасовано" edit the post's own time, Telegram doesn't show when it was edited), or the
   * inferred end. Null only when nothing was announced.
   */
  endedAt: string | null
  /** ГАВ/СГАВ queues that are off now when the operator names them; null when not said */
  queues: string[] | null
  /** "застосовано 10 черг" without saying which: the count; null when not said */
  queueCount: number | null
  /**
   * When limited to a part of the region ("м. Дніпро", "частині Голосіївського та Соломʼянського
   * районів"); several areas on at once are joined with "; ". null = whole region / not said
   */
  area: string | null
  /** True when the end (or state) is inferred, not announced: no cancel post within the TTL */
  inferred: boolean
  /** The newest announcement this status is based on */
  message: { text: string; url: string | null; at: string } | null
  source: 'telegram' | 'api' | 'yasno' | 'ukrenergo'
  fetchedAt: string
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
