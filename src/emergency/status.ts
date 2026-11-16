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

/** What one schedule (ГАВ, СГАВ, unnamed emergency) is doing. */
interface Track {
  kind: EmergencyKind
  active: boolean
  since: string
  queues: Set<string> | null
  count: number | null
  area: string | null
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

/**
 * Announcements, in the order they were posted, → the state now. ГАВ, СГАВ and unnamed
 * emergency shutdowns are followed separately (Kirovohrad lifts СГАВ while ГАВ stays); a cancel
 * of "аварійні відключення" ends all of them, one of "ГАВ" ends ГАВ and the unnamed ones.
 * Operators that never post a cancel are covered by the TTL.
 */
export function foldEvents(events: readonly EmergencyEvent[], opts: FoldOptions): EmergencyStatus {
  const tracks = new Map<EmergencyKind, Track>()
  /** The newest cancel that had no running schedule to end (the apply was before the window) */
  let orphanCancel: EmergencyEvent | null = null
  let lastUnclear: EmergencyEvent | null = null
  let lastDecisiveAt = 0

  const timeOf = (e: EmergencyEvent) => Math.max(Date.parse(e.posted), Date.parse(e.announcement.at))

  const end = (t: Track, e: EmergencyEvent) => {
    t.active = false
    // an "UPD: … скасовано" edit has no time of its own
    t.endedAt = e.announcement.edited && !e.announcement.timed ? null : e.announcement.at
    t.inferred = false
    t.event = e
    t.lastAt = timeOf(e)
    t.scheduleApplies = e.announcement.scheduleApplies
  }

  const start = (a: Announcement, e: EmergencyEvent, kind: EmergencyKind): Track => {
    const t: Track = {
      kind,
      active: true,
      since: a.at,
      queues: a.queues ? new Set(a.queues) : null,
      count: a.count ?? a.queues?.length ?? null,
      area: a.area,
      scheduleApplies: a.scheduleApplies,
      lastAt: timeOf(e),
      event: e,
      endedAt: null,
      inferred: false,
    }
    tracks.set(kind, t)
    return t
  }

  for (const e of events) {
    const a = e.announcement
    if (a.action === 'unclear') {
      lastUnclear = e
      continue
    }
    lastDecisiveAt = Math.max(lastDecisiveAt, timeOf(e))

    if (a.action === 'cancel') {
      const targets: EmergencyKind[] =
        a.kind === 'emergency' ? [...KINDS] : a.kind === 'gav' ? ['gav', 'emergency'] : ['sgav']
      let ended = false
      for (const kind of targets) {
        const t = tracks.get(kind)
        if (!t?.active) continue
        // "м. Павлоград: скасовано" doesn't end what runs in Дніпро
        if (t.area && a.area && t.area !== a.area) continue
        ended = true
        if (!a.partial) {
          end(t, e)
          continue
        }
        if (t.queues && a.queues) {
          for (const q of a.queues) t.queues.delete(q)
          t.count = t.queues.size
        } else if (t.count !== null && a.count !== null) {
          t.count -= a.count
          t.queues = null
        } else t.count = 0
        if (!t.count) end(t, e)
        else {
          t.lastAt = timeOf(e)
          t.event = e
        }
      }
      if (!ended && a.edited) {
        // "UPD: … скасовано" written into the apply post: it was in force from the post time
        const t = start({ ...a, at: e.posted, queues: null, count: null }, e, a.kind)
        end(t, e)
        orphanCancel = null
        continue
      }
      if (!ended && ![...tracks.values()].some((t) => t.active)) orphanCancel = e
      continue
    }

    if (a.action === 'update') {
      const t = tracks.get(a.kind)
      if (!t?.active) {
        if (a.queues?.length) start(a, e, a.kind)
        continue
      }
      if (t.queues && a.restored) for (const q of a.restored) t.queues.delete(q)
      if (a.queues) t.queues = new Set([...(t.queues ?? []), ...a.queues])
      else if (!t.queues) t.queues = null
      t.count = t.queues ? t.queues.size : t.count
      t.lastAt = timeOf(e)
      t.event = e
      if (t.queues && !t.queues.size) end(t, e)
      continue
    }

    // apply
    const t = tracks.get(a.kind)
    if (!t?.active) {
      start(a, e, a.kind)
      continue
    }
    if (a.add) {
      if (t.queues && a.queues) t.queues = new Set([...t.queues, ...a.queues])
      else if (a.queues || a.count !== null) t.queues = null
      t.count = t.queues ? t.queues.size : t.count !== null && a.count !== null ? t.count + a.count : null
    } else if (a.queues || a.count !== null) {
      t.queues = a.queues ? new Set(a.queues) : null
      t.count = a.count ?? a.queues?.length ?? null
    }
    // the newest statement says where; "тривають" for the whole region widens it again
    t.area = a.area
    t.scheduleApplies = a.scheduleApplies ?? t.scheduleApplies
    t.lastAt = timeOf(e)
    t.event = e
  }

  // operators that never cancel: an apply nobody followed up on for the TTL has ended
  const ttl = opts.ttlHours * 3600_000
  const now = opts.now.getTime()
  for (const t of tracks.values())
    if (t.active && now - t.lastAt > ttl) {
      t.active = false
      t.endedAt = toKyivIso(new Date(t.lastAt + ttl))
      t.inferred = true
    }

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
  const active = byNewest.find((t) => t.active)
  if (active)
    return status({
      state: 'active',
      kind: active.kind,
      scheduleApplies: active.scheduleApplies,
      since: active.since,
      endedAt: null,
      queues: active.queues?.size ? sortQueues(active.queues) : null,
      queueCount: active.count,
      area: active.area,
      inferred: false,
      message: message(active.event),
    })

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
    return status({
      state: 'inactive',
      kind: a.kind,
      scheduleApplies: a.scheduleApplies,
      since: null,
      endedAt: a.edited && !a.timed ? null : a.at,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: message(orphanCancel),
    })
  }

  // nothing announced in the window
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
