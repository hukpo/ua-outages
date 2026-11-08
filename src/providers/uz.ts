import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, RegionId, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider } from './provider.js'
import { findTimeRanges, findUaDate } from './ua-text.js'

/**
 * АТ «Укрзалізниця» is itself a distribution system operator: homes near stations and along
 * the lines are wired to the railway's grid, not the oblenergo's, and get the railway's own
 * schedule, which differs from the oblenergo's. It publishes one page per oblast (and Kyiv)
 * with today's schedule and the addresses of each group.
 *
 * The table comes in two layouts:
 * - time spans as columns ("Години відключення | 00-00 01-30 | …") and, under each span, the
 *   groups that are off then ("1(1,2) 2(1)" = 1.1, 1.2, 2.1);
 * - groups as columns ("1:1: черга | 1:2: черга | …") and, in the next row, each group's off
 *   times ("03.30-07.00 10.30-17.30").
 * Some oblasts are served by two railway branches with separate tables, headed
 * «в межах обслуговування РФ "Одеська залізниця"»; `branch` picks one. A page with no table
 * means no schedule applies.
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

export function uzProvider(opts: UzOptions): Provider {
  const url = `${BASE}/${opts.page}/`
  const info: RegionInfo = {
    id: opts.id,
    name: `${opts.oblast} (Укрзалізниця${opts.branch ? `, ${opts.branch} залізниця` : ''})`,
    operator: opts.branch ? `Укрзалізниця, ${opts.branch} залізниця` : 'Укрзалізниця',
    website: url,
    capabilities: { schedule: true, addressSearch: false },
  }
  return {
    info,
    async getSchedules(ctx) {
      const html = await ctx.http.text(url, { region: opts.id })
      return parseUzPage(html, ctx.now(), opts.id, opts.branch, url)
    },
  }
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
  const table = branch
    ? tables.find((t) => t.branch?.includes(branch))
    : (tables.find((t) => !t.branch) ?? tables[0])
  if (!table) throw fail(`no table for the ${branch} branch`)
  const date = table.date ?? tables.find((t) => t.date)?.date
  if (!date) throw fail('no date above the table')

  const slots = parseTable(table.rows)
  if (!slots) throw fail('unknown table layout')
  const schedules: Record<string, DaySchedule[]> = {}
  for (const g of STANDARD_GROUPS) schedules[g] = [makeDay(date, slots[g] ?? [])]
  return {
    region,
    groups: [...STANDARD_GROUPS],
    schedules,
    updatedAt: null,
    fetchedAt: toKyivIso(now),
  }
}

function empty(region: RegionId, now: Date): RegionSchedule {
  return { region, groups: [], schedules: {}, updatedAt: null, fetchedAt: toKyivIso(now) }
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
    const spans = rows[spansAt]!.slice(1).map(span)
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
