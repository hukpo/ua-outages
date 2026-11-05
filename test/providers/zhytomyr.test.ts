import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { isOutageError } from '../../src/errors.js'
import type { FetchLike } from '../../src/http.js'
import { parseAddressRows, parseSchedulePage, zhytomyrProvider } from '../../src/providers/zhytomyr.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const PAGE = 'https://www.ztoe.com.ua/unhooking-search.php'

// The site answers in windows-1251, so fixtures stay in that encoding and are served as bytes
const bytes = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/zhytomyr/${name}`, import.meta.url)))
const SCHEDULE = bytes('schedule-2026-11-05.cp1251.html')
const decoded = (buf: Buffer) => new TextDecoder('windows-1251').decode(buf)
/** What the site renders for a РЕМ that the tests don't care about: the form with no settlements. */
const EMPTY_FORM = '<form action="/unhooking-search.php" id="mainform" method="post"><select name="naspunkt_id"><option value="0">Оберіть населений пункт</option></select></form>'

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
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [zhytomyrProvider()] }), calls }
}

const spans = (s: ReturnType<typeof parseSchedulePage>, group: string, day: number) =>
  s.schedules[group]![day]!.intervals.map((i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`)

describe('Zhytomyroblenergo', () => {
  const s = parseSchedulePage(decoded(SCHEDULE), NOW)

  it('reads both day tables and all twelve groups', () => {
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('turns red slots into off intervals', () => {
    // same as the red cells on the page and the yaroslav2901 aggregator for 05.11
    expect(spans(s, '1.1', 0)).toEqual(['00:00–02:00 off', '06:00–10:00 off', '12:00–16:00 off', '18:00–22:00 off'])
    expect(spans(s, '1.1', 1)).toEqual(['00:00–04:00 off', '06:00–08:00 off', '10:00–14:00 off', '16:00–20:00 off'])
  })

  it('copes with the 2.2 row that lacks </a>', () => {
    expect(spans(s, '2.2', 0)).toEqual(['02:00–06:00 off', '08:00–12:00 off', '14:00–18:00 off', '20:00–22:00 off'])
  })

  it('reads the update time', () => {
    expect(s.updatedAt).toBe('2026-11-05T23:30:00+02:00')
    expect(s.fetchedAt).toBe('2026-11-05T23:40:00+02:00')
  })

  it('treats a page without day tables as no schedule', () => {
    const html = decoded(SCHEDULE).replace(/<table x:str[\s\S]*?width:1300pt[\s\S]*?<\/table>/g, '')
    const empty = parseSchedulePage(html, NOW)
    expect(empty.groups).toEqual([])
    expect(empty.updatedAt).toBe('2026-11-05T23:30:00+02:00')
  })

  it('fails loudly on a new slot colour or a changed table', () => {
    const grey = decoded(SCHEDULE).replace('<td style="background: #ff3333">', '<td style="background: #cccccc">')
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
    const m = await client().client.findGroup('zhytomyr', { city: 'Житомир', street: 'Київська', house: '86' })
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
