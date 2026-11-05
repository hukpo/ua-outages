import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider } from './provider.js'
import { parseUaDateTime } from './gpv.js'
import { findTimeRanges } from './ua-text.js'

/**
 * Rivneoblenergo (roe.vsei.ua). The schedule is a server-rendered table inside
 * `#fetched-data-container`: one row per date, one cell per group with "HH:MM - HH:MM"
 * intervals, or "Очікується" while the day isn't published yet.
 *
 * The address lookup exists only as PDFs (free-form Excel exports), so there is no address search.
 */
const SITE = 'https://www.roe.vsei.ua'

const INFO: RegionInfo = {
  id: 'rivne',
  name: 'Рівненська область',
  operator: 'Рівнеобленерго',
  website: `${SITE}/disconnections`,
  capabilities: { schedule: true, addressSearch: false },
}

export function rivneProvider(): Provider {
  return {
    info: INFO,
    async getSchedules(ctx) {
      const html = await ctx.http.text(`${SITE}/disconnections`, { region: INFO.id })
      return parseDisconnections(html, ctx.now())
    },
  }
}

/** Exported for tests. */
export function parseDisconnections(html: string, now: Date): RegionSchedule {
  const region = INFO.id
  const start = html.indexOf('id="fetched-data-container"')
  if (start === -1)
    throw new OutageError('parse', 'Rivne: no #fetched-data-container on the page', { region })
  const end = html.indexOf('</table>', start)
  if (end === -1) throw new OutageError('parse', 'Rivne: schedule table is not closed', { region })
  const table = html.slice(start, end)

  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!),
  )

  // the "Підчерга | 1.1 | 1.2 | …" row gives the column order
  const header = rows.find((cells) => cells[0] && text(cells[0]) === 'Підчерга')
  const groups = header?.slice(1).map((c) => normalizeGroup(text(c).replace(',', '.')))
  if (!groups?.length || groups.some((g) => !g))
    throw new OutageError('parse', 'Rivne: no "Підчерга" header row with group names', { region })

  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const cells of rows) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text(cells[0] ?? ''))
    if (!m) continue
    const date = `${m[3]}-${m[2]}-${m[1]}`
    if (cells.length - 1 !== groups.length)
      throw new OutageError(
        'parse',
        `Rivne: ${date} has ${cells.length - 1} cells for ${groups.length} groups`,
        { region },
      )
    groups.forEach((g, i) => (schedules[g!] ??= []).push(parseCell(date, cells[i + 1]!)))
  }

  const updated = /Оновлено:\s*(\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2})/.exec(html.slice(end))?.[1]
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: parseUaDateTime(updated),
    fetchedAt: toKyivIso(now),
  }
}

function parseCell(date: string, html: string): DaySchedule {
  // one <p> per interval (older versions used <br>): keep them apart before stripping tags
  const content = text(html.replace(/<\/p>|<br\s*\/?>/gi, '\n'))
  if (/очікується/i.test(content)) return { date, status: 'unknown', intervals: [] }
  const ranges = findTimeRanges(content)
  if (ranges.length)
    return makeDay(
      date,
      ranges.map(([start, end]) => ({ start, end, kind: 'off' as const })),
    )
  // an empty cell on a published day: the group has no outages
  if (!content || /не\s*(?:має|заплановано)|відсутн|немає/i.test(content))
    return { date, status: 'no-outages', intervals: [] }
  return { date, status: 'unknown', intervals: [] }
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
