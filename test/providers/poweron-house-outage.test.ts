import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { lvivProvider } from '../../src/providers/lviv.js'
import {
  accidentHouses,
  accidentOutage,
  currentAccident,
  type PowerOnAccident,
} from '../../src/providers/poweron.js'
import { ternopilProvider } from '../../src/providers/ternopil.js'
import { zakarpattiaProvider } from '../../src/providers/zakarpattia.js'
import { zhytomyrProvider } from '../../src/providers/zhytomyr.js'
import { fixture, mockFetch, type Route } from '../helpers.js'

/** The lists as the operators' APIs gave them on 17.11.2026 ~23:20 Kyiv (`koment` names removed) */
const rows = (path: string): PowerOnAccident[] => JSON.parse(fixture(path))['hydra:member']
const hydra = (member: unknown[]) =>
  JSON.stringify({ 'hydra:member': member, 'hydra:totalItems': member.length })

const AT = new Date('2026-11-17T23:20:00+02:00')

describe('pw_accidents rows, labelled as the site labels them', () => {
  it('switchSubReason says which schedule; else typeOff says what kind', () => {
    const at = (r: Partial<PowerOnAccident>) => accidentOutage({ typeOff: 1, switchSubReason: 0, ...r })
    expect(at({ switchSubReason: 1 })).toMatchObject({
      kind: 'emergency',
      reason: 'Графік аварійних відключень',
      scheduleApplies: false,
    })
    expect(at({ switchSubReason: 3 })).toMatchObject({
      kind: 'emergency',
      reason: 'Спеціальний графік аварійних відключень',
    })
    expect(at({ switchSubReason: 2 })).toMatchObject({ kind: 'scheduled', scheduleApplies: true })
    expect(at({})).toMatchObject({ kind: 'repair', reason: 'Аварійне відключення', scheduleApplies: null })
    expect(at({ typeOff: 0 })).toMatchObject({ kind: 'planned', reason: 'Планове відключення' })
    expect(at({ typeOff: 2 })).toMatchObject({ kind: 'other', reason: 'Оперативні перемикання' })
    // a value the site has no label for is not guessed at
    expect(at({ switchSubReason: 7 })).toMatchObject({ kind: 'other', reason: 'switchSubReason 7' })
    expect(at({ typeOff: 9 })).toMatchObject({ kind: 'other', reason: 'typeOff 9' })
  })

  it('times: Kyiv wall clock labelled +00:00, or a real offset (Lviv)', () => {
    const [zt] = rows('zhytomyr/pw_accidents.city-333.street-4757.json')
    expect(accidentOutage(zt!)).toMatchObject({
      from: '2026-11-17T19:30:00+02:00',
      to: '2026-11-17T22:00:00+02:00',
    })
    const [lv] = rows('lviv/pw_accidents.city-693.street-13955.json')
    expect(accidentOutage(lv!, true)).toMatchObject({
      from: '2026-11-17T22:44:31+02:00',
      to: '2026-11-18T00:00:00+02:00',
    })
  })

  it('house numbers of a row, without blanks and "б/н"', () => {
    expect(accidentHouses({ buildingNames: '166, 234-А, 236, 239' })).toEqual(['166', '234-А', '236', '239'])
    expect(accidentHouses({ buildingNames: ', 3, б/н' })).toEqual(['3'])
    expect(accidentHouses({ buildingNames: null })).toEqual([])
  })

  it('only a row that has started and has not long passed its planned end is current', () => {
    const zk = rows('zakarpattia/pw_accidents.city-285.street-1912.json')
    // 22: a row from July 2026 still in the list
    expect(currentAccident(zk, '22', AT)).toBeNull()
    expect(currentAccident(zk, '33', AT)?.outage).toMatchObject({ kind: 'repair' })
    const gpv = rows('zhytomyr/pw_accidents.city-333.street-4757.json')
    // the slot ended at 22:00; the list kept it past 23:15
    expect(currentAccident(gpv, '18', new Date('2026-11-17T21:50:00+02:00'))?.outage.kind).toBe('scheduled')
    expect(currentAccident(gpv, '18', new Date('2026-11-17T22:20:00+02:00'))?.outage.kind).toBe('scheduled')
    expect(currentAccident(gpv, '18', new Date('2026-11-17T22:30:00+02:00'))).toBeNull()
    expect(currentAccident(gpv, '18', new Date('2026-11-17T19:00:00+02:00'))).toBeNull()
    // "234-А" in the list is "234а" typed; "234" is another house
    const zt = rows('zhytomyr/pw_accidents.city-333.street-4789.json')
    expect(currentAccident(zt, '234а', AT)?.outage.kind).toBe('repair')
    expect(currentAccident(zt, '234', AT)).toBeNull()
  })

  it('a house in several rows: the one that is not the schedule wins', () => {
    const base = { buildingNames: '5', dateEvent: '2026-11-17T20:00:00+00:00' }
    const hit = currentAccident(
      [
        { ...base, typeOff: 1, switchSubReason: 2, datePlanIn: '2026-11-17T23:30:00+00:00' },
        { ...base, typeOff: 1, switchSubReason: 0, datePlanIn: '2026-11-18T02:00:00+00:00' },
      ],
      '5',
      AT,
    )
    expect(hit?.outage).toMatchObject({ kind: 'repair', to: '2026-11-18T02:00:00+02:00' })
  })
})

describe('getHouseOutage on PowerOn regions', () => {
  afterEach(() => vi.useRealTimers())

  it('Lviv: the street of the address lookup, groups from its building list', async () => {
    const API = 'https://power-api.loe.lviv.ua/api'
    const { fetch, calls } = mockFetch([
      { match: `${API}/pw_cities?pagination=false`, body: fixture('lviv/pw_cities.json') },
      {
        match: `${API}/pw_streets?pagination=false&city.id=693`,
        body: hydra([{ id: 13955, name: 'Патона Є.' }]),
      },
      {
        match: /pw_accounts\?.*street\.id=13955&buildingName=12$/,
        body: hydra([
          { buildingName: '12', chergGpv: '2.1' },
          { buildingName: '12', chergGpv: '4.2' },
        ]),
      },
      {
        match: /pw_accidents\?page=1&otg\.id=&city\.id=693&street\.id=13955&_=\d+$/,
        body: fixture('lviv/pw_accidents.city-693.street-13955.json'),
      },
    ])
    const client = new OutageClient({ fetch, now: () => AT, cacheTtlMs: 0, providers: [lvivProvider()] })
    expect(client.region('lviv').capabilities.houseOutage).toBe(true)
    const address = { city: 'Львів', street: 'Патона Є.', house: '12' }
    expect(await client.getHouseOutage('lviv', address)).toEqual({
      region: 'lviv',
      address: { city: 'Львів', street: 'Патона Є.', house: '12' },
      kind: 'repair',
      reason: 'Аварійне відключення',
      scheduleApplies: null,
      from: '2026-11-17T22:44:31+02:00',
      to: '2026-11-18T00:00:00+02:00',
      groups: ['2.1', '4.2'],
      updatedAt: null,
      url: 'https://poweron.loe.lviv.ua/',
      fetchedAt: '2026-11-17T23:20:00+02:00',
    })
    // one request for the street while it is fresh; `fresh` asks again
    await client.getHouseOutage('lviv', address)
    expect(calls.filter((c) => c.url.includes('pw_accidents'))).toHaveLength(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    await client.getHouseOutage('lviv', address, { fresh: true })
    expect(calls.filter((c) => c.url.includes('pw_accidents'))).toHaveLength(2)
  })

  it('Zakarpattia: a row left in the list since July is not an outage now', async () => {
    const API = 'https://api-outage-zakarpat-energy.inneti.net/api'
    const { fetch } = mockFetch([
      {
        match: `${API}/pw_cities?pagination=false`,
        body: hydra([{ id: 285, name: 'Шаян', otg: { name: 'Хустська' } }]),
      },
      {
        match: `${API}/pw_streets?pagination=false&city.id=285`,
        body: hydra([{ id: 1912, name: 'Яблунева' }]),
      },
      {
        match: /pw_address_queues\?.*street\.id=1912/,
        body: hydra([{ buildingNames: '22, 33', chergGpv: '2.1' }]),
      },
      {
        match: /pw_accidents\?page=1&otg\.id=&city\.id=285&street\.id=1912&/,
        body: fixture('zakarpattia/pw_accidents.city-285.street-1912.json'),
      },
    ])
    const client = new OutageClient({
      fetch,
      now: () => AT,
      cacheTtlMs: 0,
      providers: [zakarpattiaProvider()],
    })
    expect(
      await client.getHouseOutage('zakarpattia', { city: 'Шаян', street: 'Яблунева', house: '22' }),
    ).toBeNull()
    expect(
      await client.getHouseOutage('zakarpattia', { city: 'Шаян', street: 'Яблунева', house: '33' }),
    ).toMatchObject({
      kind: 'repair',
      from: '2026-11-09T16:54:00+02:00',
      to: '2026-12-09T17:00:00+02:00',
      groups: ['2.1'],
      url: 'https://outage.zakarpat.energy/',
    })
  })

  describe('Zhytomyr: the PowerOn copy, with its own address chain', () => {
    const API = 'https://api-ztoe-poweron.inneti.net/api'
    const routes: Route[] = [
      {
        match: /pw_cities\?pagination=false&name=/,
        body: hydra([
          { id: 333, name: 'Житомир', otg: { name: 'Житомирський РЕМ' } },
          { id: 9999, name: 'Невідомо', otg: { name: 'Житомирський РЕМ' } },
        ]),
      },
      {
        match: `${API}/pw_streets?pagination=false&city.id=333`,
        body: hydra([
          { id: 4789, name: 'вул. Покровська' },
          { id: 4757, name: 'вул. Київська' },
        ]),
      },
      {
        match: /pw_accidents\?.*street\.id=4789&/,
        body: fixture('zhytomyr/pw_accidents.city-333.street-4789.json'),
      },
      {
        match: /pw_accidents\?.*street\.id=4757&/,
        body: fixture('zhytomyr/pw_accidents.city-333.street-4757.json'),
      },
    ]
    const client = (now: Date) => {
      const { fetch, calls } = mockFetch(routes)
      return {
        client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [zhytomyrProvider()] }),
        calls,
      }
    }

    it('a house off since the drone strike of 11.11', async () => {
      const { client: c, calls } = client(AT)
      expect(c.region('zhytomyr').capabilities.houseOutage).toBe(true)
      expect(
        await c.getHouseOutage('zhytomyr', { city: 'Житомир', street: 'Покровська', house: '234а' }),
      ).toEqual({
        region: 'zhytomyr',
        address: { city: 'Житомир', street: 'вул. Покровська', house: '234а' },
        kind: 'repair',
        reason: 'Аварійне відключення',
        scheduleApplies: null,
        from: '2026-11-11T19:00:00+02:00',
        to: '2026-11-20T17:00:00+02:00',
        groups: [],
        updatedAt: null,
        url: 'https://ztoe-poweron.inneti.net/',
        fetchedAt: '2026-11-17T23:20:00+02:00',
      })
      // nothing of the PHP site is asked: only the PowerOn copy has the outages
      expect(calls.every((x) => x.url.startsWith(API))).toBe(true)
    })

    it("a ГПВ slot names its group; once it's over the house is not off", async () => {
      const during = client(new Date('2026-11-17T21:10:00+02:00')).client
      expect(
        await during.getHouseOutage('zhytomyr', { city: 'Житомир', street: 'Київська', house: '18' }),
      ).toMatchObject({ kind: 'scheduled', scheduleApplies: true, groups: ['3.1'] })
      const after = client(AT).client
      expect(
        await after.getHouseOutage('zhytomyr', { city: 'Житомир', street: 'Київська', house: '18' }),
      ).toBeNull()
    })

    it('a settlement is needed: the whole directory is not downloaded', async () => {
      const { client: c, calls } = client(AT)
      await expect(c.getHouseOutage('zhytomyr', { street: 'Київська', house: '18' })).rejects.toMatchObject({
        code: 'not-found',
      })
      expect(calls).toHaveLength(0)
    })
  })

  it('Ternopil has the list; Volyn has none to read', async () => {
    const API = 'https://api-poweron.toe.com.ua/api'
    const { fetch } = mockFetch([
      { match: `${API}/pw_cities?pagination=false`, body: fixture('ternopil/pw_cities.json') },
      {
        match: `${API}/pw_streets?pagination=false&city.id=1032`,
        body: fixture('ternopil/pw_streets.city-1032.json'),
      },
      {
        match: /building-names\?cityId=1032&streetId=10035/,
        body: fixture('ternopil/building-names.city-1032.street-10035.json'),
      },
      {
        match: /building-groups/,
        body: fixture('ternopil/building-groups.city-1032.street-10035.building-1.json'),
      },
      { match: /pw_accidents\?.*street\.id=10035&/, body: fixture('ternopil/pw_accidents.empty.json') },
    ])
    const client = new OutageClient({ fetch, now: () => AT, cacheTtlMs: 0, providers: [ternopilProvider()] })
    const streets = JSON.parse(fixture('ternopil/pw_streets.city-1032.json'))['hydra:member']
    const street = streets.find((s: { id: number }) => s.id === 10035).name
    expect(await client.getHouseOutage('ternopil', { city: 'Тернопіль', street, house: '1' })).toBeNull()
    expect(new OutageClient().region('volyn').capabilities.houseOutage).toBe(false)
  })
})
