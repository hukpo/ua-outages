/**
 * Builds the static site into `_site/`: copies `site/public/`, then fetches every region with the
 * SDK and writes
 *   data/now.json       today's and tomorrow's schedule of every group, plus each source's state
 *   data/history.json   one entry per day and group, kept for HISTORY_DAYS
 *   cal/<region>/<group>.ics   a calendar feed per group
 *
 *   npx tsx site/scripts/build-data.ts
 *
 * The archive lives only on the published site: set PREVIOUS_SITE (e.g. the Pages URL) and the
 * script starts from the history.json published there, otherwise from a local `_site/` if any.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OutageClient, kyivDate } from '../../src/index.js'
import type { DaySchedule, RegionInfo } from '../../src/index.js'
import { mapLimit } from '../../src/util.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, '_site')
const HISTORY_DAYS = 120
const SITE_TITLE = 'Світло'

/** One group's day: status code and [startMin, endMin, kind] with kind 0 = off, 1 = maybe */
interface CompactDay {
  s: 's' | 'n' | 'e' | 'u'
  i: [number, number, 0 | 1][]
}
type History = { days: Record<string, Record<string, Record<string, CompactDay>>> }

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

async function previousHistory(): Promise<History> {
  const base = process.env.PREVIOUS_SITE
  try {
    if (base) {
      const r = await fetch(new URL('data/history.json', base.endsWith('/') ? base : base + '/'))
      if (r.ok) return (await r.json()) as History
      console.warn(`no published history (${r.status}), starting a new one`)
    } else if (existsSync(join(OUT, 'data/history.json')))
      return JSON.parse(readFileSync(join(OUT, 'data/history.json'), 'utf8')) as History
  } catch (e) {
    console.warn(`can't read the previous history: ${(e as Error).message}`)
  }
  return { days: {} }
}

// --- calendar ---

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

function calendar(info: RegionInfo, group: string, days: DaySchedule[], stamp: Date): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ua-outages//site//UK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`Без світла · ${info.name} · черга ${group}`)}`,
    'X-WR-TIMEZONE:Europe/Kyiv',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ]
  for (const day of days)
    for (const x of day.intervals) {
      const from = new Date(x.from)
      const summary =
        x.kind === 'off' ? `Немає світла (черга ${group})` : `Можливе відключення (черга ${group})`
      lines.push(
        'BEGIN:VEVENT',
        `UID:${info.id}-${group}-${icsDate(from)}-${x.kind}@ua-outages`,
        `DTSTAMP:${icsDate(stamp)}`,
        `DTSTART:${icsDate(from)}`,
        `DTEND:${icsDate(new Date(x.to))}`,
        `SUMMARY:${icsText(summary)}`,
        `DESCRIPTION:${icsText(`Графік ${info.operator}. Може змінитися, перевіряйте: ${info.website}`)}`,
        `URL:${info.website}`,
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

const client = new OutageClient({ cacheTtlMs: 0, timeoutMs: 25_000, retries: 2 })
const now = new Date()
const today = kyivDate(now)
cpSync(join(ROOT, 'site/public'), OUT, { recursive: true })
mkdirSync(join(OUT, 'data'), { recursive: true })
const history = await previousHistory()

const regions = await mapLimit(client.regions(), 6, async (info) => {
  const started = performance.now()
  try {
    const s = await client.getSchedules(info.id, { fresh: true })
    const latencyMs = Math.round(performance.now() - started)
    const days: Record<string, Record<string, CompactDay>> = {}
    for (const g of s.groups) {
      const groupDays = s.schedules[g] ?? []
      for (const d of groupDays) {
        if (d.date < today) continue
        ;(days[d.date] ??= {})[g] = compact(d)
        ;((history.days[d.date] ??= {})[info.id] ??= {})[g] = compact(d)
      }
      const dir = join(OUT, 'cal', info.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${g}.ics`), calendar(info, g, groupDays, now))
    }
    console.log(`ok    ${info.id.padEnd(16)} ${s.groups.length} groups  ${latencyMs} ms`)
    return { ...pick(info), ok: true, latencyMs, updatedAt: s.updatedAt, groups: s.groups, days }
  } catch (e) {
    const message = (e as Error).message
    console.log(`error ${info.id.padEnd(16)} ${message}`)
    return {
      ...pick(info),
      ok: false,
      message,
      latencyMs: Math.round(performance.now() - started),
      groups: [],
    }
  }
})

function pick(info: RegionInfo) {
  return { id: info.id, name: info.name, operator: info.operator, website: info.website }
}

// keep the archive bounded
const oldest = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10)
for (const day of Object.keys(history.days)) if (day < oldest) delete history.days[day]

writeFileSync(
  join(OUT, 'data/now.json'),
  JSON.stringify({ title: SITE_TITLE, generatedAt: now.toISOString(), today, regions }),
)
writeFileSync(join(OUT, 'data/history.json'), JSON.stringify(history))
const ok = regions.filter((r) => r.ok).length
console.log(
  `\n${ok}/${regions.length} regions, ${Object.keys(history.days).length} days in the archive → _site/`,
)
