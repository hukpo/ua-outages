import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { cherkasyProvider } from '../../src/providers/cherkasy.js'
import {
  cherkasyHouseKey,
  dropStrays,
  parseQueueInfo,
  spread,
} from '../../src/providers/cherkasy-addresses.js'
import type { FetchLike } from '../../src/http.js'
import { fixture } from '../helpers.js'

const NOW = new Date('2026-11-17T00:27:00+02:00')
const f = (name: string) => fixture(`cherkasy/disconn-${name}.json`)
const SAMPLE = { city: 'Черкаси', street: 'б-р. Шевченка', house: '100' }

/** The cabinet API, answered by `op`; `over` replaces single operations. Records every call. */
function cabinet(over: Record<string, (q: URLSearchParams) => string | Response> = {}) {
  const calls: URLSearchParams[] = []
  const fetch: FetchLike = async (url) => {
    const u = new URL(url)
    if (u.host !== 'cabinet.cherkasyoblenergo.com') throw new Error(`unexpected request ${url}`)
    const q = u.searchParams
    calls.push(q)
    const op = q.get('op')!
    const custom = over[op]?.(q)
    if (custom instanceof Response) return custom
    const body =
      custom ??
      {
        department_list: () => f('department_list'),
        // the fixture is branch 1; the other branches are left empty here
        city_list: () => (q.get('dept_id') === '1' ? f('city_list-dept1') : '[]'),
        street_list: () => f('street_list-city1.trimmed'),
        house_list: () => f('house_list-street16896'),
        ls_list_by_addr: () => f('ls_list_by_addr-street16896-house100.REDACTED'),
        disconn_by_ls: () => f('disconn_by_ls-selector2-schedules'),
      }[op]!()
    return new Response(body, { headers: { 'Content-Type': 'application/x-javascript; charset=utf-8;' } })
  }
  const client = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [cherkasyProvider()] })
  return { client, calls }
}

const queues = (gpv: string, gav = 'в чергу не включено') =>
  JSON.stringify({
    DATETIME: '00:27 17.11.2026',
    DISCONN_QUEUQ: [
      { QUEUE_INFO: `Графік аварійних відключень - ${gav}` },
      { QUEUE_INFO: `Графік погодинних відключень - ${gpv}` },
    ],
    DISCONNECTIONS: [],
  })

/** Made-up account numbers, as many as the building on вул. Хрещатик, 200 has */
const accounts = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      LS: `TEST${String(i).padStart(4, '0')}`,
      NAME: 'Побутовий споживач',
      ADDRESS: 'м. Черкаси, вул. Хрещатик, 200',
    })),
  )

describe('Cherkasy address lookup', () => {
  it('walks branch → settlement → street → house → accounts → queue', async () => {
    const { client, calls } = cabinet()
    const m = await client.findGroup('cherkasy', SAMPLE)
    expect(m).toEqual({
      region: 'cherkasy',
      group: '4.1',
      address: { city: 'м. Черкаси', street: 'б-р. Шевченка', house: '100' },
    })
    const ops = calls.map((q) => q.get('op'))
    // every branch once (22 in this capture), then the chain; both accounts of the house are asked
    expect(ops.filter((o) => o === 'city_list')).toHaveLength(22)
    expect(ops.slice(-5)).toEqual([
      'street_list',
      'house_list',
      'ls_list_by_addr',
      'disconn_by_ls',
      'disconn_by_ls',
    ])
    expect(Object.fromEntries(calls.at(-1)!)).toMatchObject({
      disconn_selector: '2',
      n_date: '17.11.2026',
      k_date: '17.11.2026',
    })
    expect(Object.fromEntries(calls.at(-3)!)).toEqual({
      op: 'ls_list_by_addr',
      street_id: '16896',
      house: '100',
    })
    // nothing of an account number comes back
    expect(JSON.stringify(m)).not.toMatch(/7101|LS/)
  })

  it('loads the settlements once and drops unfiled streets', async () => {
    const { client, calls } = cabinet()
    const cities = await client.searchCities('cherkasy', 'Черкаси')
    expect(cities[0]).toMatchObject({ id: '1', name: 'м. Черкаси', district: 'Черкаські' })
    const streets = await client.searchStreets('cherkasy', 'невизначена', { city: cities[0]! })
    expect(streets.some((s) => s.name.startsWith('*'))).toBe(false)
    await client.findGroup('cherkasy', SAMPLE)
    expect(calls.filter((q) => q.get('op') === 'department_list')).toHaveLength(1)
  })

  it('never takes "2/3" for "23": a number that differs by a separator is another house', async () => {
    // б-р. Шевченка really has 2/3 and 23, 4/1 and 41, 11/1 and 111, and the fraction is listed first
    const { client, calls } = cabinet()
    const asked = async (house: string) => {
      calls.length = 0
      const m = await client.findGroup('cherkasy', { ...SAMPLE, house })
      return [
        m.address.house,
        calls.filter((q) => q.get('op') === 'ls_list_by_addr').map((q) => q.get('house')),
      ]
    }
    expect(await asked('23')).toEqual(['23', ['23']])
    expect(await asked('2/3')).toEqual(['2/3', ['2/3']])
    expect(await asked('41')).toEqual(['41', ['41']])
    expect(await asked('111')).toEqual(['111', ['111']])
    expect(await asked('15а')).toEqual(['15-А', ['15-А']])
    // 44/1 is listed, 441 is not
    await expect(client.findGroup('cherkasy', { ...SAMPLE, house: '441' })).rejects.toMatchObject({
      code: 'not-found',
    })
    expect(cherkasyHouseKey('2/3')).not.toBe(cherkasyHouseKey('23'))
    expect(cherkasyHouseKey('218-220')).toBe(cherkasyHouseKey('218/220'))
    expect(cherkasyHouseKey('412- А')).toBe(cherkasyHouseKey('412a'))
  })

  it('asks the accounts of every spelling the operator files one building under', async () => {
    const { client, calls } = cabinet({
      ls_list_by_addr: (q) =>
        JSON.stringify([{ LS: `TEST${q.get('house')}`, NAME: 'Побутовий споживач', ADDRESS: '' }]),
      // the entry "412 А" is on another input
      disconn_by_ls: (q) =>
        queues(q.get('abon_ls') === 'TEST412 А' ? '5 черга 1 підчерга' : '1 черга 1 підчерга'),
    })
    const m = await client.findGroup('cherkasy', { ...SAMPLE, house: '412а' })
    expect(calls.filter((q) => q.get('op') === 'ls_list_by_addr').map((q) => q.get('house'))).toEqual([
      '412- А',
      '412-А',
      '412 А',
    ])
    expect(m).toMatchObject({ group: '1.1', otherGroups: ['5.1'], address: { house: '412- А' } })
    // the spellings travel in the id, each offered once
    const [city] = await client.searchCities('cherkasy', 'Черкаси')
    const [street] = await client.searchStreets('cherkasy', 'Шевченка', { city })
    const houses = await client.searchHouses('cherkasy', street!)
    expect(houses.filter((h) => /^412\s*-?\s*А$/.test(h.number))).toHaveLength(1)
    expect(JSON.stringify(m)).not.toContain('TEST')
  })

  it('samples eight accounts across a big building and reports both of its groups', async () => {
    const { client, calls } = cabinet({
      ls_list_by_addr: () => accounts(199),
      // one input feeds the first 60 accounts, another the rest
      disconn_by_ls: (q) =>
        Number(q.get('abon_ls')!.slice(4)) < 60
          ? queues('1 черга 1 підчерга', '9 черга')
          : queues('5 черга 1 підчерга'),
    })
    const m = await client.findGroup('cherkasy', { city: 'Черкаси', street: 'Хрещатик', house: '100' })
    const asked = calls.filter((q) => q.get('op') === 'disconn_by_ls').map((q) => q.get('abon_ls'))
    expect(asked).toEqual([0, 28, 57, 85, 113, 141, 170, 198].map((i) => `TEST${String(i).padStart(4, '0')}`))
    // five of the eight are 5.1
    expect(m).toMatchObject({ group: '5.1', otherGroups: ['1.1'], emergency: { gav: ['9'] } })
    expect(JSON.stringify(m)).not.toContain('TEST')
  })

  it('says so when a house has no household accounts', async () => {
    const { client } = cabinet({ ls_list_by_addr: () => '[]' })
    await expect(client.findGroup('cherkasy', SAMPLE)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('no household accounts'),
    })
  })

  it('says so when no account is in an hourly queue', async () => {
    const { client } = cabinet({ disconn_by_ls: () => queues('в чергу не включено') })
    await expect(client.findGroup('cherkasy', SAMPLE)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('no hourly-outage queue'),
    })
  })

  it('keeps the account number out of an error', async () => {
    for (const answer of [
      () => new Response('down', { status: 502 }),
      () => '<html>not json</html>',
      () => '{"DATETIME":"00:27 17.11.2026"}',
    ]) {
      const { client } = cabinet({ ls_list_by_addr: () => accounts(3), disconn_by_ls: answer })
      const err = await client.findGroup('cherkasy', SAMPLE).catch((e) => e)
      expect(err).toMatchObject({ name: 'OutageError' })
      expect(err.details.url).toBeUndefined()
      expect(err.cause).toBeUndefined()
      expect(`${err.message} ${err.stack} ${JSON.stringify(err.details)}`).not.toMatch(/TEST\d|abon_ls/)
    }
  })

  it('rejects a changed API', async () => {
    const { client } = cabinet({ department_list: () => '"error"' })
    await expect(client.findGroup('cherkasy', SAMPLE)).rejects.toMatchObject({ code: 'parse' })
  })

  it('reads the queue lines', () => {
    expect(
      parseQueueInfo([
        'Графік аварійних відключень - в чергу не включено',
        'Графік погодинних відключень - 4 черга 1 підчерга',
      ]),
    ).toEqual({ group: '4.1', gav: null })
    expect(
      parseQueueInfo([
        'Графік аварійних відключень - 9 черга',
        'Графік погодинних відключень - 1 черга 2 підчерга',
      ]),
    ).toEqual({ group: '1.2', gav: '9' })
    expect(parseQueueInfo(['Графік погодинних відключень - в чергу не включено'])).toEqual({
      group: null,
      gav: null,
    })
  })

  it('keeps a town once: its own entry, not the copies in other branches', () => {
    // live: "м. Черкаси" is id 1 (first of branch 1) and again 32 under Уманські, 140 under Городищенська
    const cities = dropStrays([
      { id: '1', name: 'м. Черкаси', district: 'Черкаські', seat: true },
      { id: '3', name: 'с. Свидівок', district: 'Черкаські', seat: false },
      { id: '54', name: 'м. Умань', district: 'Уманські', seat: true },
      { id: '32', name: 'м. Черкаси', district: 'Уманські', seat: false },
      { id: '10', name: 'с. Краснопілка', district: 'Уманські', seat: false },
      { id: '900', name: 'с. Краснопілка', district: 'Городищенська', seat: false },
    ])
    expect(cities.map((c) => c.id)).toEqual(['1', '3', '54', '10', '900'])
    expect(cities[0]).toEqual({ id: '1', name: 'м. Черкаси', district: 'Черкаські' })
  })

  it('spreads the sample over the list', () => {
    expect(spread(2, 8)).toEqual([0, 1])
    expect(spread(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(spread(199, 8)).toEqual([0, 28, 57, 85, 113, 141, 170, 198])
    expect(spread(0, 8)).toEqual([])
  })
})
