import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import { sortQueues } from './queues.js'

export type EmergencyKind = 'gav' | 'sgav' | 'emergency'

export interface Announcement {
  /**
   * apply: in force (new, more queues, or "тривають"); cancel: lifted (all, or the queues named);
   * update: the set of switched-off queues changed ("заміна черг"); unclear: the headline names
   * an emergency schedule, but what happened can't be read
   */
  action: 'apply' | 'cancel' | 'update' | 'unclear'
  kind: EmergencyKind
  /** When it took effect: the time in the text, else the post time. ISO, Kyiv offset */
  at: string
  /** `at` came from the text */
  timed: boolean
  /** apply: queues switched off; cancel: queues switched back on; update: queues switched off now */
  queues: string[] | null
  /** update, apply: queues switched back on ("(1-5 ввімкнені)", "замість 1 та 2 черг …") */
  restored: string[] | null
  /** "10 черг" without numbers; with numbers, how many */
  count: number | null
  /** "в повному обсязі": every queue */
  all: boolean
  /** apply: adds to what is in force ("додатково", "ще") instead of replacing it */
  add: boolean
  /**
   * apply: "знову введені ГАВ (для 6-10 черг)": the queues named are in force again, so whatever
   * ran before was lifted in between (Sumy never posts that)
   */
  again: boolean
  /** cancel of some queues only ("скасовано 5 черг ГАВ (з 6 по 10)") */
  partial: boolean
  /** ГПВ applies alongside: true; suspended: false; not said: null */
  scheduleApplies: boolean | null
  area: string | null
  /** A cancellation written into an earlier apply post ("UPD: … скасовано"); its time is unknown */
  edited: boolean
  /** apply: said to last at least until then ("до кінця доби"); ISO, Kyiv offset */
  until?: string | null
}

/** One classified announcement with the post it came from. */
export interface EmergencyEvent {
  announcement: Announcement
  text: string
  url: string | null
  /** Post time, ISO */
  posted: string
}

export interface FoldOptions {
  region: RegionId
  now: Date
  /** An apply without a later cancel or update for this long has ended (inferred) */
  ttlHours: number
  /**
   * Instead: an apply without a later word lasts to the end of its Kyiv day (inferred then). For
   * operators that never post a cancel and whose emergency outages run for hours, announced anew
   * each morning (Sumy)
   */
  holdToEndOfDay?: boolean
  source: EmergencyStatus['source']
  /** The status the caller got last time: dates an "UPD: … скасовано" edit (see `end`) */
  previous?: EmergencyStatus
}

/** What one schedule (ГАВ, СГАВ, unnamed emergency) is doing in one area (null = the whole region). */
interface Track {
  kind: EmergencyKind
  area: string | null
  active: boolean
  since: string
  /** Queues off, when known */
  queues: Set<string> | null
  count: number | null
  scheduleApplies: boolean | null
  /** Time of the newest event about it, ms */
  lastAt: number
  /** The newest event about it */
  event: EmergencyEvent
  endedAt: string | null
  inferred: boolean
  /** Queues a partial cancel has already switched back on */
  lifted: Set<string>
  /** Said to last at least until then ("до кінця доби"), ms; 0 when not said */
  until: number
}

const KINDS: readonly EmergencyKind[] = ['gav', 'sgav', 'emergency']
const MESSAGE_MAX = 2000

/**
 * One area, however it is written: "у Ніжинському і Прилуцькому районах" and "…та Прилуцькому…",
 * "м. Полтава" and "м. Полтаві"
 */
const areaKey = (area: string | null) =>
  area
    ? area
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/ (?:і|й) /g, ' та ')
        .replace(/^(м\. ?\S+?)[аеиіоуюяї]$/u, '$1')
        .trim()
    : ''

/**
 * Announcements, in the order they were posted, → the state now.
 *
 * - ГАВ, СГАВ and unnamed emergency shutdowns are followed separately (Kirovohrad lifts СГАВ
 *   while ГАВ stays); a cancel of "аварійні відключення" ends all of them, one of "ГАВ" ends ГАВ
 *   and the unnamed ones.
 * - Each area is its own episode: "м. Павлоград: скасовано" ends Pavlohrad, not Dnipro. A cancel
 *   for the whole region ends every area.
 * - More queues while one runs add to it (Poltava: "скасовано ГАВ 6-10", then "ввести ГАВ (6-10)"
 *   while 1-5 never came back). A partial cancel ends the episode only when nothing is known to
 *   remain; otherwise it stays on and the TTL ends it. A false "cancelled" is worse than a false
 *   "still on".
 * - Operators that never post a cancel are covered by the TTL.
 * - "(1-5 ввімкнені)", "замість 1 та 2 черг …" switch queues back on; "знову введені ГАВ (для
 *   6-10 черг)" while those are off means the rest was lifted in between (Sumy never says so).
 */
export function foldEvents(events: readonly EmergencyEvent[], opts: FoldOptions): EmergencyStatus {
  const tracks = new Map<string, Track>()
  /** The newest cancel that had nothing running to end (the apply was before the window) */
  let orphanCancel: EmergencyEvent | null = null
  let lastUnclear: EmergencyEvent | null = null
  let lastDecisiveAt = 0

  const timeOf = (e: EmergencyEvent) => Math.max(Date.parse(e.posted), Date.parse(e.announcement.at))
  const keyOf = (kind: EmergencyKind, area: string | null) => `${kind}|${areaKey(area)}`

  const fetchedAt = toKyivIso(opts.now)
  /**
   * An "UPD: … скасовано" edit shows no edit time. When the caller's last status was this very
   * post still in force, the edit came after that reading: it ended by this one. Otherwise the
   * post's own time is the best known.
   */
  const editedEnd = (e: EmergencyEvent): string => {
    const p = opts.previous
    if (e.url && p?.message?.url === e.url) {
      if (p.state === 'active') return fetchedAt
      // …and stays so on the readings after it
      if (!p.inferred && p.endedAt && Date.parse(p.endedAt) > Date.parse(e.posted)) return p.endedAt
    }
    return e.posted
  }

  const end = (t: Track, e: EmergencyEvent) => {
    t.active = false
    t.endedAt = e.announcement.edited && !e.announcement.timed ? editedEnd(e) : e.announcement.at
    t.inferred = false
    t.event = e
    t.lastAt = timeOf(e)
    t.scheduleApplies = e.announcement.scheduleApplies
  }

  const touch = (t: Track, e: EmergencyEvent) => {
    t.lastAt = timeOf(e)
    t.event = e
  }

  const start = (a: Announcement, e: EmergencyEvent, kind: EmergencyKind): Track => {
    const t: Track = {
      kind,
      area: a.area,
      active: true,
      since: a.at,
      queues: a.queues ? new Set(a.queues) : null,
      count: a.count ?? a.queues?.length ?? null,
      scheduleApplies: a.scheduleApplies,
      lastAt: timeOf(e),
      event: e,
      endedAt: null,
      inferred: false,
      lifted: new Set(),
      until: a.until ? Date.parse(a.until) : 0,
    }
    tracks.set(keyOf(kind, a.area), t)
    return t
  }

  const running = (kind: EmergencyKind, area: string | null) => {
    const t = tracks.get(keyOf(kind, area))
    return t?.active ? t : undefined
  }

  /** A partial cancel applied to `t`; true when nothing is known to remain */
  const lift = (t: Track, a: Announcement): boolean => {
    if (t.queues && a.queues) {
      for (const q of a.queues) t.queues.delete(q)
      t.count = t.queues.size
      return t.queues.size === 0
    }
    if (t.count !== null && a.count !== null) {
      // the same queues named again ("Скасовано ГАВ для 1, 2 та 3 черг", posted twice) are not
      // lifted twice
      const fresh = a.queues ? a.queues.filter((q) => !t.lifted.has(q)) : null
      for (const q of fresh ?? []) t.lifted.add(q)
      t.count -= fresh ? fresh.length : a.count
      if (a.queues && t.queues) for (const q of a.queues) t.queues.delete(q)
      else t.queues = null
      return t.count <= 0
    }
    // how much remains is not known: still on, the TTL ends it
    return false
  }

  const ttl = opts.ttlHours * 3600_000
  const now = opts.now.getTime()
  /** Episodes nobody followed up on for the TTL ended then (operators that never cancel) */
  const expire = (at: number) => {
    for (const t of tracks.values()) {
      // "до кінця доби": not before then
      const end = Math.max(opts.holdToEndOfDay ? endOfKyivDay(t.lastAt) : t.lastAt + ttl, t.until)
      if (t.active && at > end) {
        t.active = false
        t.endedAt = toKyivIso(new Date(end))
        t.inferred = true
      }
    }
  }

  for (const e of events) {
    const a = e.announcement
    // "О 19:00 - заміна черг" posted at 18:52: not yet; the state stays as it is until then
    if (Date.parse(a.at) > now) continue
    // a new post after a long silence starts a new episode, it doesn't continue yesterday's
    expire(timeOf(e))
    if (a.action === 'unclear') {
      // "ГАВ: …" that can't be read while one runs: it is still news about it, the state stands
      const on = [...tracks.values()].filter((t) => t.active && (t.kind === a.kind || a.kind === 'emergency'))
      if (on.length) for (const t of on) touch(t, e)
      else lastUnclear = e
      continue
    }
    lastDecisiveAt = Math.max(lastDecisiveAt, timeOf(e))

    if (a.action === 'cancel') {
      const kinds: EmergencyKind[] =
        a.kind === 'emergency' ? [...KINDS] : a.kind === 'gav' ? ['gav', 'emergency'] : ['sgav']
      // whole region: every area; an area: only that one
      const on = [...tracks.values()].filter((t) => t.active && kinds.includes(t.kind))
      let targets = on.filter((t) => !a.area || areaKey(t.area) === areaKey(a.area))
      // "Шановні споживачі м. ДНІПРО: скасування" after an untagged "Шановні споживачі: діють":
      // with no area followed separately, the one whole-region episode is what it ends
      if (a.area && !targets.length && ![...tracks.values()].some((t) => t.active && t.area))
        targets = on.filter((t) => !t.area)
      for (const t of targets) {
        if (!a.partial || lift(t, a)) end(t, e)
        else touch(t, e)
      }
      if (!targets.length && a.edited) {
        // "UPD: … скасовано" written into the apply post: it was in force from the post time
        end(start({ ...a, at: e.posted, queues: null, count: null }, e, a.kind), e)
        continue
      }
      if (!targets.length && ![...tracks.values()].some((t) => t.active)) orphanCancel = e
      continue
    }

    if (a.action === 'update') {
      const t = running(a.kind, a.area)
      if (!t) {
        if (a.queues?.length) start(a, e, a.kind)
        continue
      }
      // "знеструмлюються 6-10, вмикаються 1-5": the new set
      if (t.queues && a.restored) for (const q of a.restored) t.queues.delete(q)
      if (a.queues) t.queues = new Set([...(t.queues ?? []), ...a.queues])
      if (t.queues) t.count = t.queues.size
      touch(t, e)
      if (t.queues && !t.queues.size) end(t, e)
      continue
    }

    // apply
    const t = running(a.kind, a.area)
    if (!t) {
      start(a, e, a.kind)
      continue
    }
    // "для 6-10 черг (1-5 ввімкнені)": those are back on
    if (t.queues && a.restored) for (const q of a.restored) t.queues.delete(q)
    if (a.queues && a.again && t.queues?.size && a.queues.every((q) => t.queues!.has(q))) {
      // "знову введені ГАВ (для 6-10 черг)" while 6-10 are off: all was lifted in between, unannounced
      t.queues = new Set(a.queues)
      t.count = t.queues.size
    } else if (a.queues) {
      // more queues while it runs: they add up
      t.queues = t.queues || !a.add ? new Set([...(t.queues ?? []), ...a.queues]) : null
      t.count = t.queues ? t.queues.size : null
    } else if (a.count !== null) {
      if (a.add) {
        t.queues = null
        t.count = t.count !== null ? t.count + a.count : null
      } else {
        // "в обсязі 5 черг": the volume now; queue ids that don't fit it are no longer known
        if (t.queues && t.queues.size !== a.count) t.queues = null
        t.count = a.count
      }
    }
    t.scheduleApplies = a.scheduleApplies ?? t.scheduleApplies
    if (a.until) t.until = Math.max(t.until, Date.parse(a.until))
    touch(t, e)
  }

  expire(now)

  const message = (e: EmergencyEvent | null) =>
    e ? { text: e.text.slice(0, MESSAGE_MAX), url: e.url, at: e.posted } : null
  const status = (s: Omit<EmergencyStatus, 'region' | 'source' | 'fetchedAt'>): EmergencyStatus => ({
    region: opts.region,
    ...s,
    source: opts.source,
    fetchedAt,
  })

  // the newest word can't be read: say so rather than guess (it expires with the TTL)
  if (lastUnclear && timeOf(lastUnclear) > lastDecisiveAt && now - timeOf(lastUnclear) <= ttl)
    return status({
      state: 'unknown',
      kind: lastUnclear.announcement.kind,
      scheduleApplies: lastUnclear.announcement.scheduleApplies,
      since: null,
      endedAt: null,
      queues: null,
      queueCount: null,
      area: lastUnclear.announcement.area,
      inferred: false,
      message: message(lastUnclear),
    })

  const byNewest = [...tracks.values()].sort((a, b) => b.lastAt - a.lastAt)
  const active = byNewest.filter((t) => t.active)
  if (active.length) {
    const primary = active[0]!
    const queuesOf = (t: Track) => (t.queues?.size ? sortQueues(t.queues) : null)
    // the whole region, or every area that is on, in the order they started (a post about one
    // doesn't reorder them)
    const byStart = [...active].sort(
      (a, b) => Date.parse(a.since) - Date.parse(b.since) || areaKey(a.area).localeCompare(areaKey(b.area)),
    )
    const areas = active.some((t) => !t.area) ? null : [...new Set(byStart.map((t) => t.area!))]
    // several announcements in force: the newest one's queues are the whole picture only when
    // every one says the same. A region-wide ГАВ next to a district's, or a ГАВ next to a newer
    // СГАВ, each has queues of its own, and one list would read as all that is off
    const same = (t: Track) =>
      t.kind === primary.kind &&
      t.count === primary.count &&
      queuesOf(t)?.join() === queuesOf(primary)?.join()
    const shared = active.every(same)
    return status({
      state: 'active',
      kind: primary.kind,
      scheduleApplies: primary.scheduleApplies,
      since: byStart[0]!.since,
      endedAt: null,
      queues: shared ? queuesOf(primary) : null,
      queueCount: shared ? primary.count : null,
      area: areas ? areas.join('; ') : null,
      inferred: false,
      message: message(primary.event),
    })
  }

  // the episode that ended last: an inferred end of ГАВ at 20:24 is after a real СГАВ cancel at 12:58
  const endOf = (t: Track) => Math.max(Date.parse(t.endedAt ?? '') || 0, t.lastAt)
  const last = [...byNewest].sort((a, b) => endOf(b) - endOf(a))[0]
  if (last && (!orphanCancel || timeOf(orphanCancel) <= endOf(last)))
    return status({
      state: 'inactive',
      kind: last.kind,
      scheduleApplies: last.inferred ? null : last.scheduleApplies,
      since: last.since,
      endedAt: last.endedAt,
      queues: null,
      queueCount: null,
      area: null,
      inferred: last.inferred,
      message: message(last.event),
    })

  if (orphanCancel) {
    const a = orphanCancel.announcement
    // "скасовано ГАВ для 6-10 черг", "м. Павлоград: скасовано" with nothing known before: the
    // rest may still be on, so not a region-wide "cancelled"…
    const recent = now - timeOf(orphanCancel) <= ttl
    if ((a.partial || a.area) && recent)
      return status({
        state: 'unknown',
        kind: a.kind,
        scheduleApplies: a.scheduleApplies,
        since: null,
        endedAt: null,
        queues: null,
        queueCount: null,
        area: a.area,
        inferred: false,
        message: message(orphanCancel),
      })
    // …until the TTL has passed since: whatever was left has ended by then (history, not unknown)
    if (a.partial)
      return status({
        state: 'inactive',
        kind: a.kind,
        scheduleApplies: null,
        since: null,
        endedAt: toKyivIso(new Date(timeOf(orphanCancel) + ttl)),
        queues: null,
        queueCount: null,
        area: null,
        inferred: true,
        message: message(orphanCancel),
      })
    return status({
      state: 'inactive',
      kind: a.kind,
      scheduleApplies: a.scheduleApplies,
      since: null,
      endedAt: a.edited && !a.timed ? editedEnd(orphanCancel) : a.at,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: message(orphanCancel),
    })
  }

  // nothing announced in the window: no message, which is how it differs from a cancellation
  return status({
    state: 'inactive',
    kind: null,
    scheduleApplies: null,
    since: null,
    endedAt: null,
    queues: null,
    queueCount: null,
    area: null,
    inferred: false,
    message: null,
  })
}

/** The next Kyiv midnight after `ms` */
function endOfKyivDay(ms: number): number {
  const day = kyivDate(new Date(ms))
  return kyivInstant(addDays(day, 1), 0).getTime()
}
