import { emergencyQueues } from '../emergency/queues.js'
import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { cellsToIntervals, compareGroups, normalizeGroup, unpublished } from '../schedule.js'
import { kyivInstant, toKyivIso } from '../time.js'
import type {
  City,
  DaySchedule,
  EmergencyQueues,
  GroupMatch,
  House,
  HouseOutage,
  IntervalKind,
  ProviderInfo,
  RegionSchedule,
  Street,
} from '../types.js'
import { parseUaDateTime } from './gpv.js'
import { sharedList, type Provider, type ProviderContext } from './provider.js'
import { findUaDate } from './ua-text.js'

/**
 * Poltavaoblenergo (poe.pl.ua). The schedule is an HTML fragment with a 48-cell table per
 * group and day; address search is a chain of form POSTs with a JSON payload.
 */
const SITE = 'https://www.poe.pl.ua'
const CUSTOMS = `${SITE}/customs`

const INFO: ProviderInfo = {
  id: 'poltava',
  name: 'Полтавська область',
  operator: 'Полтаваобленерго',
  website: `${SITE}/disconnection/power-outages/`,
  capabilities: { schedule: true, addressSearch: true },
}

// gpv-s1 on, gpv-s2 off, gpv-s3 switching time ("електроенергії може не бути")
const CELL: Record<string, IntervalKind | null | undefined> = { s1: null, s2: 'off', s3: 'maybe' }

const DIRECTORY_TTL_MS = 24 * 3_600_000
/** A house's status is read once per this */
const RESULT_TTL_MS = 5 * 60_000
/** `fresh` still takes what the same call has just read */
const FRESH_TTL_MS = 15_000

/** The answer of `disconnectinforesult-cabinet.php` for one house */
export interface PoltavaResult {
  gp_qnum_1?: string | null
  gp_qnum_2?: string | null
  /** The house's status now, as the site prints it */
  fn_accident_message?: string | null
  /** 0 with "не зареєстровано перерв", 4 with a ГПВ outage; others not seen */
  message_type?: number | null
  /** When the outage started, "05.11.2026 23:00" */
  accident_str?: string | null
  gav_message?: string | null
}

interface Instance {
  instance_id: number
  instance_name: string
}

export function poltavaProvider(): Provider {
  const region = INFO.id
  const results = new Map<string, { at: number; row: Promise<PoltavaResult | undefined> }>()

  const result = async (ctx: ProviderContext, street: Street, house: House) => {
    const body = await ctx.http.text(`${CUSTOMS}/disconnectinforesult-cabinet.php`, {
      region,
      method: 'POST',
      // "streerid" is the operator's spelling
      body: new URLSearchParams({
        disconn: JSON.stringify({ cityid: street.cityId, streerid: street.id, house: house.number }),
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    return parseJsonList<PoltavaResult>(body, region)[0]
  }

  const search = async (ctx: ProviderContext, payload: Record<string, string | number>) => {
    // JSON arrives labelled text/html, so parse it ourselves
    const body = await ctx.http.text(`${CUSTOMS}/search-disconnection-cabinet.php`, {
      region,
      method: 'POST',
      body: new URLSearchParams({ disconn: JSON.stringify(payload) }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    return parseJsonList<Instance>(body, region)
  }

  // static lists: kept for a day, and loaded on a signal of their own
  const cities = sharedList(DIRECTORY_TTL_MS, async (ctx): Promise<City[]> => {
    const home = await ctx.http.text(`${SITE}/`, { region })
    const filials = parseFilials(home)
    if (!filials.length) throw new OutageError('parse', 'Poltava: no districts on the home page', { region })
    const lists = await Promise.all(
      filials.map(async (f) =>
        (await search(ctx, { operation_type: 'city', filial_id: f.id, city_id: '', street_id: '' })).map(
          (c) => ({
            id: String(c.instance_id),
            name: c.instance_name.trim(),
            district: f.name,
          }),
        ),
      ),
    )
    // a settlement can be listed under several districts
    const seen = new Map<string, City>()
    for (const c of lists.flat()) if (!seen.has(c.id)) seen.set(c.id, c)
    return [...seen.values()]
  })

  return {
    info: INFO,
    sampleAddress: { city: 'Полтава', street: 'вул. Європейська', house: '10' },

    async getSchedules(ctx) {
      const html = await ctx.http.text(`${CUSTOMS}/dynamicgpv-info.php`, { region })
      return parseGpvFragment(html, ctx.now())
    },

    async searchCities(ctx) {
      return cities(ctx)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      const list = await search(ctx, {
        operation_type: 'street',
        filial_id: '',
        city_id: Number(city.id),
        street_id: '',
      })
      return list.map((s) => ({ id: String(s.instance_id), name: s.instance_name.trim(), cityId: city.id }))
    },

    async searchHouses(ctx, street) {
      const list = await search(ctx, {
        operation_type: 'building',
        filial_id: '',
        city_id: Number(street.cityId),
        street_id: Number(street.id),
      })
      // instance_id is just a row number here; the name is the key
      return list.map((h) => ({
        id: h.instance_name.trim(),
        number: h.instance_name.trim(),
        streetId: street.id,
      }))
    },

    async outageOf(ctx, house, street, city): Promise<HouseOutage | null> {
      const key = `${street.cityId}\u0000${street.id}\u0000${house.number}`
      const hit = results.get(key)
      let row: Promise<PoltavaResult | undefined>
      if (hit && Date.now() - hit.at < (ctx.fresh ? FRESH_TTL_MS : RESULT_TTL_MS)) row = hit.row
      else {
        row = result(ctx, street, house)
        if (results.size > 500) results.clear()
        const entry = { at: Date.now(), row }
        results.set(key, entry)
        row.catch(() => {
          if (results.get(key) === entry) results.delete(key)
        })
      }
      const r = await row
      // "Увага! За вказаною адресою зареєстровано декілька підключень…": no status for the address
      if (!r || /декілька підключень/iu.test(r.fn_accident_message ?? ''))
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator answers nothing for this house (a building with several connections needs a lookup by personal account)`,
          { region },
        )
      const outage = poltavaOutage(r)
      if (!outage) return null
      return {
        region,
        address: { city: city?.name, street: street.name, house: house.number },
        ...outage,
        groups: r.gp_qnum_1 ? [r.gp_qnum_2 ? `${r.gp_qnum_1}.${r.gp_qnum_2}` : r.gp_qnum_1] : [],
        updatedAt: null,
        url: INFO.website,
        fetchedAt: toKyivIso(ctx.now()),
      }
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const row = await result(ctx, street, house)
      const emergency = parseGavMessage(row?.gav_message)
      if (!row?.gp_qnum_1)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator gives no single group (a building with several connections needs a lookup by personal account)`,
          { region },
        )
      return {
        region,
        group: row.gp_qnum_2 ? `${row.gp_qnum_1}.${row.gp_qnum_2}` : row.gp_qnum_1,
        address: { city: city?.name, street: street.name, house: house.number },
        ...(emergency ? { emergency } : {}),
      }
    },
  }
}

/**
 * A house's status line (`fn_accident_message`) as an outage; null when it says there is none.
 * The site prints it as it comes, and only two forms have been seen (16–17.11.2026):
 * "не зареєстровано перерв в електропостачанні" (`message_type` 0) and "зареєстрована перерва в
 * електропостачанні внаслідок застосування графіку погодинних відключень (ГПВ) 05.11.2026 р. з
 * 23 годин(и) 00 хвилин(и). Очікуваний час закінчення …: 06.11.2026 р. о 02 годин(и) 00
 * хвилин(и)." (`message_type` 4), the schedule's own outage. Everything else is `other` with the
 * operator's words: a ГАВ outage is expected to read "…графіку аварійних відключень (ГАВ)…",
 * but that has not been seen, so it is not taken for `emergency` (UNVERIFIED). Exported for tests.
 */
export function poltavaOutage(
  r: PoltavaResult,
): Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> | null {
  const text = (r.fn_accident_message ?? '').replace(/\s+/g, ' ').trim()
  if (/^не зареєстровано перерв/iu.test(text) || (!text && !r.message_type)) return null
  const scheduled = /внаслідок застосування графіку погодинних відключень \(ГПВ\)/iu.test(text)
  const end =
    /закінчення[^:]*:\s*(\d{2}\.\d{2}\.\d{4})\s*р\.?\s*о\s*(\d{1,2})\s*годин\S*\s*(\d{1,2})\s*хвилин/iu.exec(
      text,
    )
  const start = /(\d{2}\.\d{2}\.\d{4})\s*р\.?\s*з\s*(\d{1,2})\s*годин\S*\s*(\d{1,2})\s*хвилин/iu.exec(text)
  const at = (m: RegExpExecArray | null) =>
    m ? parseUaDateTime(`${m[1]} ${m[2]}:${m[3]!.padStart(2, '0')}`) : null
  return {
    kind: scheduled ? 'scheduled' : 'other',
    reason: text || `message_type ${r.message_type}`,
    scheduleApplies: scheduled ? true : null,
    from: parseUaDateTime(r.accident_str) ?? at(start),
    to: at(end),
  }
}

/**
 * The fragment → schedule. Every day block carries its own date ("5 листопада 2026 року"), so a
 * fragment left over from another day is dated that day, never today. Each block ends with the
 * operator's change time ("Оновлено: 16 листопада 2026 22:40", minutes before the Telegram
 * announcement of the same schedule); the newest one is `updatedAt`. Exported for tests.
 */
export function parseGpvFragment(html: string, now: Date): RegionSchedule {
  const region = INFO.id
  const schedules: Record<string, DaySchedule[]> = {}
  let updatedAt: string | null = null
  const blocks = html.split(/<div class="gpvinfodetail"/).slice(1)
  if (!blocks.length && /gpv-table|turnoff-scheduleui-table/.test(html))
    throw new OutageError('parse', 'Poltava: schedule table without day blocks (format changed?)', { region })

  for (const block of blocks) {
    const header = block.slice(0, 2000).replace(/<[^>]+>/g, ' ')
    const date = findUaDate(header, now)
    if (!date) throw new OutageError('parse', 'Poltava: no date in a schedule block', { region })
    const table = /<table[^>]*class="gpv-table"[^>]*>([\s\S]*?)<\/table>/.exec(block)?.[1]
    if (!table) continue
    const stamp = parseUpdated(block, now)
    if (stamp && (!updatedAt || Date.parse(stamp) > Date.parse(updatedAt))) updatedAt = stamp
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const name = /<td class="gpv-q"[^>]*>([^<]+)<\/td>/.exec(row[1]!)?.[1]
      const group = name ? normalizeGroup(name) : null
      if (!group) continue
      const cells = [...row[1]!.matchAll(/<td class="gpv-c(?: ([^"]*))?"/g)].map((c) => {
        // a state nobody has seen (or a cell without one) is reported, never read as "on"
        const s = /(?<![\w-])gpv-(s\d+)(?![\w-])/.exec(c[1] ?? '')?.[1]
        const kind = s === undefined ? undefined : CELL[s]
        if (kind === undefined)
          throw new OutageError(
            'parse',
            `Poltava: group ${group} has a cell of unknown state "${(c[1] ?? '').trim()}"`,
            { region },
          )
        return kind
      })
      if (cells.length !== 48 && cells.length !== 24)
        throw new OutageError('parse', `Poltava: group ${group} has ${cells.length} cells`, { region })
      ;(schedules[group] ??= []).push({ date, status: 'scheduled', intervals: cellsToIntervals(date, cells) })
    }
  }
  // a page without a day table publishes nothing: every group unknown, never `groups: []`,
  // which a caller could read as "no schedule in force"
  if (!Object.keys(schedules).length) return unpublished(region, STANDARD_GROUPS, now, updatedAt)
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt,
    fetchedAt: toKyivIso(now),
  }
}

/** "Оновлено: 16 листопада 2026 22:40" (Kyiv time) → ISO; null when the block has no such line. */
function parseUpdated(block: string, now: Date): string | null {
  const m = /Оновлено:\s*([^<]*?\d{4})\s+(\d{1,2}):(\d{2})\s*</.exec(block)
  const date = m ? findUaDate(m[1]!, now) : null
  if (!m || !date) return null
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return minutes < 1440 ? toKyivIso(kyivInstant(date, minutes)) : null
}

/**
 * `gav_message` lists every emergency schedule the house is in: "Заживлено від … та залучено до
 * ГАВ (черга 10), ГПВ (черга 3-1)." Only ГАВ carries a number; СГАВ, АЧР and САВН are bare
 * memberships, which the queue block can't express, so they are left out. "ГАВ (черга 0)" is
 * outside the 1–10 rotation and counts as no queue. Exported for tests.
 */
export function parseGavMessage(message: string | null | undefined): EmergencyQueues | undefined {
  const gav = [...(message ?? '').matchAll(/(?<![А-ЯІЇЄҐа-яіїєґ])ГАВ\s*\(черга\s*([^)]*)\)/g)].map(
    (m) => m[1]!,
  )
  return emergencyQueues({ gav })
}

/** `<select id="input-filial-main">` options on the home page. Exported for tests. */
export function parseFilials(html: string): { id: string; name: string }[] {
  const select = /<select[^>]*id="input-filial-main"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? ''
  return [...select.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)/g)]
    .filter((m) => m[1] !== '0')
    .map((m) => ({ id: m[1]!, name: m[2]!.trim() }))
}

function parseJsonList<T>(body: string, region: ProviderInfo['id']): T[] {
  let data: unknown
  try {
    data = JSON.parse(body.trim() || '[]')
  } catch (cause) {
    throw new OutageError('parse', 'Poltava: expected JSON', { region, cause })
  }
  if (!Array.isArray(data)) throw new OutageError('parse', 'Poltava: expected a list', { region })
  return data as T[]
}
