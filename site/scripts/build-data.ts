/**
 * Builds the static site into `_site/`: copies `site/public/`, then fetches every region with the
 * SDK and writes
 *   data/now.json       today's and tomorrow's schedule of every group, plus each source's state
 *   data/history.json   one entry per day and group, kept for HISTORY_DAYS
 *   cal/<region>/<group>.ics   a calendar feed per group
 *
 *   npx tsx site/scripts/build-data.ts
 *
 * State lives only on the published site: set PREVIOUS_SITE (e.g. the Pages URL) and the script
 * starts from the history.json and now.json published there, otherwise from a local `_site/`.
 * A source that fails keeps its last schedule (marked stale) while that still covers today.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OutageClient, kyivDate } from '../../src/index.js'
import type { DaySchedule, RegionId, RegionInfo } from '../../src/index.js'
import { addDays, kyivInstant } from '../../src/time.js'
import { mapLimit } from '../../src/util.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, '_site')
const HISTORY_DAYS = 120
/** Past days kept in the calendar feeds, so last week's outages don't vanish from calendars */
const CALENDAR_PAST_DAYS = 14

/** One group's day: status code and [startMin, endMin, kind] with kind 0 = off, 1 = maybe */
interface CompactDay {
  s: 's' | 'n' | 'e' | 'u'
  i: [number, number, 0 | 1][]
}
type Days = Record<string, Record<string, CompactDay>>
type History = { days: Record<string, Record<string, Record<string, CompactDay>>> }

interface RegionEntry {
  id: RegionId
  name: string
  operator: string
  website: string
  ok: boolean
  /** The source failed this time; `days` come from the last run that reached it (`fetchedAt`) */
  stale?: boolean
  message?: string
  latencyMs: number
  updatedAt?: string | null
  fetchedAt?: string
  groups: string[]
  days?: Days
}
type Now = { generatedAt: string; today: string; regions: RegionEntry[] }

const STATUS = { scheduled: 's', 'no-outages': 'n', emergency: 'e', unknown: 'u' } as const

/** Wall-clock minutes of an ISO time inside `day`; the next midnight is 1440 */
function minutesIn(day: string, iso: string): number {
  if (iso.slice(0, 10) > day) return 1440
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

const compact = (d: DaySchedule): CompactDay => ({
  s: STATUS[d.status],
  i: d.intervals.map((x) => [minutesIn(d.date, x.from), minutesIn(d.date, x.to), x.kind === 'off' ? 0 : 1]),
})

/** A data file of the previously published site, or of a local `_site/` */
async function previous<T>(file: string): Promise<T | null> {
  const base = process.env.PREVIOUS_SITE
  try {
    if (base) {
      const r = await fetch(new URL(`data/${file}`, base.endsWith('/') ? base : base + '/'))
      if (r.ok) return (await r.json()) as T
      console.warn(`no published ${file} (${r.status})`)
    } else if (existsSync(join(OUT, 'data', file)))
      return JSON.parse(readFileSync(join(OUT, 'data', file), 'utf8')) as T
  } catch (e) {
    console.warn(`can't read the previous ${file}: ${(e as Error).message}`)
  }
  return null
}

// --- calendar ---

interface CalEvent {
  from: Date
  to: Date
  kind: 0 | 1
}

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n')
/** Lines longer than 75 octets are folded, as RFC 5545 asks */
function fold(line: string): string {
  const bytes = Buffer.from(line)
  if (bytes.length <= 75) return line
  const parts: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + (start ? 74 : 75), bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end-- // don't split a UTF-8 char
    parts.push(bytes.subarray(start, end).toString())
    start = end
  }
  return parts.join('\r\n ')
}

/** A group's events: the archive's last CALENDAR_PAST_DAYS days, then the current days */
function events(region: RegionId, group: string, days: Days, history: History, today: string): CalEvent[] {
  const all = new Map<string, CompactDay>()
  const since = addDays(today, -CALENDAR_PAST_DAYS)
  for (const [day, regions] of Object.entries(history.days)) {
    const d = regions[region]?.[group]
    if (d && day >= since) all.set(day, d)
  }
  for (const [day, groups] of Object.entries(days)) if (groups[group]) all.set(day, groups[group])
  return [...all.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([day, d]) =>
      d.i.map(([a, b, kind]) => ({ from: kyivInstant(day, a), to: kyivInstant(day, b), kind })),
    )
}

function calendar(r: RegionEntry, group: string, list: CalEvent[], stamp: Date): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ua-outages//site//UK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`Без світла · ${r.name} · черга ${group}`)}`,
    'X-WR-TIMEZONE:Europe/Kyiv',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ]
  for (const x of list) {
    const summary = x.kind === 0 ? `Немає світла (черга ${group})` : `Можливе відключення (черга ${group})`
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.id}-${group}-${icsDate(x.from)}-${x.kind}@ua-outages`,
      `DTSTAMP:${icsDate(stamp)}`,
      `DTSTART:${icsDate(x.from)}`,
      `DTEND:${icsDate(x.to)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(`Графік ${r.operator}. Може змінитися, перевіряйте: ${r.website}`)}`,
      `URL:${r.website}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(summary)}`,
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

// --- build ---

const pick = (info: RegionInfo) => ({
  id: info.id,
  name: info.name,
  operator: info.operator,
  website: info.website,
})

const client = new OutageClient({ cacheTtlMs: 0, timeoutMs: 25_000, retries: 2 })
const now = new Date()
const today = kyivDate(now)
cpSync(join(ROOT, 'site/public'), OUT, { recursive: true })
mkdirSync(join(OUT, 'data'), { recursive: true })
const history = (await previous<History>('history.json')) ?? { days: {} }
const before = await previous<Now>('now.json')

const regions = await mapLimit(client.regions(), 6, async (info): Promise<RegionEntry> => {
  const started = performance.now()
  try {
    const s = await client.getSchedules(info.id, { fresh: true })
    const latencyMs = Math.round(performance.now() - started)
    const days: Days = {}
    for (const g of s.groups)
      for (const d of s.schedules[g] ?? []) {
        if (d.date < today) continue
        ;(days[d.date] ??= {})[g] = compact(d)
        ;((history.days[d.date] ??= {})[info.id] ??= {})[g] = compact(d)
      }
    console.log(`ok    ${info.id.padEnd(16)} ${s.groups.length} groups  ${latencyMs} ms`)
    return {
      ...pick(info),
      ok: true,
      latencyMs,
      updatedAt: s.updatedAt,
      fetchedAt: s.fetchedAt,
      groups: s.groups,
      days,
    }
  } catch (e) {
    const message = (e as Error).message
    const latencyMs = Math.round(performance.now() - started)
    // keep showing the last schedule that reached us, while it still covers today
    const last = before?.regions.find((r) => r.id === info.id && r.ok && r.groups.length)
    const days = Object.fromEntries(Object.entries(last?.days ?? {}).filter(([day]) => day >= today))
    if (last && Object.keys(days).length) {
      console.log(`stale ${info.id.padEnd(16)} ${message}; keeping data from ${last.fetchedAt}`)
      return { ...last, ...pick(info), stale: true, message, latencyMs, days }
    }
    console.log(`error ${info.id.padEnd(16)} ${message}`)
    return { ...pick(info), ok: false, message, latencyMs, groups: [] }
  }
})

for (const r of regions) {
  if (!r.ok) continue
  const dir = join(OUT, 'cal', r.id)
  mkdirSync(dir, { recursive: true })
  for (const g of r.groups)
    writeFileSync(join(dir, `${g}.ics`), calendar(r, g, events(r.id, g, r.days ?? {}, history, today), now))
}

// keep the archive bounded
const oldest = addDays(today, -HISTORY_DAYS)
for (const day of Object.keys(history.days)) if (day < oldest) delete history.days[day]

const out: Now = { generatedAt: now.toISOString(), today, regions }
writeFileSync(join(OUT, 'data/now.json'), JSON.stringify(out))
writeFileSync(join(OUT, 'data/history.json'), JSON.stringify(history))
const ok = regions.filter((r) => r.ok && !r.stale).length
const stale = regions.filter((r) => r.stale).length
console.log(
  `\n${ok}/${regions.length} regions fresh, ${stale} stale, ${Object.keys(history.days).length} days in the archive → _site/`,
)
