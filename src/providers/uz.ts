import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { makeDay, unpublished, type MinuteSlot } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type { AddressQuery, DaySchedule, GroupId, RegionId, ProviderInfo, RegionSchedule } from '../types.js'
import { SharedTask } from '../util.js'
import type { Provider, ProviderContext } from './provider.js'
import { findTimeRanges, findUaDate } from './ua-text.js'
import { parseUzAddresses, uzAddressSearch, uzDirectory, type UzDirectory } from './uz-addresses.js'

/**
 * АТ «Укрзалізниця» is itself a distribution system operator: homes near stations and along
 * the lines are wired to the railway's grid, not the oblenergo's, and get the railway's own
 * schedule, which differs from the oblenergo's. It publishes one page per oblast (and Kyiv)
 * with the schedule and the addresses of each group (see `uz-addresses.ts`).
 *
 * The table comes in two layouts:
 * - time spans as columns ("Години відключення | 00-00 01-30 | …") and, under each span, the
 *   groups that are off then ("1(1,2) 2(1)" = 1.1, 1.2, 2.1);
 * - groups as columns ("1:1: черга | 1:2: черга | …") and, in the next row, each group's off
 *   times ("03.30-07.00 10.30-17.30").
 * Some oblasts are served by two railway branches with separate tables, headed
 * «в межах обслуговування РФ "Одеська залізниця"»; `branch` picks one. A page with no table
 * means no schedule applies.
 *
 * Freshness. The page has no update stamp and the server sends no `Last-Modified` or `ETag`,
 * so `updatedAt` is null. The only date is the one written above each table ("17 листопада"),
 * and every table is filed under its own: usually one, sometimes today's and tomorrow's. A
 * table without any date is a `parse` error, never "today". When no table is for today, today
 * is listed as `unknown`: a page left on yesterday's table says nothing about today. The one
 * exception is a page that has moved on to a later day: the table this provider last read for
 * today is kept for the rest of the day, since nothing took it back.
 */
const BASE =
  'https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen'

export interface UzOptions {
  id: RegionId
  /** Oblast name, e.g. "Київська область" */
  oblast: string
  /** Page id on uz.gov.ua */
  page: number
  /** For pages with several branch tables: the branch's name in its heading, e.g. "Одеська" */
  branch?: string
}

/** Pages whose address section is missing (Kherson) or lists only dashes (Donetsk) */
const NO_ADDRESSES: ReadonlySet<RegionId> = new Set<RegionId>(['uz-kherson', 'uz-donetsk'])

/** Addresses for the health check, on pages whose lists have been the same for months */
const SAMPLES: Partial<Record<RegionId, AddressQuery>> = {
  'uz-kyiv': { city: 'Київ', street: 'Уманська', house: '5' },
  'uz-lviv': { city: 'Львів', street: 'Двірцева', house: '1' },
  'uz-vinnytsia-odesa': { city: 'Вапнярка', street: 'Українська', house: '21' },
}

/** The address lists change rarely; a schedule read refreshes the copy anyway */
const DIRECTORY_TTL_MS = 6 * 3600_000

export function uzProvider(opts: UzOptions): Provider {
  const url = `${BASE}/${opts.page}/`
  const operator = opts.branch ? `Укрзалізниця, ${opts.branch} залізниця` : 'Укрзалізниця'
  const info: ProviderInfo = {
    id: opts.id,
    name: `${opts.oblast} (Укрзалізниця${opts.branch ? `, ${opts.branch} залізниця` : ''})`,
    operator,
    website: url,
    capabilities: { schedule: true, addressSearch: !NO_ADDRESSES.has(opts.id) },
  }

  // one download serves both the schedule and the address list under it
  let page: { html: string; at: number } | null = null
  let loading: SharedTask<string> | null = null
  const download = (ctx: ProviderContext): Promise<string> => {
    if (!loading || loading.aborted) {
      const t = new SharedTask(async (signal) => {
        const html = await ctx.http.withSignal(signal).text(url, { region: opts.id })
        page = { html, at: Date.now() }
        return html
      })
      loading = t
      const done = () => {
        if (loading === t) loading = null
      }
      t.promise.then(done, done)
    }
    return loading.join(ctx.signal)
  }

  let directory: { html: string; dir: UzDirectory | null } | null = null
  const loadDirectory = async (ctx: ProviderContext) => {
    const html = page && Date.now() - page.at < DIRECTORY_TTL_MS ? page.html : await download(ctx)
    if (directory?.html !== html) {
      const section = parseUzAddresses(html)
      directory = { html, dir: section && uzDirectory(section.rows, opts.branch) }
    }
    return directory.dir
  }

  /** date → the day as last read, for a page that drops today's table when tomorrow's comes */
  const seen = new Map<string, Record<GroupId, DaySchedule>>()

  return {
    info,
    sampleAddress: SAMPLES[opts.id],
    async getSchedules(ctx) {
      const html = await download(ctx)
      return rememberToday(parseUzPage(html, ctx.now(), opts.id, opts.branch, url), seen, ctx.now())
    },
    ...(info.capabilities.addressSearch ? uzAddressSearch(opts.id, operator, loadDirectory) : {}),
  }
}

/**
 * Keeps each published day from today on, and puts back today's when the page now shows only
 * a later day. A page with no table at all gets nothing back: that is the operator taking the
 * schedule down. Exported for tests.
 */
export function rememberToday(
  s: RegionSchedule,
  seen: Map<string, Record<GroupId, DaySchedule>>,
  now: Date,
): RegionSchedule {
  const today = kyivDate(now)
  for (const date of seen.keys()) if (date < today) seen.delete(date)
  const dates = [...new Set(Object.values(s.schedules).flatMap((days) => days.map((d) => d.date)))]
  const published = dates.filter((date) =>
    Object.values(s.schedules).some((days) => days.some((d) => d.date === date && d.status !== 'unknown')),
  )
  for (const date of published) {
    if (date < today) continue
    const day: Record<GroupId, DaySchedule> = {}
    for (const g of s.groups) {
      const d = s.schedules[g]!.find((x) => x.date === date)
      if (d) day[g] = d
    }
    seen.set(date, day)
  }
  const kept = seen.get(today)
  if (published.includes(today) || !kept || !published.some((d) => d > today)) return s
  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of s.groups)
    schedules[g] = s.schedules[g]!.map((d) => (d.date === today && kept[g] ? kept[g] : d))
  return { ...s, schedules }
}

interface Table {
  /** Branch heading before the table, if any */
  branch: string | null
  date: string | null
  rows: string[][]
}

/** A uz.gov.ua schedule page → schedule. Exported for tests. */
export function parseUzPage(
  html: string,
  now: Date,
  region: RegionId,
  branch?: string,
  url?: string,
): RegionSchedule {
  const fail = (msg: string) => new OutageError('parse', `Укрзалізниця: ${msg}`, { region, url })
  // parts of some pages are commented out
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  const start = clean.indexOf('приєднані')
  if (start === -1) {
    // the page of an occupied oblast has only the heading
    if (/<h1[^>]*>/i.test(clean) || clean.includes('Графіки обмеження')) return empty(region, now)
    throw fail('the schedule section is missing')
  }
  const endAt = clean.indexOf('Перелік адрес', start)
  const body = clean.slice(start, endAt === -1 ? undefined : endAt)

  const tables = readTables(body, now)
  if (!tables.length) return empty(region, now)
  // a date heads the tables under it until the next one: both branches' tables of one day
  let carried: string | null = null
  for (const t of tables) {
    if (t.date) carried = t.date
    else t.date = carried
  }
  const any = tables.find((t) => t.date)?.date ?? null
  const unbranched = tables.filter((t) => !t.branch)
  const mine = branch
    ? tables.filter((t) => t.branch?.includes(branch))
    : unbranched.length
      ? unbranched
      : tables.slice(0, 1)
  if (!mine.length) throw fail(`no table for the ${branch} branch`)

  const today = kyivDate(now)
  const days = new Map<string, Record<string, MinuteSlot[]>>()
  for (const table of mine) {
    const date = table.date ?? any
    // never "today" by default: an undated table may be any day's
    if (!date) throw fail('no date above the table')
    if (days.has(date)) throw fail(`two tables for ${date}`)
    const slots = parseTable(table.rows)
    if (!slots) throw fail('unknown table layout')
    days.set(date, slots)
  }
  // a page still on an earlier day says nothing about today
  const dates = [...new Set([...days.keys(), today])].sort()
  const schedules: Record<string, DaySchedule[]> = {}
  for (const g of STANDARD_GROUPS)
    schedules[g] = dates.map((date) => {
      const slots = days.get(date)
      return slots ? makeDay(date, slots[g] ?? []) : { date, status: 'unknown', intervals: [] }
    })
  return {
    region,
    groups: [...STANDARD_GROUPS],
    schedules,
    updatedAt: null,
    fetchedAt: toKyivIso(now),
  }
}

/** A page without a table publishes nothing; that is not "no outages" */
function empty(region: RegionId, now: Date): RegionSchedule {
  return unpublished(region, STANDARD_GROUPS, now)
}

const text = (s: string) =>
  s
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[ \t ]+/g, ' ')
    .trim()

function readTables(body: string, now: Date): Table[] {
  const out: Table[] = []
  let last = 0
  for (const m of body.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const before = text(body.slice(last, m.index))
    last = m.index + m[0].length
    const branch = /обслуговування\s+РФ\s*["«“]?([^"»”]+)/i.exec(before)?.[1]?.trim() ?? null
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => text(c[1]!)),
    )
    out.push({ branch, date: findUaDate(before, now), rows })
  }
  return out
}

/** "00-00 01-30", "00.00\n03.00" → [start, end] in minutes */
function span(cell: string): [number, number] | null {
  const t = [...cell.matchAll(/(\d{1,2})\s*[-.:]\s*(\d{2})/g)].map((m) => Number(m[1]) * 60 + Number(m[2]))
  if (t.length !== 2) return null
  let [a, b] = t as [number, number]
  if (b === 0 || b <= a) b = 1440
  return a < 1440 && b <= 1440 ? [a, b] : null
}

/**
 * The span columns run back to back, so a cell with a typo ("11500 14.30" for "11.00 14.30")
 * is read from its neighbours: it starts where the previous span ends, and its one legible time
 * must be where the next span starts (or the end of the day, for the last column).
 */
function mendSpans(cells: string[]): ([number, number] | null)[] {
  const spans = cells.map(span)
  spans.forEach((s, i) => {
    if (s || i === 0) return
    const prev = spans[i - 1]
    const times = [...cells[i]!.matchAll(/(\d{1,2})\s*[-.:]\s*(\d{2})/g)].map(
      (m) => Number(m[1]) * 60 + Number(m[2]),
    )
    if (!prev || times.length !== 1) return
    const end = times[0] === 0 ? 1440 : times[0]!
    const next = spans[i + 1] ?? (i === cells.length - 1 ? ([1440, 1440] as [number, number]) : null)
    if (next && end > prev[1] && end === next[0]) spans[i] = [prev[1], end]
  })
  return spans
}

/** "1(1,2) 2(1) 3" → ["1.1", "1.2", "2.1", "3.1", "3.2"] */
function groupsIn(cell: string): string[] {
  const out: string[] = []
  for (const m of cell.matchAll(/(?<![\d(,])([1-6])\s*(?:\(([\d,\s]+)\))?/g)) {
    const subs = m[2]
      ? m[2]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s === '1' || s === '2')
      : ['1', '2']
    for (const s of subs) out.push(`${m[1]}.${s}`)
  }
  return out
}

function parseTable(rows: string[][]): Record<string, MinuteSlot[]> | null {
  const out: Record<string, MinuteSlot[]> = {}
  const add = (g: string, [start, end]: [number, number]) => (out[g] ??= []).push({ start, end, kind: 'off' })

  // time spans as columns
  const spansAt = rows.findIndex((r) => /годин/i.test(r[0] ?? ''))
  if (spansAt !== -1) {
    const spans = mendSpans(rows[spansAt]!.slice(1))
    const groupsRow = rows.slice(spansAt + 1).find((r) => /черг/i.test(r[0] ?? ''))
    if (!groupsRow || spans.some((s) => !s)) return null
    groupsRow.slice(1).forEach((cell, i) => {
      const s = spans[i]
      if (s) for (const g of groupsIn(cell)) add(g, s)
    })
    return out
  }

  // groups as columns, their times in the next row
  let found = false
  rows.forEach((row, i) => {
    const groups = row.map((c) => /([1-6])\s*:\s*([12])\s*:?\s*черга/i.exec(c))
    if (!groups.some(Boolean)) return
    found = true
    const times = rows[i + 1] ?? []
    groups.forEach((m, j) => {
      if (!m) return
      const g = `${m[1]}.${m[2]}`
      out[g] ??= []
      for (const r of findTimeRanges(times[j] ?? '')) add(g, r)
    })
  })
  return found ? out : null
}

/** Every uz.gov.ua page: [region id, oblast, page id, branch] */
export const UZ_PAGES: readonly [RegionId, string, number, string?][] = [
  ['uz-kyiv', 'Київ', 649725],
  ['uz-vinnytsia', 'Вінницька область', 622232, 'Південно-Західна'],
  ['uz-vinnytsia-odesa', 'Вінницька область', 622232, 'Одеська'],
  ['uz-volyn', 'Волинська область', 622240],
  ['uz-dnipro', 'Дніпропетровська область', 622248],
  ['uz-donetsk', 'Донецька область', 622256],
  ['uz-zhytomyr', 'Житомирська область', 622264],
  ['uz-zakarpattia', 'Закарпатська область', 622272],
  ['uz-zaporizhzhia', 'Запорізька область', 622280],
  ['uz-ivano-frankivsk', 'Івано-Франківська область', 622288],
  ['uz-kyiv-region', 'Київська область', 622296],
  ['uz-kirovohrad', 'Кіровоградська область', 622304],
  ['uz-lviv', 'Львівська область', 622320],
  ['uz-mykolaiv', 'Миколаївська область', 622328],
  ['uz-odesa', 'Одеська область', 622336],
  ['uz-poltava', 'Полтавська область', 622344],
  ['uz-rivne', 'Рівненська область', 622352],
  ['uz-sumy', 'Сумська область', 622360, 'Південно-Західна'],
  ['uz-sumy-south', 'Сумська область', 622360, 'Південна'],
  ['uz-ternopil', 'Тернопільська область', 622368],
  ['uz-kharkiv', 'Харківська область', 622376],
  ['uz-kherson', 'Херсонська область', 622384],
  ['uz-khmelnytskyi', 'Хмельницька область', 622392],
  ['uz-cherkasy', 'Черкаська область', 622400],
  ['uz-chernivtsi', 'Чернівецька область', 622408],
  ['uz-chernihiv', 'Чернігівська область', 622416],
]
