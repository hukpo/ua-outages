import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import { type FetchLike, Http } from '../../src/http.js'
import { chernihivProvider } from '../../src/providers/chernihiv.js'
import {
  buildChernihivDirectory,
  CHERNIHIV_ADDRESS_PDF,
  chernihivAddresses,
  type ChernihivRow,
  houseKey,
  parseChernihivHouses,
  parseChernihivPdf,
} from '../../src/providers/chernihiv-addresses.js'
import type { Provider } from '../../src/providers/provider.js'
import { fixture, fixtureBytes, mockFetch, type Route } from '../helpers.js'

// Nine of the 186 pages of the operator's file (1, 5, 17, 28, 46, 99, 103, 116, 185: Бахмач, the
// rows of Миру and Магістратська in Chernihiv, three villages called Городище), without the
// embedded fonts
const PDF = fixtureBytes('chernihiv/address/Grafik_obmezhen.9-pages.pdf')
// Rows of the whole file for a few settlements, as `parseChernihivPdf` returns them
const ROWS = JSON.parse(fixture('chernihiv/address/rows.trimmed.json')) as ChernihivRow[]
const MODIFIED = 'Wed, 07 Jan 2026 14:39:57 GMT'

/** The region as it will be wired: the schedule provider with the address part spread in */
function provider(): Provider & ReturnType<typeof chernihivAddresses> {
  const base = chernihivProvider()
  return {
    ...base,
    info: { ...base.info, capabilities: { ...base.info.capabilities, addressSearch: true } },
    ...chernihivAddresses(base.info.id, base.info.operator),
  }
}

function setup(routes?: Route[]) {
  let now = Date.parse('2026-11-17T08:00:00+02:00')
  const { fetch, calls } = mockFetch(
    routes ?? [{ match: CHERNIHIV_ADDRESS_PDF, body: PDF, headers: { 'Last-Modified': MODIFIED } }],
  )
  const p = provider()
  const client = new OutageClient({ fetch, now: () => new Date(now), cacheTtlMs: 0, providers: [p] })
  return { client, calls, p }
}

const notFound = async (promise: Promise<unknown>, message?: RegExp) => {
  const e = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(e).toBeInstanceOf(OutageError)
  expect((e as OutageError).code).toBe('not-found')
  if (message) expect((e as OutageError).message).toMatch(message)
}

describe('Chernihiv address list: the PDF', () => {
  it('reads rows of group, district, settlement and "Street: houses"', async () => {
    const { rows, asOf } = await parseChernihivPdf(PDF)
    // the heading: "… по АТ "ЧЕРНІГІВОБЛЕНЕРГО" з 25.12.2025"
    expect(asOf).toBe('2025-12-25')
    expect(rows).toHaveLength(703)
    expect(rows[0]).toMatchObject({
      group: '1.1',
      district: 'Ічнянська дільниця',
      settlement: 'АВГУСТІВКА',
      street: 'Вокзальна',
    })
    // a cell of several printed lines is one list
    expect(rows[0]!.houses).toMatch(/^1А, 1, 3, 5, .*, 66, 67, 68$/)
    expect(rows.filter((r) => r.street === 'Магістратська')).toEqual([
      {
        group: '3.2',
        district: 'Чернігівські МЕМ',
        settlement: 'ЧЕРНІГІВ',
        street: 'Магістратська',
        houses: '1, 3, 5, 7, 9, 11',
      },
      {
        group: '3.2',
        district: 'Чернігівські МЕМ',
        settlement: 'ЧЕРНІГІВ',
        street: 'Магістратська',
        houses: '19',
      },
    ])
    for (const r of rows) {
      expect(r.group).toMatch(/^[1-6]\.[12]$/)
      expect(r.houses).toMatch(/^\d/)
    }
  })

  it('refuses a file that is not the table it knows', async () => {
    const other = fixtureBytes('rivne/address/GPV_cherga_misto_Rivne-1.trimmed.pdf')
    await expect(parseChernihivPdf(other)).rejects.toMatchObject({ code: 'parse' })
    await expect(parseChernihivPdf(new TextEncoder().encode('<html>'))).rejects.toMatchObject({
      code: 'parse',
    })
  })
})

describe('Chernihiv address list: houses', () => {
  it('splits the lists the file really has', () => {
    const numbers = (s: string) => parseChernihivHouses(s).map((h) => h.number)
    expect(numbers('2, 2А, 4А, 87\\1, 30Б/\\15, 68Б-\\1, 30Б к.30, 14\\16В')).toEqual([
      '2',
      '2А',
      '4А',
      '87/1',
      '30Б/15',
      '68Б/1',
      '30Б к.30',
      '14/16В',
    ])
    // "В" and "\22" (the tail of a number split by a comma) name no house
    expect(numbers('5, В, \\22, 7')).toEqual(['5', '7'])
    expect(numbers('')).toEqual([])
  })

  it('treats spellings of one house as one, and a fraction as another house', () => {
    expect(houseKey('2а')).toBe(houseKey('2-А'))
    expect(houseKey('29A')).toBe(houseKey('29А')) // Latin A in the file
    expect(houseKey('87\\1')).toBe(houseKey('87/1'))
    expect(houseKey('87-1')).toBe(houseKey('87/1'))
    expect(houseKey('871')).not.toBe(houseKey('87/1'))
    expect(houseKey('30Б к.30')).toBe(houseKey('30б к 30'))
  })
})

describe('Chernihiv address list: the directory', () => {
  const dir = buildChernihivDirectory(ROWS)
  const cities = [...dir.cities.values()]
  const named = (name: string) => cities.filter((c) => c.city.name === name)

  it('title-cases settlements and keeps the district', () => {
    expect(named('Чернігів').map((c) => c.city.district)).toEqual(['Чернігівські МЕМ'])
    expect(
      named('Городище')
        .map((c) => c.city.district)
        .sort(),
    ).toEqual(['Бахмацька дільниця', 'Коропська дільниця', 'Менська дільниця'])
  })

  it('merges stray filings into the town, not real namesakes', () => {
    // Чернігів: 2 rows under Чернігівський РЕМ and one under АТ ЧЕРНІГІВОБЛЕНЕРГО
    const cn = named('Чернігів')[0]!
    expect(cn.rows).toBe(ROWS.filter((r) => r.settlement === 'ЧЕРНІГІВ').length)
    expect([...cn.streets.values()].map((s) => s.street.name)).toContain('Оборонців Чернігова')
    // Бахмач: one building filed under Борзнянська дільниця
    expect(named('Бахмач')).toHaveLength(1)
    // Довжик of Семенівська дільниця is one row of a whole street (46 houses): a village, not a
    // slip. The one house filed under Корюківська дільниця goes to the Довжик with 13 rows
    expect(
      named('Довжик')
        .map((c) => c.city.district)
        .sort(),
    ).toEqual(['Семенівська дільниця', 'Чернігівський РЕМ'])
  })
})

describe('Chernihiv address lookup', () => {
  it('finds the group of a listed house', async () => {
    const { client, calls } = setup()
    expect(
      await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Магістратська', house: '19' }),
    ).toEqual({
      region: 'chernihiv',
      group: '3.2',
      address: { city: 'Чернігів', street: 'Магістратська', house: '19' },
    })
    expect(
      (await client.findGroup('chernihiv', { city: 'чернигов', street: 'вул. Магістратська', house: '3' }))
        .group,
    ).toBe('3.2')
    expect(
      (await client.findGroup('chernihiv', { city: 'Бахмач', street: 'Дружби', house: '4в' })).address.house,
    ).toBe('4В')
    // one download for all of it
    expect(calls).toHaveLength(1)
  })

  it('does not answer for a house the list lacks', async () => {
    const { client } = setup()
    await notFound(client.findGroup('chernihiv', { city: 'Чернігів', street: 'Магістратська', house: '13' }))
    await notFound(client.findGroup('chernihiv', { city: 'Чернігів', street: 'Магістратська', house: '19а' }))
    await notFound(client.findGroup('chernihiv', { city: 'Чернігів', street: 'Хрещатик', house: '1' }))
    await notFound(client.findGroup('chernihiv', { city: 'Київ', street: 'Магістратська', house: '19' }))
  })

  it('returns every group of a number listed under one bare street name', async () => {
    // "Миру" is вулиця Миру and проспект Миру: 213 is in 1.1 and in 4.1
    const { client } = setup()
    const m = await client.findGroup('chernihiv', { city: 'Чернігів', street: 'проспект Миру', house: '213' })
    expect(m).toEqual({
      region: 'chernihiv',
      group: '1.1',
      otherGroups: ['4.1'],
      address: { city: 'Чернігів', street: 'Миру', house: '213' },
    })
    // 213А is another building, in one row
    const a = await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Миру', house: '213-а' })
    expect(a).toMatchObject({ group: '1.1', address: { house: '213А' } })
    expect(a.otherGroups).toBeUndefined()
    // the row filed under the district around the city belongs to the same street
    expect(
      await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Миру', house: '49а' }),
    ).toMatchObject({ group: '6.2', address: { house: '49А' } })
    await notFound(client.findGroup('chernihiv', { city: 'Чернігів', street: 'Миру', house: '214' }))
  })

  it('does not answer for a numbered lane from the street of the same name', async () => {
    // the list has "Миру" in Chernihiv and no "2-й Миру" there: house 2 of Миру is in 1.2
    const { client } = setup()
    expect(
      (await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Миру', house: '2' })).group,
    ).toBe('1.2')
    await notFound(
      client.findGroup('chernihiv', { city: 'Чернігів', street: '2-й провулок Миру', house: '2' }),
      /Did you mean: .*Миру/,
    )
    // a fraction is another house: Перемоги has 85\\2 and no 852
    expect(
      (await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Перемоги', house: '85/2' })).group,
    ).toBe('3.2')
    await notFound(client.findGroup('chernihiv', { city: 'Чернігів', street: 'Перемоги', house: '852' }))
  })

  it('needs the district for a village name that repeats', async () => {
    const { client } = setup()
    const query = { city: 'Городище', street: 'Шевченка', house: '1' }
    await notFound(client.findGroup('chernihiv', query), /Городище \(Менська дільниця\).*pass a district/s)
    expect((await client.findGroup('chernihiv', { ...query, district: 'Менська' })).group).toBe('1.1')
    expect(
      (await client.findGroup('chernihiv', { ...query, house: '1а', district: 'Бахмацька дільниця' })).group,
    ).toBe('4.1')
    const cities = await client.searchCities('chernihiv', 'Городище')
    expect(cities.map((c) => c.district).sort()).toEqual([
      'Бахмацька дільниця',
      'Коропська дільниця',
      'Менська дільниця',
    ])
  })

  it('offers the houses of a street, the typed one first', async () => {
    const { client } = setup()
    const [city] = await client.searchCities('chernihiv', 'Чернігів')
    const [street] = await client.searchStreets('chernihiv', 'Магістратська', { city })
    expect(street).toMatchObject({ name: 'Магістратська' })
    const houses = await client.searchHouses('chernihiv', street!, '19')
    expect(houses[0]!.number).toBe('19')
    expect(houses.map((h) => h.number).sort()).toEqual(['1', '11', '19', '3', '5', '7', '9'])
  })

  it('says how old the list is', async () => {
    const { p, client } = setup()
    await client.findGroup('chernihiv', { city: 'Чернігів', street: 'Магістратська', house: '19' })
    const ctx = { http: (client as unknown as { ctx: { http: never } }).ctx.http, now: () => new Date() }
    expect(await p.addressSource(ctx)).toEqual({
      url: CHERNIHIV_ADDRESS_PDF,
      asOf: '2025-12-25',
      modified: '2026-01-07T14:39:57.000Z',
    })
  })
})

describe('Chernihiv address list: download', () => {
  const query = { city: 'Чернігів', street: 'Магістратська', house: '19' }

  it('is shared by concurrent calls, and one caller giving up does not fail the others', async () => {
    const { fetch, calls } = mockFetch([
      { match: CHERNIHIV_ADDRESS_PDF, body: PDF, headers: { 'Last-Modified': MODIFIED } },
    ])
    const p = provider()
    const http = new Http({ fetch })
    const ctx = (signal?: AbortSignal) => ({ http: http.withSignal(signal), now: () => new Date(), signal })
    const gone = new AbortController()
    const first = p.searchCities(ctx(gone.signal))
    const second = p.searchCities(ctx())
    gone.abort()
    await expect(first).rejects.toThrow()
    expect((await second).length).toBeGreaterThan(30)
    expect(calls).toHaveLength(1)
    // every caller gone: the download is dropped, and the next call starts another
    const alone = new AbortController()
    const p2 = provider()
    const third = p2.searchCities(ctx(alone.signal))
    alone.abort()
    await expect(third).rejects.toThrow()
    expect((await p2.searchCities(ctx())).length).toBeGreaterThan(30)
  })

  it('keeps the list for hours, then asks only whether the file changed', async () => {
    let now = Date.parse('2026-11-17T08:00:00+02:00')
    const seen: (string | null)[] = []
    const fetch: FetchLike = async (_url, init) => {
      const since = new Headers(init?.headers).get('if-modified-since')
      seen.push(since)
      if (since === MODIFIED) return new Response(null, { status: 304 })
      return new Response(PDF as BodyInit, { headers: { 'Last-Modified': MODIFIED } })
    }
    const real = Date.now
    Date.now = () => now
    try {
      const client = new OutageClient({
        fetch,
        now: () => new Date(now),
        cacheTtlMs: 0,
        providers: [provider()],
      })
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      now += 11 * 3600_000
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      expect(seen).toEqual([null])
      now += 2 * 3600_000
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      expect(seen).toEqual([null, MODIFIED])
    } finally {
      Date.now = real
    }
  })

  it('answers from the list it has when the operator stops answering', async () => {
    let now = Date.parse('2026-11-17T08:00:00+02:00')
    let down = false
    let requests = 0
    const fetch: FetchLike = async () => {
      requests++
      if (down) throw new TypeError('fetch failed')
      return new Response(PDF as BodyInit, { headers: { 'Last-Modified': MODIFIED } })
    }
    const real = Date.now
    Date.now = () => now
    try {
      const client = new OutageClient({
        fetch,
        retries: 0,
        now: () => new Date(now),
        cacheTtlMs: 0,
        providers: [provider()],
      })
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      down = true
      now += 13 * 3600_000
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      const after = requests
      // not asked again for a quarter of an hour
      now += 5 * 60_000
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      expect(requests).toBe(after)
      now += 15 * 60_000
      await client.findGroup('chernihiv', query)
      expect(requests).toBeGreaterThan(after)
    } finally {
      Date.now = real
    }
  })

  it('reports a file it cannot read as `parse`, and waits a minute before asking again', async () => {
    let now = Date.parse('2026-11-17T08:00:00+02:00')
    let broken = true
    const { fetch, calls } = mockFetch([
      {
        match: CHERNIHIV_ADDRESS_PDF,
        body: () => (broken ? '%PDF-1.5 nothing' : (PDF as unknown as string)),
        headers: { 'Last-Modified': MODIFIED },
      },
    ])
    const real = Date.now
    Date.now = () => now
    try {
      const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [provider()] })
      const parse = { code: 'parse', details: { region: 'chernihiv', url: CHERNIHIV_ADDRESS_PDF } }
      await expect(client.findGroup('chernihiv', query)).rejects.toMatchObject(parse)
      broken = false
      // a burst of lookups is not a burst of downloads
      await expect(client.findGroup('chernihiv', query)).rejects.toMatchObject(parse)
      expect(calls).toHaveLength(1)
      now += 61_000
      expect((await client.findGroup('chernihiv', query)).group).toBe('3.2')
      expect(calls).toHaveLength(2)
    } finally {
      Date.now = real
    }
  })

  it('fails loudly when the operator does not answer and nothing was read before', async () => {
    const { client } = setup([{ match: CHERNIHIV_ADDRESS_PDF, body: 'no', status: 503 }])
    await expect(client.findGroup('chernihiv', query)).rejects.toBeInstanceOf(OutageError)
  })
})
