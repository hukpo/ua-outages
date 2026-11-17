import type { OutageErrorCode } from './errors.js'

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
  | 'vinnytsia'
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
    /** `getHouseOutage` can tell whether a house is off right now and why; filled in by the client */
    houseOutage?: boolean
  }
}

/**
 * What a provider declares about itself: `RegionInfo` without the capabilities the client
 * works out (`streetSearch`, `emergency`).
 */
export type ProviderInfo = Omit<RegionInfo, 'capabilities'> & {
  capabilities: Omit<RegionInfo['capabilities'], 'emergency' | 'streetSearch' | 'houseOutage'> &
    Partial<Pick<RegionInfo['capabilities'], 'emergency' | 'streetSearch' | 'houseOutage'>>
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
  /** The region's `sources`, see `RegionSchedule.sources` */
  sources?: SourceStatus[]
  /** Set when this is the last good result served instead of a failed fetch, see `RegionSchedule.stale` */
  stale?: StaleInfo
}

/**
 * One channel a provider consulted for a result (the operator's site, its API, its official
 * Telegram channel). Regions that read several channels list each, the failed ones too.
 */
export interface SourceStatus {
  /** Which channel: 'site', 'api', 'telegram:@chernigivoblenergo', … Stable per region */
  id: string
  /** Where a person can see the same data; null when there is no such page */
  url: string | null
  /** False when reading this channel failed; `error` then says why */
  ok: boolean
  /** Days ("YYYY-MM-DD", sorted) this channel supplied to the result: the ones it had the newest data for */
  dates: string[]
  /** When the operator last published on this channel what the SDK read from it, ISO; null if it doesn't say */
  updatedAt: string | null
  error?: { code: OutageErrorCode; message: string }
  /**
   * `false` when this is not the operator's own channel but a community mirror of it, read only
   * with `unofficialSources: true` (Vinnytsia). Absent for every official channel.
   */
  official?: false
  /**
   * Another channel won a day this one also has published data for, and their outage times
   * differ. Usually this channel is simply behind; if the newer one is wrong, this is the trace.
   */
  disagrees?: boolean
}

/** Why a result is the last good one instead of a new one (`staleIfError`). */
export interface StaleInfo {
  /** When the data was fetched, ISO: its `fetchedAt` */
  since: string
  /** The failure of the fetch this result stands in for */
  error: { code: OutageErrorCode; message: string }
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
  /**
   * One entry per channel the provider consulted, in the provider's order (the primary first).
   * Absent for regions that read a single channel and don't report it.
   */
  sources?: SourceStatus[]
  /**
   * Set only by `getSchedules(…, { staleIfError })`: the operator couldn't be read, and this is
   * the last good result (fetched at `stale.since`) instead of an error. Never set on new data.
   */
  stale?: StaleInfo
}

// --- freshness ---

export type FreshnessIssueCode =
  /** No day of any group has published data. Not stale: silence is not staleness */
  | 'nothing-published'
  /** There is published data, but none for today or later (a cancellation of the day counts): the source is stuck on a past day */
  | 'behind'
  /** `updatedAt` is older than `staleAfterHours`, and today isn't published (nor cancelled) */
  | 'not-updated'
  /** A channel of the region failed; the result comes from the others */
  | 'source-failed'
  /** Two channels have different outage times for the same day */
  | 'sources-disagree'
  /** The result is the last good one served instead of a failed fetch (`stale` is set) */
  | 'last-good'
  /** `fetchedAt` is older than `fetchedStaleAfterMinutes`: the caller holds an old object */
  | 'fetched-long-ago'
  /** Tomorrow isn't published although Kyiv time is past `tomorrowExpectedAt` */
  | 'tomorrow-missing'
  /** Today is published for some groups and `unknown` for others */
  | 'partial'

/** What `assessFreshness` says about a schedule. */
export interface Freshness {
  /**
   * - `fresh`: nothing suggests the data is out of date (check `today` before telling a user
   *   about today: `fresh` with `today: 'missing'` happens when only a later day is published);
   * - `stale`: don't present it as current. One of `behind`, `not-updated`, `last-good`,
   *   `fetched-long-ago` is in `issues`;
   * - `unpublished`: the source answered and publishes nothing (`nothing-published`).
   */
  state: 'fresh' | 'stale' | 'unpublished'
  /**
   * Whether any group has published data (status other than `unknown`) for the Kyiv day of `now`.
   * `missing` also for a day the operator called off: published, but with no hours to show
   */
  today: 'published' | 'missing'
  tomorrow: 'published' | 'missing'
  /**
   * Newest date with anything published in any group, or null: a status other than `unknown`,
   * or a day one of `sources` supplied (a day the operator cancelled is `unknown` in every group
   * and is in the `dates` of the channel that cancelled it)
   */
  coveredThrough: string | null
  /** Minutes since the operator last changed it; null when the source doesn't say */
  ageMinutes: number | null
  /** Minutes since the SDK fetched it */
  fetchedMinutesAgo: number
  /** Everything found, stale-making or not; empty when all is well */
  issues: { code: FreshnessIssueCode; message: string }[]
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

// --- one house, now ---

/**
 * Why a house is off, as the operator's site says:
 * - `emergency`: екстрені відключення (ГАВ). The hourly schedule doesn't apply to the house now.
 * - `scheduled`: the hourly schedule's own outage ("стабілізаційне відключення згідно графіку").
 * - `repair`: аварійні ремонтні роботи, local damage (after an attack, a broken line).
 * - `planned`: планові ремонтні роботи.
 * - `other`: a reason not seen before; `reason` has the operator's words.
 */
export type HouseOutageKind = 'emergency' | 'scheduled' | 'repair' | 'planned' | 'other'

/** A house that is off right now, from the operator's per-address record (`getHouseOutage`). */
export interface HouseOutage {
  region: RegionId
  /** Address as the operator spells it */
  address: { city?: string; street: string; house: string }
  kind: HouseOutageKind
  /** The reason as the operator writes it ("Екстренні відключення (Аварійне без застосування …)") */
  reason: string
  /** `false` for `emergency` (the schedule doesn't apply now), `true` for `scheduled`, else `null` */
  scheduleApplies: boolean | null
  /** When it started, ISO with the Kyiv offset; null when the operator gives none */
  from: string | null
  /** When power is expected back: the operator's estimate, often moved */
  to: string | null
  /** Outage groups of the house, as in `GroupMatch` (first = `group`); empty where the source gives none (Zhytomyr) */
  groups: GroupId[]
  /** When the operator last updated its per-house records; null where it doesn't say (all but DTEK) */
  updatedAt: string | null
  /** Where it was read */
  url: string
  fetchedAt: string
}

// --- is the power on at a house ---

/**
 * - `off`: the power is off there now, by what the operator says about the house, its emergency
 *   queue or its schedule group;
 * - `maybe`: it may be off: an emergency (ГАВ) is in force and the house's part in it isn't
 *   known, or the schedule's "possible outage" half hour;
 * - `on`: nothing the SDK can see has it off: the schedule is published for today with no
 *   outage now, no emergency hits the house, and every part the region has (per-house record,
 *   emergency feed) was read and is clear;
 * - `unknown`: not enough to tell (nothing published for today, a source failed, the emergency
 *   status is unknown).
 */
export type HouseState = 'off' | 'maybe' | 'on' | 'unknown'

/** One part of `getHouseStatus` that couldn't be used, and why (`unsupported` where the region has no such source) */
export interface HouseStatusGap {
  part: 'address' | 'house-outage' | 'emergency' | 'schedule'
  code: OutageErrorCode
  message: string
}

/** What `getHouseStatus` concludes about one house now, and everything it concluded it from. */
export interface HouseStatus {
  region: RegionId
  /** Address as the operator spells it; null when no lookup found it */
  address: { city?: string; street: string; house: string } | null
  state: HouseState
  /**
   * What decided `state`:
   * - `house-outage`: the operator's own record of the house (`houseOutage`);
   * - `emergency`: a ГАВ / СГАВ in force in the region (`emergency`), or a day the schedule marks as emergency;
   * - `schedule`: the group's hourly schedule (`scheduled`, `nextOutage`);
   * - `none`: nothing could decide (`unknown`).
   */
  basis: 'house-outage' | 'emergency' | 'schedule' | 'none'
  /** For `off` / `maybe`: when power is expected back, the operator's estimate; null when not known */
  until: string | null
  /** Outage groups of the house (first = the one the schedule is read for); empty when the lookup failed */
  groups: GroupId[]
  /** The schedule's interval in force now for `groups[0]`, if any */
  scheduled: Interval | null
  /** The group's next scheduled outage after now (today or tomorrow), if published */
  nextOutage: Interval | null
  /** The operator's record of an outage at the house; null when none or not available (see `gaps`) */
  houseOutage: HouseOutage | null
  /** The region's emergency status; null when not available (see `gaps`) */
  emergency: EmergencyStatus | null
  /** Parts that couldn't be used: a region without per-house records, a source that failed */
  gaps: HouseStatusGap[]
  fetchedAt: string
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
   * unknown: the source answered but can't be read with confidence, or one of the region's
   * sources failed (or its channel couldn't be read back far enough) while the rest say nothing
   * is in force (never thrown for "nothing posted").
   */
  state: EmergencyState
  /** What is (or was last) in force; null when nothing was announced in the lookback window */
  kind: 'gav' | 'sgav' | 'emergency' | null
  /** ГПВ still applies alongside ("Також продовжують діяти ГПВ") true; suspended false; not said null */
  scheduleApplies: boolean | null
  /** Start: the time named in the text ("з 10:35", "О 9:44"), else the post time. ISO with the Kyiv offset */
  since: string | null
  /**
   * For inactive: when it was cancelled (time in the text, else the post time), or the inferred
   * end. Telegram doesn't show when a post was edited: for an "UPD … скасовано" edit it is the
   * time of the first reading that saw the edit when `previous` was that post still in force,
   * else the post's own time. Null only when nothing was announced.
   */
  endedAt: string | null
  /** ГАВ/СГАВ queues that are off now when the operator names them; null when not said */
  queues: string[] | null
  /** "застосовано 10 черг" without saying which: the count; null when not said */
  queueCount: number | null
  /**
   * When limited to a part of the region ("м. Дніпро", "частині Голосіївського та Соломʼянського
   * районів"); several areas on at once are joined with "; " in the order they started (`queues`
   * and `queueCount` are then null unless all areas name the same). null = whole region / not said
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
  /** Fetched and parsed, but the data is out of date: its freshness state is `stale` */
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
  /** Human-readable reason for anything that isn't `ok`, and for an `ok` that is `degraded` */
  message?: string
  /** `assessFreshness` of the fetched schedule; absent when nothing was fetched (`error`, no schedule source) */
  freshness?: Freshness
  /** The schedule's `sources`, when the region reports them */
  sources?: SourceStatus[]
  /** True when a channel of the region failed but the others still gave a result (any status but `error`) */
  degraded?: boolean
  /** Result of the sample address lookup, when requested */
  address?: { ok: boolean; group?: GroupId; message?: string }
  /**
   * `getHouseOutage` of the sample address, when requested (`houseOutage: true`) and the region
   * supports it: `kind` null = the operator lists no outage there, which is fine
   */
  houseOutage?: { ok: boolean; kind?: HouseOutageKind | null; message?: string }
}
