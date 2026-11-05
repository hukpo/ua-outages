import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { lvivProvider, parseLvivMenu } from '../../src/providers/lviv.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-10-17T19:30:00+03:00')
const MENUS = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'
const API = 'https://power-api.loe.lviv.ua/api'

function client(menus = 'lviv/menus.today-2026-10-17.hydra.json') {
  const { fetch, calls } = mockFetch([
    { match: MENUS, body: fixture(menus) },
    { match: `${API}/pw_cities?pagination=false`, body: fixture('lviv/pw_cities.json') },
    { match: `${API}/pw_streets?pagination=false&city.id=693`, body: fixture('lviv/pw_streets.city-693.json') },
    { match: /pw_accounts\?.*street\.id=12564&buildingName=171$/, body: fixture('lviv/pw_accounts.street-12564.building-171.json') },
    { match: /pw_accounts\?.*street\.id=12564&buildingName=/, body: fixture('lviv/pw_accounts.no-match.json') },
    { match: /pw_accounts\?.*street\.id=12564$/, body: fixture('lviv/pw_accounts.street-12564.json') },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [lvivProvider()] }), calls }
}

/** The real response with its "Today" slot replaced. */
function menuWithToday(today: Record<string, string>) {
  const data = JSON.parse(fixture('lviv/menus.empty.array.json'))
  const slot = data[0].menuItems.find((i: { name: string }) => i.name === 'Today')
  Object.assign(slot, today)
  return data
}
const archived = (id: number) =>
  JSON.parse(fixture('lviv/menus.empty.array.json'))[0]
    .menuItems.find((i: { name: string }) => i.name === 'Arhiv')
    .children.find((c: { id: number }) => c.id === id)

describe('Lvivoblenergo', () => {
  it('reads the prose schedule into exact intervals', async () => {
    const s = await client().client.getSchedules('lviv')
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
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
  })

  it('takes freshness from "Інформація станом на"', async () => {
    const s = await client().client.getSchedules('lviv')
    expect(s.updatedAt).toBe('2026-10-17T18:56:00+03:00')
  })

  it('dates a schedule by its text, not by the slot it sits in', () => {
    // published 30.06 for 01.07, shown in "Today"
    const item = archived(1095)
    const s = parseLvivMenu(menuWithToday({ rawHtml: item.rawHtml }), NOW)
    expect(s.schedules['1.1']![0]!.date).toBe('2026-07-01')
    expect(s.schedules['1.1']![0]!.intervals[0]!.from).toBe('2026-07-01T17:00:00+03:00')
  })

  it('treats empty Today/Tomorrow as no schedule (array-shaped response)', async () => {
    const s = await client('lviv/menus.empty.array.json').client.getSchedules('lviv')
    expect(s.groups).toEqual([])
    expect(s.updatedAt).toBeNull()
  })

  it('turns an Ukrenergo cancellation notice into a day without outages', () => {
    const s = parseLvivMenu(menuWithToday({ description: archived(372).description }), NOW)
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['3.1']).toEqual([{ date: '2024-11-20', status: 'no-outages', intervals: [] }])
    expect(s.updatedAt).toBe('2024-11-20T18:32:00+02:00')
  })

  it('fails loudly on a changed format', () => {
    expect(() => parseLvivMenu(menuWithToday({ rawHtml: '<p>Графік на 17.10.2026: див. зображення</p>' }), NOW)).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
    expect(() => parseLvivMenu(menuWithToday({ imageUrl: '/media/x_GPV.png' }), NOW)).toThrow(/only as an image/)
    expect(() => parseLvivMenu({ 'hydra:member': [{ id: 9 }] }, NOW)).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('finds the group with an exact building request', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('lviv', { city: 'Львів', street: 'вул. Городоцька', house: '171' })
    expect(m).toEqual({ region: 'lviv', group: '5.1', address: { city: 'Львів', street: 'Городоцька', house: '171' } })
    // the 2 MB whole-street list isn't needed
    expect(calls.some((x) => x.url.endsWith('street.id=12564'))).toBe(false)
    expect((await c.searchCities('lviv', 'Львів'))[0]).toEqual({ id: '693', name: 'Львів', district: 'Львівська громада' })
  })

  it('returns every group of a building, the most common first', async () => {
    const m = await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '115' })
    expect(m.group).toBe('2.1')
    expect(m.otherGroups).toEqual(['5.1'])
  })

  it('falls back to the whole street when the number is spelled differently', async () => {
    const m = await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '206а' })
    expect(m.address.house).toBe('206-А')
    expect(m.group).toBe('2.1')
  })

  it('skips accounts that are not in the schedule', async () => {
    // 20 accounts "Не входить", 2 in group 2.1
    expect((await client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '16' })).group).toBe('2.1')
    await expect(client().client.findGroup('lviv', { city: 'Львів', street: 'Городоцька', house: '219' })).rejects.toThrow(
      /not included/,
    )
  })
})
