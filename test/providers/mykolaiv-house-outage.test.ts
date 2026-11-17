import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../../src/client.js'
import type { MkOutageRow } from '../../src/emergency/sources.js'
import { currentFeedRow, feedOutage } from '../../src/providers/mykolaiv.js'
import { fixture, mockFetch } from '../helpers.js'

const API = 'https://off.energy.mk.ua/api'
const FEED = 'https://www.energy.mk.ua/outage/api/v1/outage'
/** вул. Соборна 1 (iddom 121142), the feed's rows of it from 03.11 to 17.11.2026 */
const HOUSE_FEED = fixture('mykolaiv/outage-feed.house-121142.2026-11-03_17.json')
const feedRows = (path: string): MkOutageRow[] => JSON.parse(fixture(path)).data

function client(now: Date) {
  const { fetch, calls } = mockFetch([
    { match: `${API}/addr/filii/15/ns`, body: fixture('mykolaiv/addr-filii-15-ns.json') },
    { match: /\/addr\/filii\/\d+\/ns$/, body: '[]' },
    { match: `${API}/addr/filii`, body: fixture('mykolaiv/addr-filii.json') },
    { match: `${API}/addr/ns/171/street`, body: fixture('mykolaiv/addr-ns-171-street.json') },
    { match: `${API}/addr/street/3057/dom`, body: fixture('mykolaiv/addr-street-3057-dom.json') },
    {
      match: `${API}/addr/dom/121142/outage-queue`,
      body: fixture('mykolaiv/addr-dom-121142-outage-queue.json'),
    },
    { match: FEED, method: 'POST', body: HOUSE_FEED },
  ])
  return { client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0 }), calls }
}

const ADDRESS = { city: 'Миколаїв', street: 'вул. Соборна', house: '1' }

describe('Mykolaiv outage feed rows as house outages', () => {
  it('ГАВ rows of 03.11 are emergencies; mislabelled ones are not', () => {
    const rows = feedRows('mykolaiv/outage-feed-gav-2026-11-03.json')
    expect(feedOutage(rows[0]!)).toEqual({
      kind: 'emergency',
      reason: 'Графік аварійних відключень | ГАВ черга 1',
      scheduleApplies: false,
      from: '2026-11-03T02:30:00+02:00',
      to: '2026-11-03T04:50:00+02:00',
    })
    const row = (reason: string, type = 'GAO') => feedOutage({ type, reason }).kind
    expect(row('Графік аварійних відключень | ГПВ ч 5,2')).toBe('other')
    expect(row('Графік аварійних відключень | ГАВ Кіровоград Обленерго')).toBe('other')
    expect(row('Графік аварійних відключень', 'AVARIYA')).toBe('other')
  })

  it('the other categories seen in the feed', () => {
    const row = (reason: string, type: string) => feedOutage({ type, reason })
    expect(row('Графік погодинних відключень |  ГПВ 2.2 черга\n', 'GAO')).toMatchObject({
      kind: 'scheduled',
      reason: 'Графік погодинних відключень | ГПВ 2.2 черга',
      scheduleApplies: true,
    })
    expect(row('Пошкодження повітряної лінії', 'AVARIYA')).toMatchObject({
      kind: 'repair',
      scheduleApplies: null,
    })
    expect(row('Пошкодження на підстанції 35,150кВ', 'GAO').kind).toBe('repair')
    expect(row('', 'AVARIYA')).toMatchObject({ kind: 'repair', reason: 'Аварійне відключення' })
    expect(row('Оперативні перемикання', 'AVARIYA').kind).toBe('other')
    expect(row('Поточний ремонт', 'PLAN').kind).toBe('planned')
    expect(row('', 'PLAN')).toMatchObject({ kind: 'planned', reason: 'Планове відключення' })
  })

  it('only a row that has started and not finished is current', () => {
    const rows = feedRows('mykolaiv/outage-feed.house-121142.2026-11-03_17.json')
    // ГПВ 2.2, 15.11 20:30–00:00 Kyiv
    expect(currentFeedRow(rows, new Date('2026-11-15T21:00:00+02:00'))?.id).toBe(366326)
    expect(currentFeedRow(rows, new Date('2026-11-16T00:00:00+02:00'))).toBeNull()
    expect(currentFeedRow(rows, new Date('2026-11-17T23:20:00+02:00'))).toBeNull()
  })
})

describe('getHouseOutage in Mykolaiv', () => {
  afterEach(() => vi.useRealTimers())

  it("reads the house's own rows by its address id, with its groups", async () => {
    const { client: c, calls } = client(new Date('2026-11-14T01:30:00+02:00'))
    expect(c.region('mykolaiv').capabilities.houseOutage).toBe(true)
    expect(await c.getHouseOutage('mykolaiv', ADDRESS)).toEqual({
      region: 'mykolaiv',
      address: { city: 'м. Миколаїв', street: 'вул. Соборна', house: '1' },
      kind: 'repair',
      reason: 'Пошкодження на підстанції 35,150кВ',
      scheduleApplies: null,
      from: '2026-11-14T01:15:00+02:00',
      to: '2026-11-14T01:56:00+02:00',
      groups: ['2.2'],
      updatedAt: null,
      url: 'https://www.energy.mk.ua/',
      fetchedAt: '2026-11-14T01:30:00+02:00',
    })
    const feed = calls.filter((x) => x.url === FEED)
    expect(feed).toHaveLength(1)
    expect(JSON.parse(String(feed[0]!.init?.body))).toMatchObject({ page: 1, perPage: 100, house_id: 121142 })

    // kept for a while; `fresh` asks again
    await c.getHouseOutage('mykolaiv', ADDRESS)
    expect(calls.filter((x) => x.url === FEED)).toHaveLength(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    await c.getHouseOutage('mykolaiv', ADDRESS, { fresh: true })
    expect(calls.filter((x) => x.url === FEED)).toHaveLength(2)
  })

  it('nothing running: null, and no group lookup for it', async () => {
    const { client: c, calls } = client(new Date('2026-11-17T23:20:00+02:00'))
    expect(await c.getHouseOutage('mykolaiv', ADDRESS)).toBeNull()
    expect(calls.some((x) => x.url.includes('outage-queue'))).toBe(false)
  })
})
