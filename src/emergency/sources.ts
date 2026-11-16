import { OutageError } from '../errors.js'
import { toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import type { ProviderContext } from '../providers/provider.js'
import { queueNames, sortQueues } from './queues.js'

// --- YASNO ---

const YASNO = 'https://app.yasno.ua/api/blackout-service/public/shutdowns'

export interface YasnoEmergency {
  /** Any group's today is `EmergencyShutdowns` */
  active: boolean
  /** When the data last changed (the newest `updatedOn`; moves with every schedule too), ISO */
  changedAt: string | null
  /** Today's status of the groups, e.g. "EmergencyShutdowns", "ScheduleApplies" */
  status: string
}

/**
 * YASNO marks emergency shutdowns per group: `today.status = "EmergencyShutdowns"` (and no
 * slots) while DTEK runs them, for every group of the operator at once in the known example.
 * `updatedOn` is when the status flipped. Exported for tests.
 */
export function parseYasnoEmergency(data: unknown, region: RegionId): YasnoEmergency {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new OutageError('parse', 'YASNO planned-outages: expected an object', { region })
  let active = false
  let changed = 0
  let groups = 0
  let status = ''
  for (const [key, g] of Object.entries(data as Record<string, unknown>)) {
    if (!/^\d+(\.\d+)?$/.test(key) || !g || typeof g !== 'object') continue
    groups++
    const group = g as { today?: { status?: string }; updatedOn?: string }
    if (group.today?.status === 'EmergencyShutdowns') active = true
    else status ||= group.today?.status ?? ''
    const u = group.updatedOn ? Date.parse(group.updatedOn) : NaN
    if (Number.isFinite(u) && u > changed) changed = u
  }
  if (!groups) throw new OutageError('parse', 'YASNO planned-outages: no groups', { region })
  return {
    active,
    changedAt: changed ? toKyivIso(new Date(changed)) : null,
    status: active ? 'EmergencyShutdowns' : status || 'unknown',
  }
}

export async function yasnoEmergency(
  ctx: ProviderContext,
  region: RegionId,
  regionId: number,
  dsoId: number,
): Promise<YasnoEmergency> {
  const data = await ctx.http.json(`${YASNO}/regions/${regionId}/dsos/${dsoId}/planned-outages`, { region })
  return parseYasnoEmergency(data, region)
}

// --- Mykolaivoblenergo outage feed ---

const MK_FEED = 'https://www.energy.mk.ua/outage/api/v1/outage'

export interface MkOutageRow {
  id?: number
  type?: string
  start_at?: string | null
  finish_at?: string | null
  /** "Графік аварійних відключень | ГАВ черга 1"; text after "|" is typed by dispatchers */
  reason?: string | null
}

/** A ГАВ/СГАВ row of the feed (not a mislabelled ГПВ one, not a neighbour's ГАВ). */
function isEmergencyRow(r: MkOutageRow): boolean {
  // AVARIYA is an accident record even when its reason names the schedule
  if (r.type === 'AVARIYA') return false
  const reason = r.reason ?? ''
  if (!/^\s*(?:спеціальн\S*\s+)?графік\S*\s+аварійних/iu.test(reason)) return false
  const tail = reason.split('|').slice(1).join('|')
  // "ГПВ ч 5,2" under the ГАВ reason; "ГАВ Кіровоград Обленерго" is another operator's
  return !/ГПВ|обленерго/iu.test(tail)
}

/** "ГАВ черга 3", "ГАВ 3 черга.", "ГАВ  3 черга " → "3". */
function rowQueues(reason: string): string[] {
  const tail = reason.split('|').slice(1).join('|')
  const out: string[] = []
  for (const m of tail.matchAll(/черга\s*(\d{1,2}\s*(?:\([РрPp]\))?)|(\d{1,2}\s*(?:\([РрPp]\))?)\s*черга/giu))
    out.push(...queueNames(m[1] ?? m[2]))
  return out
}

/**
 * The feed's rows → the state now. Rows are per switched-off feeder set, with the ГАВ queue in
 * the reason text; `finish_at` is filled in when power returns. Null when the window has no
 * ГАВ rows at all (nothing to say). Exported for tests.
 */
export function mykolaivFeedStatus(
  rows: readonly MkOutageRow[],
  region: RegionId,
  now: Date,
): Omit<EmergencyStatus, 'fetchedAt'> | null {
  const gav = rows.filter(isEmergencyRow)
  if (!gav.length) return null
  const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN)
  const nowMs = now.getTime()
  const running = gav.filter((r) => {
    const s = t(r.start_at)
    const f = t(r.finish_at)
    return Number.isFinite(s) && s <= nowMs && !(Number.isFinite(f) && f <= nowMs)
  })
  const kindOf = (list: MkOutageRow[]) =>
    list.every((r) => /спеціальн|СГАВ/iu.test(r.reason ?? '')) ? ('sgav' as const) : ('gav' as const)
  const iso = (ms: number) => toKyivIso(new Date(ms))
  const newest = [...gav].sort((a, b) => t(b.start_at) - t(a.start_at))[0]!
  const message = (r: MkOutageRow) => ({
    text: (r.reason ?? '').trim(),
    url: null,
    at: iso(t(r.start_at)),
  })
  if (running.length) {
    const queues = sortQueues(running.flatMap((r) => rowQueues(r.reason ?? '')))
    return {
      region,
      state: 'active',
      kind: kindOf(running),
      scheduleApplies: null,
      since: iso(Math.min(...running.map((r) => t(r.start_at)))),
      endedAt: null,
      queues: queues.length ? queues : null,
      queueCount: queues.length || null,
      area: null,
      inferred: false,
      message: message([...running].sort((a, b) => t(b.start_at) - t(a.start_at))[0]!),
      source: 'api',
    }
  }
  const finished = gav.map((r) => t(r.finish_at)).filter(Number.isFinite)
  return {
    region,
    state: 'inactive',
    kind: kindOf(gav),
    scheduleApplies: null,
    since: iso(Math.min(...gav.map((r) => t(r.start_at)).filter(Number.isFinite))),
    endedAt: finished.length ? iso(Math.max(...finished)) : null,
    queues: null,
    queueCount: null,
    area: null,
    inferred: false,
    message: message(newest),
    source: 'api',
  }
}

/**
 * Outage rows of the whole region from `from` to `to`. The feed pages by 100, oldest start
 * first, so the running rows are on the last pages: past `maxPages` the newest pages are read.
 */
export async function mykolaivFeed(
  ctx: ProviderContext,
  region: RegionId,
  from: Date,
  to: Date,
  maxPages = 8,
): Promise<MkOutageRow[]> {
  const page = async (n: number) => {
    ctx.signal?.throwIfAborted()
    const data = await ctx.http.json<{ data?: unknown; last_page?: number }>(MK_FEED, {
      region,
      method: 'POST',
      body: {
        page: n,
        perPage: 100,
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(to.getTime() / 1000),
      },
    })
    if (!Array.isArray(data?.data))
      throw new OutageError('parse', 'Mykolaiv outage feed: no "data" list', { region, url: MK_FEED })
    return { rows: data.data as MkOutageRow[], last: Math.max(1, Number(data.last_page) || 1) }
  }
  const first = await page(1)
  const rows = [...first.rows]
  const start = Math.max(2, first.last - maxPages + 2)
  for (let n = start; n <= first.last; n++) rows.push(...(await page(n)).rows)
  return rows
}
