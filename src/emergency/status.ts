import { toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import type { Announcement, EmergencyKind } from './classify.js'
import { sortQueues } from './queues.js'

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
  source: EmergencyStatus['source']
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
}

const KINDS: readonly EmergencyKind[] = ['gav', 'sgav', 'emergency']
const MESSAGE_MAX = 2000

const areaKey = (area: string | null) => (area ? area.toLowerCase().replace(/\s+/g, ' ').trim() : '')

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
 */
export function foldEvents(events: readonly EmergencyEvent[], opts: FoldOptions): EmergencyStatus {
  const tracks = new Map<string, Track>()
  /** The newest cancel that had nothing running to end (the apply was before the window) */
  let orphanCancel: EmergencyEvent | null = null
  let lastUnclear: EmergencyEvent | null = null
  let lastDecisiveAt = 0

  const timeOf = (e: EmergencyEvent) => Math.max(Date.parse(e.posted), Date.parse(e.announcement.at))
  const keyOf = (kind: EmergencyKind, area: string | null) => `${kind}|${areaKey(area)}`

  const end = (t: Track, e: EmergencyEvent) => {
    t.active = false
    // an "UPD: … скасовано" edit shows no edit time: the post's own time is the best known
    t.endedAt = e.announcement.edited && !e.announcement.timed ? e.posted : e.announcement.at
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
      t.count -= a.count
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
    for (const t of tracks.values())
      if (t.active && at - t.lastAt > ttl) {
        t.active = false
        t.endedAt = toKyivIso(new Date(t.lastAt + ttl))
        t.inferred = true
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
      const targets = [...tracks.values()].filter(
        (t) => t.active && kinds.includes(t.kind) && (!a.area || areaKey(t.area) === areaKey(a.area)),
      )
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
    if (a.queues) {
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
    touch(t, e)
  }

  expire(now)

  const fetchedAt = toKyivIso(opts.now)
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
    // the whole region, or every area that is on
    const areas = active.some((t) => !t.area) ? null : [...new Set(active.map((t) => t.area!))].join('; ')
    return status({
      state: 'active',
      kind: primary.kind,
      scheduleApplies: primary.scheduleApplies,
      since: active.map((t) => t.since).sort()[0]!,
      endedAt: null,
      queues: primary.queues?.size ? sortQueues(primary.queues) : null,
      queueCount: primary.count,
      area: areas,
      inferred: false,
      message: message(primary.event),
    })
  }

  const last = byNewest[0]
  if (last && (!orphanCancel || timeOf(orphanCancel) <= last.lastAt))
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
    // rest may still be on, so not a region-wide "cancelled"
    if (a.partial || a.area)
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
    return status({
      state: 'inactive',
      kind: a.kind,
      scheduleApplies: a.scheduleApplies,
      since: null,
      endedAt: a.edited && !a.timed ? orphanCancel.posted : a.at,
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
