import { SECTIGO_DV_R36 } from '../certs.js'
import { emergencyQueues } from '../emergency/queues.js'
import { OutageError } from '../errors.js'
import { compareGroups, normalizeGroup } from '../schedule.js'
import { houseKey, normalizeHouse } from '../text.js'
import { kyivDate } from '../time.js'
import type { City, GroupId, GroupMatch, House, RegionId, Street } from '../types.js'
import { SharedTask } from '../util.js'
import type { ProviderContext } from './provider.js'

/**
 * Cherkasyoblenergo's address lookup: the backend of the "за адресою" tab of
 * cherkasyoblenergo.com/off. Branch → settlement → street → house → the household accounts at
 * that house → the queue of an account ("Графік погодинних відключень - 4 черга 1 підчерга").
 * The page itself lists the accounts of an address and asks the visitor to pick one; here a few
 * are asked, because one building can be wired to two groups (вул. Хрещатик, 200 in Cherkasy:
 * half of the sampled accounts are 1.1, half 5.1).
 *
 * Account numbers are personal data. They live only inside `groupOf`: never returned, logged or
 * cached, and an error of a request that carries one is rebuilt without its URL.
 *
 * It is the backend of a personal cabinet, so requests go one at a time. The server sends only
 * its own certificate; the missing Sectigo intermediate is supplied (see `src/certs.ts`).
 */
const API = 'https://cabinet.cherkasyoblenergo.com/api_new/disconn.php'

/** Branches and their settlements change rarely: one request per branch (22–26), once a day */
const DIRECTORY_TTL_MS = 24 * 3_600_000

/** Accounts asked per house: enough to see a second group, few enough to stay polite */
const SAMPLE = 8

interface Named {
  ID?: string | number
  NAME?: string
}

/** Lists arrive as arrays, or as objects keyed by index */
function rows<T>(data: unknown, what: string, region: RegionId): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') return Object.values(data) as T[]
  throw new OutageError('parse', `Cherkasy ${what}: expected a list`, { region })
}

/** "Смілянські енергетичні мережі", "Городищенська філія" → "Смілянські", "Городищенська" */
const branchName = (name: string) =>
  name
    .replace(/(?:міські\s+)?енергетичні\s+мережі|філія/giu, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * `QUEUE_INFO` lines of one account → its hourly group and ГАВ queue. "в чергу не включено"
 * gives none. Exported for tests.
 */
export function parseQueueInfo(lines: readonly string[]): { group: GroupId | null; gav: string | null } {
  let group: GroupId | null = null
  let gav: string | null = null
  for (const line of lines) {
    if (/погодинн/iu.test(line)) {
      const m = /(\d+)\s*черг\p{L}*\D{0,5}(\d+)\s*підчерг/iu.exec(line)
      if (m) group = normalizeGroup(`${m[1]}.${m[2]}`)
    } else if (/аварійн/iu.test(line)) {
      const m = /(\d+)\s*черг/iu.exec(line)
      if (m) gav = m[1]!
    }
  }
  return { group, gav }
}

/**
 * What makes two entries of a house list one building: the operator files "412- А", "412-А" and
 * "412 А" (and "218/220", "218-220") as separate entries, each with its own accounts. Spelling
 * goes; what separates two numbers stays, so "2/3" is never "23". Exported for tests.
 */
export const cherkasyHouseKey = houseKey

/** Between the spellings of one building in a `House.id`; no house number contains it */
const SPELLINGS = '\u001f'

/** Up to `count` positions spread evenly over a list of `length`, first and last included */
export function spread(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, i) => i)
  return [...new Set(Array.from({ length: count }, (_, k) => Math.round((k * (length - 1)) / (count - 1))))]
}

/**
 * A town is listed by its own branch first, and again further down the lists of other branches
 * ("м. Черкаси" under Уманські, Городищенська, …: a few accounts filed there). Those copies
 * would make every lookup in the town ambiguous, so only the town's own entry is kept. Villages
 * of the same name in different branches are different villages and all stay. Exported for tests.
 */
export function dropStrays<T extends City & { seat: boolean }>(cities: readonly T[]): City[] {
  const seats = new Set(cities.filter((c) => c.seat && /^м\.\s/u.test(c.name)).map((c) => c.name))
  return cities.filter((c) => c.seat || !seats.has(c.name)).map(({ seat: _seat, ...city }) => city)
}

export function cherkasyAddresses(region: RegionId, operator: string) {
  const call = (ctx: ProviderContext, params: Record<string, string>) =>
    // answers as application/x-javascript; the body is JSON
    ctx.http.json<unknown>(`${API}?${new URLSearchParams(params)}`, { region, ca: [SECTIGO_DV_R36] })

  let task: SharedTask<City[]> | null = null
  let taskAt = 0

  const load = async (ctx: ProviderContext): Promise<City[]> => {
    const branches = rows<Named>(await call(ctx, { op: 'department_list' }), 'department_list', region)
    if (!branches.length) throw new OutageError('parse', `${operator}: no branches listed`, { region })
    const cities = new Map<string, City & { seat: boolean }>()
    for (const b of branches) {
      ctx.signal?.throwIfAborted()
      const list = rows<Named>(
        await call(ctx, { op: 'city_list', dept_id: String(b.ID) }),
        'city_list',
        region,
      )
      list.forEach((c, i) => {
        const name = String(c.NAME ?? '').trim()
        if (c.ID === undefined || !name || name.startsWith('*')) return
        const district = branchName(String(b.NAME ?? ''))
        cities.set(String(c.ID), { id: String(c.ID), name, ...(district ? { district } : {}), seat: i === 0 })
      })
    }
    return dropStrays([...cities.values()])
  }

  const directory = (ctx: ProviderContext) => {
    if (!task || task.aborted || Date.now() - taskAt > DIRECTORY_TTL_MS) {
      taskAt = Date.now()
      const t = new SharedTask((signal) => load({ ...ctx, http: ctx.http.withSignal(signal), signal }))
      task = t
      t.promise.catch(() => {
        if (task === t) task = null
      })
    }
    return task.join(ctx.signal)
  }

  /** The queues of one account. The account number goes no further than this request. */
  const queuesOf = async (ctx: ProviderContext, account: string) => {
    const [y, m, d] = kyivDate(ctx.now()).split('-')
    const date = `${d}.${m}.${y}`
    let res: unknown
    try {
      res = await call(ctx, {
        op: 'disconn_by_ls',
        abon_ls: account,
        disconn_selector: '2',
        n_date: date,
        k_date: date,
      })
    } catch (e) {
      ctx.signal?.throwIfAborted()
      // the failed request's URL holds the account number: rebuild the error without it
      const o = e instanceof OutageError ? e : null
      const status = o?.details.status
      throw new OutageError(
        o?.code ?? 'network',
        `${operator}: the queue lookup failed${status ? ` (HTTP ${status})` : ''}`,
        { region, ...(status ? { status } : {}) },
      )
    }
    const info = (res as { DISCONN_QUEUQ?: unknown } | null)?.DISCONN_QUEUQ
    if (info === undefined || info === null)
      throw new OutageError('parse', `${operator}: the queue lookup answered without queues`, { region })
    return parseQueueInfo(
      rows<{ QUEUE_INFO?: string }>(info, 'disconn_by_ls', region).map((q) => String(q.QUEUE_INFO ?? '')),
    )
  }

  return {
    async searchCities(ctx: ProviderContext): Promise<City[]> {
      return directory(ctx)
    },

    async searchStreets(ctx: ProviderContext, _query: string, city?: City): Promise<Street[]> {
      if (!city) throw new OutageError('not-found', `${operator}: pick a city first`, { region })
      const list = rows<Named>(
        await call(ctx, { op: 'street_list', city_id: city.id, search_name: '' }),
        'street_list',
        region,
      )
      return (
        list
          .map((s) => ({ id: String(s.ID ?? ''), name: String(s.NAME ?? '').trim(), cityId: city.id }))
          // "*невизначена": accounts the operator hasn't filed under a street
          .filter((s) => s.id && s.name && !s.name.startsWith('*'))
      )
    },

    async searchHouses(ctx: ProviderContext, street: Street, query?: string): Promise<House[]> {
      const list = rows<{ HOUSE?: string | number }>(
        await call(ctx, { op: 'house_list', street_id: street.id, search_name: '' }),
        'house_list',
        region,
      )
      // one entry per building: its spellings travel in the id, the first one is shown
      const buildings = new Map<string, string[]>()
      for (const h of list) {
        const number = String(h.HOUSE ?? '').trim()
        if (!number) continue
        const key = cherkasyHouseKey(number)
        const known = buildings.get(key)
        if (!known) buildings.set(key, [number])
        else if (!known.includes(number)) known.push(number)
      }
      let houses = [...buildings].map(([key, spellings]) => ({ key, spellings }))
      if (query?.trim()) {
        // "23" must not offer "2/3", which only looks the same once the separators are dropped
        const want = cherkasyHouseKey(query)
        const loose = normalizeHouse(query)
        houses = houses.filter((h) => h.key === want || normalizeHouse(h.spellings[0]!) !== loose)
      }
      return houses.map((h) => ({
        id: h.spellings.join(SPELLINGS),
        number: h.spellings[0]!,
        streetId: street.id,
      }))
    },

    async groupOf(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<GroupMatch> {
      const where = `${house.number}, ${street.name}`
      // every spelling the operator files the building under has accounts of its own
      const accounts: string[] = []
      for (const spelling of house.id.split(SPELLINGS)) {
        ctx.signal?.throwIfAborted()
        let list: { LS?: string | number }[]
        try {
          list = rows<{ LS?: string | number }>(
            await call(ctx, { op: 'ls_list_by_addr', street_id: street.id, house: spelling }),
            'ls_list_by_addr',
            region,
          )
        } catch (e) {
          ctx.signal?.throwIfAborted()
          // the answer is the list of account numbers: a parse error quotes the text around the
          // fault in its `cause`, so the error is rebuilt without it
          const o = e instanceof OutageError ? e : null
          const status = o?.details.status
          throw new OutageError(
            o?.code ?? 'network',
            `${operator}: the lookup of accounts at this address failed${status ? ` (HTTP ${status})` : ''}`,
            { region, ...(status ? { status } : {}) },
          )
        }
        for (const a of list) {
          const account = String(a.LS ?? '').trim()
          if (account && !accounts.includes(account)) accounts.push(account)
        }
      }
      if (!accounts.length)
        throw new OutageError(
          'not-found',
          `${where}: no household accounts at this address, so the operator's lookup can't tell its queue`,
          { region },
        )
      const seen = new Map<GroupId, number>()
      const gav: string[] = []
      for (const i of spread(accounts.length, SAMPLE)) {
        ctx.signal?.throwIfAborted()
        const q = await queuesOf(ctx, accounts[i]!)
        if (q.group) seen.set(q.group, (seen.get(q.group) ?? 0) + 1)
        if (q.gav) gav.push(q.gav)
      }
      // most accounts first; a building with two inputs has two
      const groups = [...seen.entries()]
        .sort((a, b) => b[1] - a[1] || compareGroups(a[0], b[0]))
        .map(([g]) => g)
      if (!groups.length)
        throw new OutageError('not-found', `${where}: the operator gives no hourly-outage queue`, { region })
      const emergency = emergencyQueues({ gav })
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
        ...(emergency ? { emergency } : {}),
      }
    },
  }
}
