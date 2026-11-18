import { describe, expect, it } from 'vitest'
import type { ImageProcessor, PostEvent, PostInput, TextProcessor } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import type { FetchLike } from '../../src/http.js'
import { lvivProvider, lvivTemplate } from '../../src/providers/lviv.js'
import { STANDARD_GROUPS } from '../../src/schedule.js'
import {
  ev,
  expectUnpublished,
  fakeImage,
  fakeText,
  fixture,
  fixtureBytes,
  gpvSchedule,
  mockFetch,
} from '../helpers.js'

const NOW = new Date('2026-10-17T19:30:00+03:00')
const MENUS = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'
const API = 'https://power-api.loe.lviv.ua/api'

/** What a model reads in each of the fixture texts */
function lvivAnswer(input: PostInput) {
  const t = input.text
  if (t.includes('Група 1.1') && t.includes('на 17.10.2026'))
    return {
      statedAt: '18:56',
      events: [
        ev({
          kind: 'gpv',
          action: 'start',
          regions: ['lviv'],
          date: '2026-10-17',
          schedule: gpvSchedule({
            '1.1': '20:00-22:00',
            '1.2': '11:00-14:00',
            '2.1': '17:00-20:00',
            '2.2': '11:00-14:00',
            '3.1': '16:00-19:00',
            '3.2': '14:00-18:00',
            '4.1': '18:00-22:00',
            '4.2': '10:00-12:00',
            '5.1': '12:00-16:00',
            '5.2': '14:00-17:00',
            '6.1': '14:00-18:00',
            '6.2': '',
          }),
        }),
      ],
    }
  if (t.includes('на 01.07.2026'))
    return {
      statedAt: '19:05',
      events: [
        ev({
          kind: 'gpv',
          action: 'start',
          regions: ['lviv'],
          date: '2026-07-01',
          schedule: gpvSchedule({
            '1.1': '17:00-19:30',
            '1.2': '19:30-22:00',
            '5.1': '19:30-22:00',
            '5.2': '17:00-19:30',
          }),
        }),
      ],
    }
  // "про відміну застосування ГПВ на 20.11.2024 до окремого розпорядження"
  if (t.includes('відміну застосування ГПВ'))
    return {
      statedAt: '18:32',
      events: [
        ev({
          kind: 'gpv',
          action: 'cancel',
          regions: ['lviv'],
          date: '2024-11-20',
          untilFurtherNotice: true,
        }),
      ],
    }
  return undefined
}

function client(
  menus: string | (() => string) = fixture('lviv/menus.today-2026-10-17.hydra.json'),
  opts: { now?: Date; textProcessor?: TextProcessor | null; imageProcessor?: ImageProcessor } = {},
) {
  const { fetch, calls } = mockFetch([
    { match: MENUS, body: menus },
    { match: 'https://api.loe.lviv.ua/media/', body: fixtureBytes('image/sample-420.png') },
    { match: `${API}/pw_cities?pagination=false`, body: fixture('lviv/pw_cities.json') },
    {
      match: `${API}/pw_streets?pagination=false&city.id=693`,
      body: fixture('lviv/pw_streets.city-693.json'),
    },
    {
      match: /pw_accounts\?.*street\.id=12564&buildingName=171$/,
      body: fixture('lviv/pw_accounts.street-12564.building-171.json'),
    },
    {
      match: /pw_accounts\?.*street\.id=12564&buildingName=/,
      body: fixture('lviv/pw_accounts.no-match.json'),
    },
    { match: /pw_accounts\?.*street\.id=12564$/, body: fixture('lviv/pw_accounts.street-12564.json') },
  ])
  const now = opts.now ?? NOW
  const text =
    opts.textProcessor === null
      ? undefined
      : ((opts.textProcessor as ReturnType<typeof fakeText> | undefined) ?? fakeText(lvivAnswer))
  return {
    client: new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [lvivProvider()],
      textProcessor: text,
      imageProcessor: opts.imageProcessor,
    }),
    calls,
    text,
  }
}

/** The real response with its "Today" slot replaced. */
function menuWithToday(today: Record<string, string>) {
  const data = JSON.parse(fixture('lviv/menus.empty.array.json'))
  const slot = data[0].menuItems.find((i: { name: string }) => i.name === 'Today')
  Object.assign(slot, today)
  return JSON.stringify(data)
}
const archived = (id: number) =>
  JSON.parse(fixture('lviv/menus.empty.array.json'))[0]
    .menuItems.find((i: { name: string }) => i.name === 'Arhiv')
    .children.find((c: { id: number }) => c.id === id)

describe('Lvivoblenergo', () => {
  it("reads LOE's template exactly, with no processor at all", async () => {
    const { client: c } = client(undefined, { textProcessor: null })
    const s = await c.getSchedules('lviv')
    expect(s.groups).toEqual([...STANDARD_GROUPS])
    expect(s.schedules['1.1']).toEqual([
      {
        date: '2026-10-17',
        status: 'scheduled',
        intervals: [{ from: '2026-10-17T20:00:00+03:00', to: '2026-10-17T22:00:00+03:00', kind: 'off' }],
      },
    ])
    expect(s.schedules['4.2']![0]!.intervals).toEqual([
      { from: '2026-10-17T10:00:00+03:00', to: '2026-10-17T12:00:00+03:00', kind: 'off' },
    ])
    // "Група 6.2. Електроенергія є."
    expect(s.schedules['6.2']).toEqual([{ date: '2026-10-17', status: 'scheduled', intervals: [] }])
    // and a processor, when there is one, isn't asked
    const { client: withAi, text } = client()
    await withAi.getSchedules('lviv')
    expect(text!.calls).toHaveLength(0)
  })

  it('a text that strays from the template is not read: its day is not known, and says why (no processor)', async () => {
    const html = archived(1095).rawHtml.replace(
      'Група 1.1. Електроенергії немає з 17:00 до 19:30.',
      'Група 1.1. Можливі відключення з 17:00 до 19:30.',
    )
    expect(html).toContain('Можливі')
    const now = new Date('2026-06-30T20:00:00+03:00')
    const { client: c, text } = client(menuWithToday({ rawHtml: html }), { now })
    const s = await c.getSchedules('lviv')
    expect(text?.calls ?? []).toHaveLength(0)
    const day = s.schedules['1.1']!.find((d) => d.date === '2026-07-01')!
    expect(day.status).toBe('unknown')
    expect(s.sources![0]!.unread).toEqual([
      { date: '2026-07-01', message: expect.stringContaining("doesn't follow its template") },
    ])
  })

  it('takes freshness from "Інформація станом на"', async () => {
    const s = await client().client.getSchedules('lviv')
    expect(s.updatedAt).toBe('2026-10-17T18:56:00+03:00')
  })

  it('dates a schedule by its text, not by the slot it sits in', async () => {
    // published 30.06 for 01.07, shown in "Today"
    const item = archived(1095)
    const s = await client(menuWithToday({ rawHtml: item.rawHtml }), {
      now: new Date('2026-06-30T20:00:00+03:00'),
    }).client.getSchedules('lviv')
    expect(s.schedules['1.1']![0]!.date).toBe('2026-07-01')
    expect(s.schedules['1.1']![0]!.intervals[0]!.from).toBe('2026-07-01T17:00:00+03:00')
  })

  it('treats empty Today/Tomorrow as nothing published, not "no outages" (array-shaped response)', async () => {
    const { client: c, text } = client(fixture('lviv/menus.empty.array.json'))
    const s = await c.getSchedules('lviv')
    expectUnpublished(s, 12)
    expect(s.updatedAt).toBeNull()
    expect(text!.calls).toHaveLength(0)
  })

  it('turns an Ukrenergo cancellation notice into a day without outages', async () => {
    const s = await client(menuWithToday({ description: archived(372).description }), {
      now: new Date('2024-11-20T19:00:00+02:00'),
    }).client.getSchedules('lviv')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['3.1']).toEqual([{ date: '2024-11-20', status: 'no-outages', intervals: [] }])
    expect(s.updatedAt).toBe('2024-11-20T18:32:00+02:00')
  })

  it('flags a schedule text that is not the template; fails loudly when the response changed shape', async () => {
    const s = await client(
      menuWithToday({ rawHtml: '<p>Графік на 17.10.2026: див. зображення</p>' }),
    ).client.getSchedules('lviv')
    expect(s.sources![0]!.unread).toHaveLength(1)
    await expect(
      client(JSON.stringify({ 'hydra:member': [{ id: 9 }] })).client.getSchedules('lviv'),
    ).rejects.toMatchObject({ code: 'parse' })
  })

  it('a slot published only as a picture (the format before 30.10.2025) is parse, with its address', async () => {
    await expect(
      client(menuWithToday({ imageUrl: '/media/x_GPV.png' }), { textProcessor: null }).client.getSchedules(
        'lviv',
      ),
    ).rejects.toMatchObject({ code: 'parse', details: { url: 'https://api.loe.lviv.ua/media/x_GPV.png' } })
  })

  it('needs no processor for the schedule or the address search', async () => {
    const c = client(undefined, { textProcessor: null }).client
    await expect(c.getSchedules('lviv')).resolves.toMatchObject({ region: 'lviv' })
    const m = await c.findGroup('lviv', { city: 'Львів', street: 'вул. Городоцька', house: '171' })
    expect(m.group).toBe('5.1')
  })

  it('finds the group with an exact building request', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('lviv', { city: 'Львів', street: 'вул. Городоцька', house: '171' })
    expect(m).toEqual({
      region: 'lviv',
      group: '5.1',
      address: { city: 'Львів', street: 'Городоцька', house: '171' },
      // chergGav "Не входить", chergSgav "3"
      emergency: { sgav: ['3'] },
    })
    // the 2 MB whole-street list isn't needed
    expect(calls.some((x) => x.url.endsWith('street.id=12564'))).toBe(false)
    expect((await c.searchCities('lviv', 'Львів'))[0]).toEqual({
      id: '693',
      name: 'Львів',
      district: 'Львівська громада',
      score: 1,
    })
  })

  it('returns every group of a building, the most common first', async () => {
    const m = await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '115' })
    expect(m.group).toBe('2.1')
    // accounts of one building in ГАВ 6 and 20; АЧР without its frequency ("10 (48.2Гц)")
    expect(m.emergency).toEqual({ gav: ['6', '20'], sgav: ['3'], achr: ['10'] })
    expect(m.otherGroups).toEqual(['5.1'])
  })

  it('falls back to the whole street when the number is spelled differently', async () => {
    const m = await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '206а' })
    expect(m.address.house).toBe('206-А')
    expect(m.group).toBe('2.1')
  })

  it('skips accounts that are not in the schedule', async () => {
    // 20 accounts "Не входить", 2 in group 2.1
    expect(
      (await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '16' })).group,
    ).toBe('2.1')
    await expect(
      client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '219' }),
    ).rejects.toThrow(/not included/)
  })

  describe('CDN cache', () => {
    it('asks with a cache-busting parameter, so Cloudflare cannot answer from its two-hour copy', async () => {
      const { client: c, calls } = client()
      await c.getSchedules('lviv')
      expect(calls.map((x) => x.url)).toEqual([`${MENUS}&_=${Math.floor(NOW.getTime() / 1000)}`])
    })

    it('asks once more under another key when an old copy comes back anyway', async () => {
      const urls: string[] = []
      const fetch: FetchLike = async (url) => {
        urls.push(url)
        // the first answer is 764 s old (the value seen live without the parameter)
        return new Response(fixture('lviv/menus.today-2026-10-17.hydra.json'), {
          headers:
            urls.length === 1 ? { age: '764', 'cf-cache-status': 'HIT' } : { 'cf-cache-status': 'MISS' },
        })
      }
      const c = new OutageClient({
        fetch,
        now: () => NOW,
        cacheTtlMs: 0,
        providers: [lvivProvider()],
        textProcessor: fakeText(lvivAnswer),
      })
      const s = await c.getSchedules('lviv')
      expect(urls).toHaveLength(2)
      expect(urls[1]).not.toBe(urls[0])
      expect(urls[1]).toMatch(/&_=\d+r$/)
      expect(s.schedules['1.1']![0]!.date).toBe('2026-10-17')
    })

    it('does not ask twice for a young copy', async () => {
      const { fetch, calls } = mockFetch([
        { match: MENUS, body: fixture('lviv/menus.today-2026-10-17.hydra.json'), headers: { age: '11' } },
      ])
      const c = new OutageClient({
        fetch,
        now: () => NOW,
        cacheTtlMs: 0,
        providers: [lvivProvider()],
        textProcessor: fakeText(lvivAnswer),
      })
      await c.getSchedules('lviv')
      expect(calls).toHaveLength(1)
    })
  })

  it('never dates an old "Today" slot today: the day comes from the text', async () => {
    // the 17.10 response read a day later (a CDN copy, a slot nobody cleared)
    const later = new Date('2026-10-18T09:00:00+03:00')
    const s = await client(undefined, { now: later }).client.getSchedules('lviv')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-10-17'])
    expect(assessFreshness(s, { now: later })).toMatchObject({ state: 'stale', today: 'missing' })
    // a month later it is still the 17th's
    const month = await client(undefined, { now: new Date('2026-11-17T09:00:00+02:00') }).client.getSchedules(
      'lviv',
    )
    expect(month.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-10-17'])
  })
})

describe('lvivTemplate: only the template', () => {
  it('a cancellation with more after it, or a day that does not exist, is not the template', () => {
    const notice =
      'Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на 18.11.2026 до окремого розпорядження НЕК «Укренерго».'
    expect(lvivTemplate(notice)).toMatchObject({ cancelled: true, date: '2026-11-18' })
    expect(lvivTemplate(`${notice} Оновлення: з 15:00 ГПВ знову діють.`)).toBeNull()
    expect(lvivTemplate(notice.replace('18.11.2026', '31.02.2026'))).toBeNull()
    expect(lvivTemplate(`${notice}\nІнформація станом на 18:56 99.99.2026`)).toBeNull()
  })
})
