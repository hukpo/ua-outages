import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { isOutageError } from '../../src/errors.js'
import type { FetchLike } from '../../src/http.js'
import { assessFreshness } from '../../src/freshness.js'
import {
  parseAddressRows,
  parseApiSchedules,
  parseChangeTime,
  parseSchedulePage,
  zhytomyrProvider,
} from '../../src/providers/zhytomyr.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const PAGE = 'https://www.ztoe.com.ua/unhooking-search.php'

// The site answers in windows-1251, so fixtures stay in that encoding and are served as bytes
const bytes = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/zhytomyr/${name}`, import.meta.url)))
const SCHEDULE = bytes('schedule-2026-11-05.cp1251.html')
const decoded = (buf: Buffer) => new TextDecoder('windows-1251').decode(buf)
/** What the site renders for a РЕМ that the tests don't care about: the form with no settlements. */
const EMPTY_FORM =
  '<form action="/unhooking-search.php" id="mainform" method="post"><select name="naspunkt_id"><option value="0">Оберіть населений пункт</option></select></form>'

function client(houses = bytes('search-step3-kyivska-all-houses.cp1251.html')) {
  const calls: Record<string, string>[] = []
  const fetch: FetchLike = async (url, init) => {
    if (!url.startsWith(PAGE)) throw new Error(`unexpected ${url}`)
    if (!init?.body) return new Response(SCHEDULE)
    const form = Object.fromEntries(new URLSearchParams(String(init.body)))
    calls.push(form)
    if (form.vulica_id) return new Response(houses)
    if (form.naspunkt_id) return new Response(bytes('search-step2-zhytomyr-streets.cp1251.html'))
    return new Response(form.rem_id === '7' ? bytes('search-step1-rem7-settlements.cp1251.html') : EMPTY_FORM)
  }
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [zhytomyrProvider()] }),
    calls,
  }
}

const spans = (s: ReturnType<typeof parseSchedulePage>, group: string, day: number) =>
  s.schedules[group]![day]!.intervals.map((i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`)

describe('Zhytomyroblenergo', () => {
  const s = parseSchedulePage(decoded(SCHEDULE), NOW)

  it('reads both day tables and all twelve groups', () => {
    expect(s.groups).toEqual([
      '1.1',
      '1.2',
      '2.1',
      '2.2',
      '3.1',
      '3.2',
      '4.1',
      '4.2',
      '5.1',
      '5.2',
      '6.1',
      '6.2',
    ])
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('turns red slots into off intervals', () => {
    // same as the red cells on the page and the yaroslav2901 aggregator for 05.11
    expect(spans(s, '1.1', 0)).toEqual([
      '00:00–02:00 off',
      '06:00–10:00 off',
      '12:00–16:00 off',
      '18:00–22:00 off',
    ])
    expect(spans(s, '1.1', 1)).toEqual([
      '00:00–04:00 off',
      '06:00–08:00 off',
      '10:00–14:00 off',
      '16:00–20:00 off',
    ])
  })

  it('copes with the 2.2 row that lacks </a>', () => {
    expect(spans(s, '2.2', 0)).toEqual([
      '02:00–06:00 off',
      '08:00–12:00 off',
      '14:00–18:00 off',
      '20:00–22:00 off',
    ])
  })

  it("does not take the page's rolling stamp for a change time", () => {
    // "Дата оновлення інформації - 23:30 05.11.2026": regenerated every half hour
    expect(s.updatedAt).toBeNull()
    expect(s.fetchedAt).toBe('2026-11-05T23:40:00+02:00')
  })

  it('treats a page without day tables as no schedule', () => {
    const html = decoded(SCHEDULE).replace(/<table x:str[\s\S]*?width:1300pt[\s\S]*?<\/table>/g, '')
    const empty = parseSchedulePage(html, NOW)
    expect(empty.groups).toEqual([])
    expect(empty.updatedAt).toBeNull()
  })

  it('fails loudly on a new slot colour or a changed table', () => {
    const grey = decoded(SCHEDULE).replace(
      '<td style="background: #ff3333">',
      '<td style="background: #cccccc">',
    )
    expect(() => parseSchedulePage(grey, NOW)).toThrow(/unknown slot colour "#cccccc"/)
    const short = decoded(SCHEDULE).replace('<td style="background: #ffffff">&nbsp;</td>', '')
    expect(() => parseSchedulePage(short, NOW)).toThrow(/47 slots/)
    try {
      parseSchedulePage('<html><body>Сайт на реконструкції</body></html>', NOW)
      expect.unreachable()
    } catch (e) {
      expect(isOutageError(e) && e.code).toBe('parse')
    }
  })

  it('splits house lists and keeps households apart from businesses', () => {
    const rows = parseAddressRows(decoded(bytes('search-step3-kyivska-all-houses.cp1251.html')))
    expect(rows).toHaveLength(77)
    expect(rows[0]).toEqual({ houses: ['1', '3', '5', '7/4', '17/1'], group: '1.2', household: false })
    expect(rows.filter((r) => r.group === null).length).toBeGreaterThan(0)
  })

  it('finds a group by address with all rows requested', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('zhytomyr', { city: 'Житомир', street: 'вул. Київська', house: '5' })
    expect(m).toEqual({
      region: 'zhytomyr',
      group: '1.2',
      address: { city: 'місто Житомир', street: 'вул. Київська', house: '5' },
    })
    expect(calls.at(-1)).toEqual({ rem_id: '7', naspunkt_id: '16657', vulica_id: '173934', all: '1' })
  })

  it('prefers the household row when businesses in the house have other groups', async () => {
    // 86: households 3.1; businesses 1.2, 5.2 and 3.1
    const m = await client().client.findGroup('zhytomyr', {
      city: 'Житомир',
      street: 'Київська',
      house: '86',
    })
    expect(m.group).toBe('3.1')
    expect(m.otherGroups).toBeUndefined()
  })

  it('explains houses that are exempt from the schedule', async () => {
    await expect(
      client().client.findGroup('zhytomyr', { city: 'Житомир', street: 'Київська', house: '8' }),
    ).rejects.toThrow(/not in the outage schedule/)
  })

  it('reports an unknown house with the closest numbers', async () => {
    await expect(
      client().client.findGroup('zhytomyr', { city: 'Житомир', street: 'Київська', house: '999' }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('Zhytomyroblenergo: the JSON API and the page as two channels', () => {
  const API = 'https://www.ztoe.com.ua/gpv/api'
  /** Real answers of 17.11.2026 00:44 for all twelve subqueues, and the page of the same minute */
  const API_ROWS: Record<string, { date: string; span: string; color: string }[]> = JSON.parse(
    bytes('api-schedule-2026-11-17.by-group.json').toString('utf8'),
  )
  const PAGE_17 = bytes('schedule-2026-11-17.trimmed.cp1251.html')
  const AT = new Date('2026-11-17T00:44:00+02:00')
  const STAMP = '2026.11.16 22:55:55'
  const GROUPS = Object.keys(API_ROWS)

  interface Setup {
    rows?: typeof API_ROWS
    page?: Buffer | null
    api?: boolean
    stamp?: string | null
    now?: Date
  }
  function setup({ rows = API_ROWS, page = PAGE_17, api = true, stamp = STAMP, now = AT }: Setup = {}) {
    const urls: string[] = []
    const fetch: FetchLike = async (url) => {
      urls.push(url)
      if (url === PAGE)
        return page ? new Response(new Uint8Array(page)) : new Response('down', { status: 503 })
      if (!api) return new Response('down', { status: 503 })
      if (url === `${API}/api-message.php`)
        return new Response(bytes('api-message-2026-11-17.json').toString('utf8'), {
          headers: stamp ? { 'Last-Modified-Shedules-Date': stamp } : {},
        })
      const q = new URL(url).searchParams
      const group = `${q.get('cherga_id')}.${q.get('pidcherga_id')}`
      if (!url.startsWith(`${API}/api-schedule.php?`) || !rows[group]) throw new Error(`unexpected ${url}`)
      return new Response(JSON.stringify(rows[group]))
    }
    const client = new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      retries: 0,
      providers: [zhytomyrProvider()],
    })
    return { client, urls }
  }
  /** The API answers with every row moved to another date */
  const redated = (from: string, to: string): typeof API_ROWS =>
    JSON.parse(JSON.stringify(API_ROWS).replaceAll(from, to))
  const off = (d: { intervals: { from: string; to: string; kind: string }[] }) =>
    d.intervals.map((i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`)

  it('reads the change time from the API header, in Kyiv time', () => {
    expect(parseChangeTime(STAMP)).toBe('2026-11-16T22:55:55+02:00')
    expect(parseChangeTime('2026.07.01 09:05:07')).toBe('2026-07-01T09:05:07+03:00')
    for (const bad of [null, undefined, '', '00:30 17.11.2026', '2026.11.16', '2026.11.16 25:00:00'])
      expect(parseChangeTime(bad)).toBeNull()
  })

  it('reads the API rows: red is off, a day is 48 half hours', () => {
    const read = parseApiSchedules(API_ROWS, '2026-11-16T22:55:55+02:00')
    expect(Object.keys(read.days)).toEqual(['2026-11-17'])
    const day = read.days['2026-11-17']!
    expect(day.publishedAt).toBe('2026-11-16T22:55:55+02:00')
    expect(Object.keys(day.schedules)).toEqual(GROUPS)
    expect(off(day.schedules['1.1']!)).toEqual(['00:00–03:00 off', '06:00–09:00 off', '16:30–19:30 off'])
    // the last row is "23:30-00:00"
    expect(day.schedules['6.2']!.intervals.every((i) => i.kind === 'off')).toBe(true)
  })

  it('agrees with the page fetched in the same minute, cell for cell', () => {
    const page = parseSchedulePage(decoded(PAGE_17), AT)
    const api = parseApiSchedules(API_ROWS, null).days['2026-11-17']!.schedules
    for (const g of GROUPS) expect(api[g]).toEqual(page.schedules[g]![0])
  })

  it('takes each day from the API, with the header as updatedAt, and lists both channels', async () => {
    const { client, urls } = setup()
    const s = await client.getSchedules('zhytomyr')
    expect(s.groups).toEqual(GROUPS)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(off(s.schedules['1.1']![0]!)).toEqual(['00:00–03:00 off', '06:00–09:00 off', '16:30–19:30 off'])
    // not the page's "00:30 17.11.2026"
    expect(s.updatedAt).toBe('2026-11-16T22:55:55+02:00')
    expect(s.sources).toEqual([
      { id: 'api', url: PAGE, ok: true, dates: ['2026-11-17'], updatedAt: '2026-11-16T22:55:55+02:00' },
      { id: 'site', url: PAGE, ok: true, dates: [], updatedAt: null },
    ])
    // twelve subqueues, the header, the page
    expect(urls).toHaveLength(14)
    expect(assessFreshness(s, { now: AT })).toMatchObject({ state: 'fresh', today: 'published', issues: [] })
  })

  it('takes a day only the page has from the page (tomorrow appearing there first)', async () => {
    // the page of 05.11 has 05.11 and 06.11; the API answers only for 05.11
    const { client } = setup({
      rows: redated('17.11.2026', '05.11.2026'),
      page: SCHEDULE,
      now: NOW,
      stamp: '2026.11.05 21:10:00',
    })
    const s = await client.getSchedules('zhytomyr')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(s.sources!.map((x) => [x.id, x.dates])).toEqual([
      ['api', ['2026-11-05']],
      ['site', ['2026-11-06']],
    ])
    // 05.11 is the API's (17.11's real cells moved there), 06.11 the page's
    expect(off(s.schedules['1.1']![0]!)).toEqual(['00:00–03:00 off', '06:00–09:00 off', '16:30–19:30 off'])
    expect(off(s.schedules['1.1']![1]!)).toEqual([
      '00:00–04:00 off',
      '06:00–08:00 off',
      '10:00–14:00 off',
      '16:00–20:00 off',
    ])
    expect(s.updatedAt).toBe('2026-11-05T21:10:00+02:00')
    // the two channels show different cells for 05.11: the page is marked, the API (dated) wins
    expect(s.sources![1]!.disagrees).toBe(true)
    expect(assessFreshness(s, { now: NOW }).issues.map((i) => i.code)).toEqual(['sources-disagree'])
  })

  it('falls back to the page when the API is down, without a change time', async () => {
    const s = await setup({ api: false }).client.getSchedules('zhytomyr')
    expect(off(s.schedules['1.1']![0]!)).toEqual(['00:00–03:00 off', '06:00–09:00 off', '16:30–19:30 off'])
    expect(s.updatedAt).toBeNull()
    expect(s.sources![0]).toMatchObject({ id: 'api', ok: false, dates: [], error: { code: 'http' } })
    expect(s.sources![1]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'], updatedAt: null })
    expect(assessFreshness(s, { now: AT }).issues.map((i) => i.code)).toEqual(['source-failed'])
  })

  it('keeps working on the API alone when the page is down', async () => {
    const s = await setup({ page: null }).client.getSchedules('zhytomyr')
    expect(s.schedules['3.2']![0]!.status).toBe('scheduled')
    expect(s.updatedAt).toBe('2026-11-16T22:55:55+02:00')
    expect(s.sources![1]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
  })

  it('fails when both channels are down', async () => {
    await expect(setup({ api: false, page: null }).client.getSchedules('zhytomyr')).rejects.toMatchObject({
      code: 'http',
    })
  })

  it('still reads the API when the change-time header is missing', async () => {
    const s = await setup({ stamp: null }).client.getSchedules('zhytomyr')
    expect(s.updatedAt).toBeNull()
    // no timestamps on either side: the tie goes to the API, the first channel
    expect(s.sources!.map((x) => [x.id, x.dates])).toEqual([
      ['api', ['2026-11-17']],
      ['site', []],
    ])
  })

  it('dates an old API answer by its rows, never today', async () => {
    const later = new Date('2026-11-19T09:00:00+02:00')
    const s = await setup({ now: later }).client.getSchedules('zhytomyr')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(assessFreshness(s, { now: later })).toMatchObject({ state: 'stale', today: 'missing' })
  })

  it('rejects API rows it cannot be sure about instead of guessing', async () => {
    const with11 = (rows: unknown) => ({ ...API_ROWS, '1.1': rows }) as typeof API_ROWS
    const r = API_ROWS['1.1']!
    // a colour nobody has seen is not "power on"
    expect(() => parseApiSchedules(with11([{ ...r[0]!, color: 'yellow' }, ...r.slice(1)]), null)).toThrow(
      /unexpected slot/,
    )
    // a day with a hole
    expect(() => parseApiSchedules(with11(r.slice(1)), null)).toThrow(/47 of 48 slots/)
    expect(() => parseApiSchedules(with11([...r, r[0]]), null)).toThrow(/twice/)
    // what the endpoint answers without its parameters: rows of "queue 0.0"
    expect(() =>
      parseApiSchedules(with11(r.map((x) => ({ ...x, cherga: '0', pidcherga: '0' }))), null),
    ).toThrow(/asked for group 1.1, got 0.0/)
    expect(() => parseApiSchedules(with11({ error: 'x' }), null)).toThrow(/expected a list/)
    expect(() => parseApiSchedules(with11([{ ...r[0]!, span: '00:10-00:40' }, ...r.slice(1)]), null)).toThrow(
      /unexpected slot/,
    )
    // an empty list is a group with nothing published, not an error
    expect(parseApiSchedules(with11([]), null).days['2026-11-17']!.schedules['1.1']).toBeUndefined()

    // through the client: the API channel fails as a whole and the page stands in
    const s = await setup({ rows: with11(r.slice(1)) }).client.getSchedules('zhytomyr')
    expect(s.sources![0]).toMatchObject({ id: 'api', ok: false, error: { code: 'parse' } })
    expect(s.sources![1]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'] })
    expect(off(s.schedules['1.1']![0]!)).toEqual(['00:00–03:00 off', '06:00–09:00 off', '16:30–19:30 off'])
  })
})
