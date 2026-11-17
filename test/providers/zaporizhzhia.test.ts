import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { stampTimes, zaporizhzhiaProvider } from '../../src/providers/zaporizhzhia.js'
import {
  addSheet,
  groupLabel,
  mergeStrays,
  parseCsv,
  parseHouses,
  parseSheetLinks,
  type ZoeDirectory,
} from '../../src/providers/zaporizhzhia-addresses.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'

const NOW = new Date('2026-11-16T12:00:00+02:00')
const F = 'zaporizhzhia/addresses'
const CITY_PAGE = fixture(`${F}/page-city.html`)
const AREA_PAGE = fixture(`${F}/page-area.html`)

const city = parseSheetLinks(CITY_PAGE, true)
const area = parseSheetLinks(AREA_PAGE, false)
const sheet = (list: typeof city, group: string) => list.find((s) => s.group === group)!.id

function client() {
  const { fetch, calls } = mockFetch([
    { match: encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підч') + '/', body: CITY_PAGE },
    { match: encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підче') + '/', body: AREA_PAGE },
    { match: `/d/${sheet(city, '1.1')}/gviz`, body: fixture(`${F}/city-1.1.csv`) },
    { match: `/d/${sheet(area, '3.1')}/gviz`, body: fixture(`${F}/area-3.1.csv`) },
    { match: `/d/${sheet(area, '5.1')}/gviz`, body: fixture(`${F}/area-5.1.csv`) },
    // the rest: "Відключення відсутні"
    { match: /docs\.google\.com\/spreadsheets\/d\/[\w-]+\/gviz/, body: fixture(`${F}/area-1.1.csv`) },
  ])
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [zaporizhzhiaProvider()] }),
    calls,
  }
}

describe('Zaporizhzhia address lists', () => {
  it('reads the group of each linked sheet from its title', () => {
    expect(city.map((s) => s.group)).toEqual([
      '1.1',
      '1.2',
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
    expect(area.map((s) => s.group)).toEqual([
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
    expect(city[0]!.gid).toBe('2134247359')
    expect(groupLabel('м.Запоріжжя, Черга 3, підчерга 2')).toBe('3.2')
    expect(groupLabel('1 черга ІІ підчерга')).toBe('1.2')
    expect(groupLabel('6 черга 1 підчерга населення')).toBe('6.1')
  })

  it('finds a house in the city lists, one in a range, and a house in another town', async () => {
    const { client: c } = client()
    expect(
      await c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'бульвар Шевченка', house: '10-А' }),
    ).toMatchObject({
      group: '1.1',
      address: { city: 'м. Запоріжжя', street: 'бул. Шевченка', house: '10А' },
    })
    // "34-40": 36 is on that side; "46-54" covers 48а
    expect(
      (await c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'Шевченка', house: '36' })).group,
    ).toBe('1.1')
    expect(
      (await c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'Шевченка', house: '48а' })).group,
    ).toBe('1.1')
    await expect(
      c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'Шевченка', house: '37' }),
    ).rejects.toThrow()
    expect(
      (await c.findGroup('zaporizhzhia', { city: 'Вільнянськ', street: 'Бочарова', house: '24б' })).group,
    ).toBe('3.1')
  })

  it('takes the actual group over the one the sheet is for, and folds Latin letters', async () => {
    const { client: c } = client()
    // listed on the 5.1 sheet, "фактична по режиму" 3.1; written "14a" with a Latin a
    expect(
      await c.findGroup('zaporizhzhia', { city: 'Лукашеве', street: 'Садова', house: '14а' }),
    ).toMatchObject({
      group: '3.1',
      address: { house: '14А' },
    })
  })

  it('downloads the pages and sheets once', async () => {
    const { client: c, calls } = client()
    await c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'Шевченка', house: '12' })
    const n = calls.length
    await c.findGroup('zaporizhzhia', { city: 'Запоріжжя', street: 'Автоклубна', house: '9' })
    expect(calls.length).toBe(n)
    expect(n).toBe(2 + 23)
  })
})

describe('Zaporizhzhia house cells', () => {
  it('ranges run over one side unless "поспіль"; mixed ends take every number', () => {
    expect(parseHouses('34-40|1–9 поспіль|2-9|1-10 непарні|1-10 парні|25–23').ranges).toEqual([
      { from: 34, to: 40, step: 2 },
      { from: 1, to: 9, step: 1 },
      { from: 2, to: 9, step: 1 },
      { from: 1, to: 10, step: 2 },
      { from: 2, to: 10, step: 2 },
      { from: 23, to: 25, step: 2 },
    ])
  })

  it('drops entrances, floors and notes; reads letters, slashes and corps', () => {
    expect(
      parseHouses(
        '17 п.1–2|1 (п.1-4)|145 (5 пов)|70/1|12 корпус 2|4,6 (9 пов)|10а п. 3–4|будинки без номерів - 5|СТ',
      ).numbers,
    ).toEqual(['17', '1', '145', '70/1', '12 корп. 2', '4', '6', '10А'])
  })

  it('an empty cell is the whole street; one of only unnumbered houses is nothing', () => {
    expect(parseHouses('').whole).toBe(true)
    expect(parseHouses('будинки без номерів - 3')).toEqual({ numbers: [], ranges: [], whole: false })
  })

  it('parses quoted CSV cells with commas and doubled quotes', () => {
    expect(parseCsv('"a","b, c"\n"ТОВ ""Х""",""\n')).toEqual([
      ['a', 'b, c'],
      ['ТОВ "Х"', ''],
    ])
  })

  it('a row or two under the wrong community joins the town; two real villages of a name stay apart', () => {
    const dir: ZoeDirectory = { cities: new Map() }
    const head = [
      '',
      'Громада',
      'Населений пункт',
      'Вулиця',
      'Будинки',
      'Категорія',
      'Черга',
      'Підчерга',
      'Черга (фактична)',
      'Підчерга (фактична)',
    ]
    const row = (tg: string, town: string, street: string, houses: string) => [
      '',
      tg,
      town,
      street,
      houses,
      '',
      '',
      '',
      '',
      '',
    ]
    addSheet(dir, { id: 'x', gid: null, group: '4.1', city: false }, [
      head,
      ...Array.from({ length: 12 }, (_, i) => row('Вільнянська ТГ', 'м. Вільнянськ', `вул. Нова ${i}`, '1')),
      row('Павлівська ТГ', 'м. Вільнянськ', 'вул. Соборна', '5'),
      ...Array.from({ length: 3 }, (_, i) => row('Широківська ТГ', 'с. Широке', `вул. Лісна ${i}`, '1')),
      ...Array.from({ length: 3 }, (_, i) =>
        row('Михайло-Лукашівська ТГ', 'с. Широке', `вул. Лісна ${i}`, '1'),
      ),
    ])
    mergeStrays(dir)
    const names = [...dir.cities.values()].map((c) => `${c.city.name} (${c.city.district})`)
    expect(names.sort()).toEqual([
      'м. Вільнянськ (Вільнянська ТГ)',
      'с. Широке (Михайло-Лукашівська ТГ)',
      'с. Широке (Широківська ТГ)',
    ])
    const vil = [...dir.cities.values()].find((c) => c.city.district === 'Вільнянська ТГ')!
    expect(
      [...vil.streets.values()].some(
        (s) => s.street.name === 'вул. Соборна' && s.street.cityId === vil.city.id,
      ),
    ).toBe(true)
  })
})

describe('Zaporizhzhiaoblenergo: site and Telegram', () => {
  const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
  const PAGE = fixture('zaporizhzhia/outage-page-2026-11-17T0025.articles.html')
  const SITE = 'https://www.zoe.com.ua/outage/'
  const TG = 'https://t.me/s/Zaporizhzhyaoblenergo_news'
  const CHANNEL: Route = {
    match: TG,
    body: fixture('zaporizhzhia/telegram-Zaporizhzhyaoblenergo_news-3598-3621.trimmed.html'),
  }
  // the night the research measured: "(оновлено 00:13)" for 17.11 was on the site at 00:25
  const NIGHT = new Date('2026-11-17T00:25:00+02:00')
  const schedules = (routes: Route[], now = NIGHT) =>
    new OutageClient({
      fetch: mockFetch(routes).fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [zaporizhzhiaProvider()],
    }).getSchedules('zaporizhzhia')

  it('reports the "(оновлено HH:MM)" of the current article as updatedAt', async () => {
    const s = await schedules([{ match: SITE, body: PAGE }, CHANNEL])
    expect(s.updatedAt).toBe('2026-11-17T00:13:00+02:00')
    expect(s.sources).toMatchObject([
      { id: 'site', ok: true, dates: ['2026-11-16', '2026-11-17'], updatedAt: '2026-11-17T00:13:00+02:00' },
      // its 23:35 post is the site's first article for 17.11, since replaced: not used
      { id: 'telegram:@Zaporizhzhyaoblenergo_news', ok: true, dates: [] },
    ])
    // the 00:13 version, not the first one (1.2: 00:00–01:30, 10:00–15:00, 19:00–24:00)
    expect(hhmm(s.schedules['1.2']![1]!)).toEqual([
      '00:00-01:30',
      '05:30-10:30',
      '14:30-19:30',
      '23:30-00:00',
    ])
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
  })

  it('dates each stamp by its place on the page: the same evening or the day itself', () => {
    const titles = [...PAGE.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]!)
    const articles = titles.map((t) => ({
      date: `2026-11-${/НА (\d+) ЛИСТОПАДА|^(\d+) ЛИСТОПАДА/.exec(t)!.slice(1).find(Boolean)}`,
      stamp: /оновлено (\d\d:\d\d)/.exec(t)?.[1] ?? null,
    }))
    const times = stampTimes(articles, NIGHT)
    expect(times.slice(0, 3)).toEqual(['2026-11-17T00:13:00+02:00', null, '2026-11-16T16:27:00+02:00'])
    // "ОНОВЛЕНО ГПВ НА 16 ЛИСТОПАДА (оновлено 23:34)" was published on the evening of 15.11
    expect(titles[10]).toContain('НА 16 ЛИСТОПАДА')
    expect(times[10]).toBe('2026-11-15T23:34:00+02:00')
    // never later than the article above it, never after now
    const known = times.filter((t): t is string => !!t).map((t) => Date.parse(t))
    expect(known).toEqual([...known].sort((a, b) => b - a))
    expect(stampTimes([{ date: '2026-11-17', stamp: '00:40' }], NIGHT)).toEqual(['2026-11-16T00:40:00+02:00'])
  })

  it('falls back to Telegram when the site is down, reading the block format', async () => {
    const s = await schedules([{ match: SITE, status: 500, body: '' }, CHANNEL])
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
    expect(s.sources![1]).toMatchObject({ ok: true, dates: ['2026-11-17'] })
    expect(s.updatedAt).toBe('2026-11-16T23:35:49+02:00')
    expect(s.groups).toHaveLength(12)
    // post 3621: "⚡ Черга 1.2 / з 00:00 до 01:30 / з 10:00 до 15:00 / з 19:00 до 24:00"
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual(['00:00-01:30', '10:00-15:00', '19:00-00:00'])
    expect(hhmm(s.schedules['2.2']![0]!)).toEqual(['18:00-22:30'])
    // the sentence about ГОП "з 00:00 до 24:00" after the last block adds nothing to 6.2
    expect(hhmm(s.schedules['6.2']![0]!)).toEqual(['01:00-06:00', '10:00-15:00', '19:00-00:00'])
  })

  it('reads every schedule post of the channel, both formats, and skips ГАВ notices and pictures', async () => {
    // 16.11 17:00, the site down: 3602 (lines, "завтра, 16 листопада"), 3604 (blocks,
    // "на 16.11.2026"), 3606–3615 (lines); 3610, 3613, 3616 are ГАВ/СГАВ on and off
    const s = await schedules(
      [{ match: SITE, status: 500, body: '' }, CHANNEL],
      new Date('2026-11-16T17:00:00+02:00'),
    )
    const nov16 = (g: string) => s.schedules[g]!.find((d) => d.date === '2026-11-16')!
    // the 16:33 post, equal to the site's "(оновлено 16:27)"
    expect(hhmm(nov16('1.1'))).toEqual(['02:30-06:00', '11:30-16:30', '20:30-00:00'])
    expect(hhmm(nov16('6.2'))).toEqual(['00:00-03:00', '07:00-12:00', '16:00-21:00'])
    expect(Object.values(s.schedules).every((days) => days.every((d) => d.status === 'scheduled'))).toBe(true)
  })

  it("takes the time of a day's first post from Telegram, which has the same text", async () => {
    // 16.11 23:40, before the 00:13 update: the site's article for 17.11 carries no time
    const before = PAGE.replace(/<article id="post-393166">[\s\S]*?<\/article>/, '')
    const s = await schedules([{ match: SITE, body: before }, CHANNEL], new Date('2026-11-16T23:40:00+02:00'))
    expect(s.sources).toMatchObject([
      { id: 'site', ok: true, dates: ['2026-11-15', '2026-11-16'], updatedAt: '2026-11-16T16:27:00+02:00' },
      { id: 'telegram:@Zaporizhzhyaoblenergo_news', ok: true, dates: ['2026-11-17'] },
    ])
    expect(s.updatedAt).toBe('2026-11-16T23:35:49+02:00')
    expect(hhmm(s.schedules['1.2']!.at(-1)!)).toEqual(['00:00-01:30', '10:00-15:00', '19:00-00:00'])
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
    // alone, the site has that day without a time
    const alone = await schedules(
      [
        { match: SITE, body: before },
        { match: TG, status: 500, body: '' },
      ],
      new Date('2026-11-16T23:40:00+02:00'),
    )
    expect(alone.sources![0]).toMatchObject({ dates: ['2026-11-15', '2026-11-16', '2026-11-17'] })
    expect(alone.updatedAt).toBe('2026-11-16T16:27:00+02:00')
  })

  it('fails with the site error when both are down', async () => {
    await expect(
      schedules([
        { match: SITE, status: 500, body: '' },
        { match: TG, status: 500, body: '' },
      ]),
    ).rejects.toMatchObject({ code: 'http', message: expect.stringContaining('zoe.com.ua') })
  })
})
