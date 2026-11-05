import { OutageError } from '../errors.js'
import { cellsToIntervals } from '../schedule.js'
import { addDays, kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, IntervalKind, RegionInfo, RegionSchedule } from '../types.js'
import { STANDARD_GROUPS, parseCherg, parsePowerOnTime, powerOnAddressSearch } from './poweron.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Ternopiloblenergo (poweron.toe.com.ua), a PowerOn platform backend.
 *
 * The operator's schedule API is keyed by ADDRESS, not by group: `GET /a_gpv_g` returns the
 * schedule of the building named in the `X-debug-key` header (base64 of
 * "cityId/streetId/house") and ignores the `group[]` parameter. To offer schedules per group,
 * this provider asks for one real, verified building per group (see `REPRESENTATIVES`).
 *
 * Responses tell three cases apart, which keeps the health check honest:
 * - `hydra:member: null` — the address is known, nothing is scheduled in the window;
 * - `hydra:member: []` — the operator doesn't know the address (a representative is gone);
 * - items whose `dataJson` key is another group — a representative moved to another group.
 * The last two are reported as `parse` errors so the table gets updated instead of silently
 * reporting "no outages".
 */
const API = 'https://api-poweron.toe.com.ua/api'

const INFO: RegionInfo = {
  id: 'ternopil',
  name: 'Тернопільська область',
  operator: 'Тернопільобленерго',
  website: 'https://poweron.toe.com.ua/',
  capabilities: { schedule: true, addressSearch: true },
}

interface Representative {
  cityId: number
  streetId: number
  /** Building number exactly as the operator writes it */
  house: string
  /** Human-readable, for error messages and maintainers */
  address: string
}

/**
 * One building per group, found through the operator's own address directory and checked
 * against `building-groups` and `a_gpv_g` (2026-11-05). Ternopil city has only 7 of the 12
 * groups, so the rest are in district towns. Single-supply buildings only.
 */
export const REPRESENTATIVES: Readonly<Record<GroupId, Representative>> = {
  '1.1': { cityId: 192, streetId: 1708, house: '1', address: 'Борщів, вул. Максима Кривоноса, 1' },
  '1.2': { cityId: 1032, streetId: 10035, house: '2', address: 'Тернопіль, вул. Руська, 2' },
  '2.1': { cityId: 604, streetId: 5523, house: '3', address: 'Кременець, вул. Піддівича, 3' },
  '2.2': { cityId: 1032, streetId: 44479, house: '2-В', address: 'Тернопіль, вул. 15 Квітня, 2-В' },
  '3.1': { cityId: 21525, streetId: 36539, house: '2', address: 'Козова, вул. Дорошенка, 2' },
  '3.2': { cityId: 1032, streetId: 10035, house: '1', address: 'Тернопіль, вул. Руська, 1' },
  '4.1': { cityId: 1032, streetId: 10035, house: '25', address: 'Тернопіль, вул. Руська, 25' },
  '4.2': { cityId: 1032, streetId: 9996, house: '44', address: 'Тернопіль, вул. Бродівська, 44' },
  '5.1': { cityId: 1032, streetId: 9993, house: '54', address: 'Тернопіль, вул. Петра Батьківського, 54' },
  '5.2': { cityId: 1032, streetId: 44479, house: '1', address: 'Тернопіль, вул. 15 Квітня, 1' },
  '6.1': { cityId: 919, streetId: 8835, house: '3', address: 'Чортків, вул. Гончара, 3' },
  '6.2': { cityId: 329, streetId: 3141, house: '1', address: 'Заліщики, вул. Данила Галицького, 1' },
}

// half-hour slot values: "0" power on, "1" off, "10" possible outage (grey on the site)
const SLOT: Record<string, IntervalKind | null> = { '0': null, '1': 'off', '10': 'maybe' }

interface GraphItem {
  dateGraph?: string
  dateCreate?: string
  dataJson?: Record<string, { times?: Record<string, string> }> | null
}

/** What one representative's response says about its group. */
export type GroupGraph =
  | { kind: 'days'; days: DaySchedule[]; updatedAt: string | null }
  /** The address is known but nothing is scheduled in the window */
  | { kind: 'none' }
  /** The operator doesn't recognize the address */
  | { kind: 'unknown-address' }

export function ternopilProvider(): Provider {
  const region = INFO.id

  const fetchGroup = async (ctx: ProviderContext, group: GroupId): Promise<GroupGraph> => {
    const rep = REPRESENTATIVES[group]!
    const key = `${rep.cityId}/${rep.streetId}/${rep.house}`
    // the same window the official site asks for: yesterday noon … tomorrow midnight
    const today = kyivDate(ctx.now())
    const q = new URLSearchParams({
      after: `${addDays(today, -1)}T12:00:00+00:00`,
      before: `${addDays(today, 1)}T00:00:00+00:00`,
      'group[]': group,
      time: key.replace(/\//g, ''),
    })
    const data = await ctx.http.json(`${API}/a_gpv_g?${q}`, { region, headers: { 'X-debug-key': base64Utf8(key) } })
    return parseGroupGraph(data, group)
  }

  // the server sometimes answers empty and has data a moment later: ask once more
  const fetchWithRetry = async (ctx: ProviderContext, group: GroupId, retryOn: GroupGraph['kind'][]) => {
    const first = await fetchGroup(ctx, group)
    return retryOn.includes(first.kind) ? fetchGroup(ctx, group) : first
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Тернопіль', street: 'вул. Руська', house: '1' },

    async getSchedules(ctx) {
      const groups = Object.keys(REPRESENTATIVES)
      // a few at a time: twelve requests per refresh is already more than the site makes
      const results = await mapLimit(groups, 3, (g) => fetchWithRetry(ctx, g, ['unknown-address']))
      const anyDays = results.some((r) => r.kind === 'days')
      if (anyDays)
        for (const [i, r] of results.entries())
          if (r.kind === 'none') results[i] = await fetchGroup(ctx, groups[i]!)
      const byGroup = Object.fromEntries(groups.map((g, i) => [g, results[i]!]))
      return buildSchedule(byGroup, ctx.now())
    },

    ...powerOnAddressSearch({
      info: INFO,
      label: 'Ternopil',
      api: API,
      async streetBuildings(ctx, street) {
        const q = new URLSearchParams({ cityId: street.cityId ?? '', streetId: street.id })
        const data = await ctx.http.json<{ buildingNames?: unknown }>(`${API}/pw-accounts/building-names?${q}`, { region })
        if (!Array.isArray(data?.buildingNames))
          throw new OutageError('parse', 'Ternopil building-names: expected a list', { region })
        return (data.buildingNames as { buildingName?: string; chergGpv?: string }[])
          .filter((b) => b.buildingName?.trim())
          .map((b) => {
            const g = parseCherg(b.chergGpv)
            return { number: b.buildingName!.trim(), groups: g ? [g] : [] }
          })
      },
      // a building with two supplies is in two groups; only this endpoint lists both
      async buildingGroups(ctx, street, house) {
        const q = new URLSearchParams({ cityId: street.cityId ?? '', streetId: street.id, buildingNames: house.number })
        const data = await ctx.http.json<{ buildingGroups?: { chergGpv?: string }[] }>(
          `${API}/pw-accounts/building-groups?${q}`,
          { region },
        )
        const list = Array.isArray(data?.buildingGroups) ? data.buildingGroups : []
        return [...new Set(list.map((b) => parseCherg(b.chergGpv)).filter((g): g is GroupId => !!g))]
      },
    }),
  }
}

/** One `a_gpv_g` response for the representative of `group`. Exported for tests. */
export function parseGroupGraph(data: unknown, group: GroupId): GroupGraph {
  const region = INFO.id
  if (!data || typeof data !== 'object' || !('hydra:member' in data))
    throw new OutageError('parse', 'Ternopil a_gpv_g: not a collection', { region })
  const member = (data as { 'hydra:member': unknown })['hydra:member']
  if (member === null) return { kind: 'none' }
  if (!Array.isArray(member)) throw new OutageError('parse', 'Ternopil a_gpv_g: expected a list', { region })
  if (!member.length) return { kind: 'unknown-address' }

  const byDate = new Map<string, { day: DaySchedule; created: string | null }>()
  for (const item of member as GraphItem[]) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(item.dateGraph ?? '')?.[0]
    if (!date) throw new OutageError('parse', `Ternopil a_gpv_g: bad dateGraph "${item.dateGraph}"`, { region })
    const entries = Object.entries(item.dataJson ?? {})
    const mine = entries.find(([k]) => parseCherg(k) === group)
    if (!mine)
      throw new OutageError(
        'parse',
        `Ternopil: the representative address of group ${group} (${REPRESENTATIVES[group]?.address}) now returns ${entries.map(([k]) => k).join(', ') || 'no groups'}`,
        { region },
      )
    const day = { date, status: 'scheduled' as const, intervals: cellsToIntervals(date, timesToCells(mine[1]?.times, group)) }
    const created = parsePowerOnTime(item.dateCreate)
    const prev = byDate.get(date)
    if (!prev || Date.parse(created ?? '') >= Date.parse(prev.created ?? '')) byDate.set(date, { day, created })
  }
  const dates = [...byDate.keys()].sort()
  const updated = [...byDate.values()].map((v) => v.created).filter((c): c is string => !!c)
  return {
    kind: 'days',
    days: dates.map((d) => byDate.get(d)!.day),
    updatedAt: updated.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null,
  }
}

/** Per-group results → the region schedule. Exported for tests. */
export function buildSchedule(byGroup: Record<GroupId, GroupGraph>, now: Date): RegionSchedule {
  const region = INFO.id
  for (const [g, r] of Object.entries(byGroup))
    if (r.kind === 'unknown-address')
      throw new OutageError(
        'parse',
        `Ternopil: the operator no longer knows the representative address of group ${g} (${REPRESENTATIVES[g]?.address})`,
        { region },
      )
  const withDays = Object.values(byGroup).filter((r): r is Extract<GroupGraph, { kind: 'days' }> => r.kind === 'days')
  const fetchedAt = toKyivIso(now)
  if (!withDays.length) return { region, groups: [], schedules: {}, updatedAt: null, fetchedAt }

  const dates = [...new Set(withDays.flatMap((r) => r.days.map((d) => d.date)))].sort()
  const groups = STANDARD_GROUPS.filter((g) => g in byGroup)
  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of groups) {
    const r = byGroup[g]!
    const days = r.kind === 'days' ? r.days : []
    // a group that answered nothing while the others have a schedule is unknown, not "no outages"
    schedules[g] = dates.map((d) => days.find((x) => x.date === d) ?? { date: d, status: 'unknown', intervals: [] })
  }
  const updatedAt =
    withDays
      .map((r) => r.updatedAt)
      .filter((u): u is string => !!u)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1) ?? null
  return { region, groups, schedules, updatedAt, fetchedAt }
}

/** `{"00:00": "0", "00:30": "1", …}` → 48 cells. A missing slot is "power on", like on the site. */
function timesToCells(times: Record<string, string> | undefined, group: GroupId): (IntervalKind | null)[] {
  const region = INFO.id
  if (!times || typeof times !== 'object' || !Object.keys(times).length)
    throw new OutageError('parse', `Ternopil a_gpv_g: group ${group} has no half-hour slots`, { region })
  const cells: (IntervalKind | null)[] = new Array(48).fill(null)
  for (const [clock, value] of Object.entries(times)) {
    const m = /^(\d{2}):(00|30)$/.exec(clock)
    const kind = SLOT[String(value)]
    if (!m || Number(m[1]) > 23 || kind === undefined)
      throw new OutageError('parse', `Ternopil a_gpv_g: unexpected slot ${clock}=${value} in group ${group}`, { region })
    cells[Number(m[1]) * 2 + (m[2] === '30' ? 1 : 0)] = kind
  }
  return cells
}

/** btoa() of UTF-8, as the official site builds the header ("2-В" has a Cyrillic letter). */
function base64Utf8(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
