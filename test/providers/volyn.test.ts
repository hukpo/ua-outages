import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import {
  houseKey,
  inSettlement,
  matchRecords,
  parseQueueTable,
  type VolynRecord,
  volynProvider,
} from '../../src/providers/volyn.js'
import { fixture, mockFetch } from '../helpers.js'

const FORM = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/'
const RESULT = fixture('volyn/cherga-lutsk-vynnychenka.trimmed.html')

function client(body = RESULT) {
  const { fetch, calls } = mockFetch([{ match: FORM, method: 'POST', body }])
  return {
    client: new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T23:50:00+02:00'),
      cacheTtlMs: 0,
      providers: [volynProvider()],
    }),
    calls,
  }
}

describe('Volynoblenergo', () => {
  it('posts bare names and finds the group of a house', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('volyn', { city: 'м. Луцьк', street: 'вул. Винниченка', house: '8' })
    expect(m).toEqual({
      region: 'volyn',
      group: '4.2',
      address: { city: 'Луцьк', street: 'Винниченка', house: '8' },
    })
    const body = new URLSearchParams(String(calls[0]!.init!.body))
    expect([body.get('formCity'), body.get('formStreet')]).toEqual(['Луцьк', 'Винниченка'])
  })

  it('collects the groups of every record listing the house', async () => {
    // "1" is in a record with 1.2 and in one that isn't part of the schedule
    expect(
      await client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '1' }),
    ).toMatchObject({
      group: '1.2',
    })
    expect(
      await client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '47А' }),
    ).toMatchObject({
      group: '4.1',
    })
  })

  it('explains houses outside the hourly schedule', async () => {
    await expect(
      client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '13' }),
    ).rejects.toThrow(/Не залучено/)
  })

  it('reports an unknown address', async () => {
    const c = client(fixture('volyn/cherga-not-found.trimmed.html')).client
    await expect(
      c.findGroup('volyn', { city: 'Луцьк', street: 'Неіснуюча', house: '1' }),
    ).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('keeps villages of one name in two districts apart', () => {
    const record = (district: string, houses: string[], group: string): VolynRecord => ({
      district,
      city: 'Липини',
      street: 'Шевченка',
      houses,
      group,
      gav: null,
    })
    const records = [record('Луцький', ['1', '2'], '1.1'), record('Ковельський', ['2', '3'], '2.1')]
    const find = (house: string, district?: string) =>
      matchRecords(records, { city: 'Липини', street: 'Шевченка', house, ...(district ? { district } : {}) })
    // not the other village's group, and not both
    expect(() => find('3')).toThrow(/Луцький район; Ковельський район.*district/)
    expect(() => find('2')).toThrow(/district/)
    expect(find('2', 'Луцький район')).toMatchObject({ group: '1.1' })
    expect(find('2', 'Луцький').otherGroups).toBeUndefined()
    expect(find('3', 'ковельський р-н')).toMatchObject({ group: '2.1' })
    expect(() => find('3', 'Луцький')).toThrow(/House "3" not found/)
    expect(() => find('3', 'Рожищенський')).toThrow(/not in the district/)
    // one village: no district needed
    expect(matchRecords(records.slice(0, 1), { city: 'Липини', street: 'Шевченка', house: '1' }).group).toBe(
      '1.1',
    )
  })

  it('does not take "2/3" for "23"', () => {
    const records: VolynRecord[] = [
      {
        district: 'Луцький',
        city: 'Луцьк',
        street: 'Нова',
        houses: ['2/3', '25 А/4', '67-А'],
        group: '3.1',
        gav: null,
      },
    ]
    const find = (house: string) => matchRecords(records, { city: 'Луцьк', street: 'Нова', house })
    expect(find('2/3').group).toBe('3.1')
    expect(find('67а').group).toBe('3.1')
    expect(find('25а/4').group).toBe('3.1')
    expect(() => find('23')).toThrow(/House "23" not found/)
    expect(() => find('25а4')).toThrow(/not found/)
    expect(houseKey('2-3')).toBe(houseKey('2/3'))
  })

  it('splits house lists and drops placeholders', () => {
    const rows = parseQueueTable(RESULT)
    expect(rows[1]).toEqual({
      district: 'Луцький',
      city: 'Луцьк',
      street: 'Винниченка',
      houses: ['1', '2', '62'],
      group: '1.2',
      // "Черга у ГАВ": "Не залучено"
      gav: null,
    })
    expect(rows[0]!.group).toBeNull()
  })

  it('rejects a changed format', () => {
    expect(() => parseQueueTable('<p>Сервіс тимчасово недоступний</p>')).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
    expect(() => parseQueueTable(RESULT.replace('Черга у ГПВ', 'Група'))).toThrow(/header/)
  })
})

describe('Volynoblenergo autocomplete', () => {
  // POST formCity=Луцьк formStreet=Вин: 44 records of Винниченка and Винокурна
  const VYN = fixture('volyn/cherga-lutsk-vyn.trimmed.html')
  const LUTSK = { id: '', name: 'м. Луцьк' }
  const posted = (call: { init?: RequestInit }) => {
    const body = new URLSearchParams(String(call.init!.body))
    return [body.get('formCity'), body.get('formStreet')]
  }

  it('finds the streets of a settlement from a fragment, then houses and the group with no more requests', async () => {
    const { client: c, calls } = client(VYN)
    const streets = (await c.searchStreets('volyn', 'Вин', { city: LUTSK })).sort((a, b) =>
      a.name.localeCompare(b.name, 'uk'),
    )
    expect(streets.map((s) => s.name)).toEqual(['Винниченка', 'Винокурна'])
    expect(posted(calls[0]!)).toEqual(['Луцьк', 'Вин'])
    expect(streets[0]).toMatchObject({ id: 'Луцький|Луцьк|Винниченка', cityId: 'Луцький|Луцьк' })
    const requests = calls.length

    const houses = await c.searchHouses('volyn', streets[0]!)
    expect(houses.map((h) => h.number)).toContain('47а')
    // a house listed in several records appears once
    expect(houses.filter((h) => h.number === '1')).toHaveLength(1)
    const house = houses.find((h) => h.number === '8')!
    expect(await c.groupOf('volyn', house, streets[0]!)).toEqual({
      region: 'volyn',
      group: '4.2',
      address: { city: 'Луцьк', street: 'Винниченка', house: '8' },
    })
    await expect(
      c.groupOf(
        'volyn',
        houses.find((h) => h.number === '13')!,
        streets[0]!,
      ),
    ).rejects.toThrow(/Не залучено/)
    // houses and the group come from the answer the streets came from
    expect(calls).toHaveLength(requests)
    expect(calls.every((x) => posted(x)[0] === 'Луцьк')).toBe(true)
    expect(c.regions()[0]!.capabilities).toMatchObject({ addressSearch: true, streetSearch: true })
  })

  it('keeps only the settlement with exactly that name', async () => {
    // the form matches substrings: "Луцьк" also returns "Прилуцьке" (one record renamed here)
    const mixed = VYN.replace(
      '<td>Луцький</td><td>Луцьк</td><td>Винокурна</td>',
      '<td>Луцький</td><td>Прилуцьке</td><td>Виноградна</td>',
    )
    expect(mixed).not.toBe(VYN)
    const records = parseQueueTable(mixed)
    expect(new Set(records.map((r) => r.city))).toEqual(new Set(['Луцьк', 'Прилуцьке']))
    expect(new Set(inSettlement(records, 'м. Луцьк').map((r) => r.city))).toEqual(new Set(['Луцьк']))
    const streets = await client(mixed).client.searchStreets('volyn', 'Вин', { city: LUTSK })
    expect(streets.map((s) => s.name)).not.toContain('Виноградна')
    // a fragment of the settlement's name is not the settlement
    expect(await client(VYN).client.searchStreets('volyn', 'Вин', { city: { id: '', name: 'Луц' } })).toEqual(
      [],
    )
  })

  it('needs the settlement, and three letters of the street', async () => {
    const { client: c, calls } = client(VYN)
    await expect(c.searchStreets('volyn', 'Вин')).rejects.toMatchObject({ code: 'not-found' })
    expect(await c.searchStreets('volyn', 'вул. Ви', { city: LUTSK })).toEqual([])
    expect(calls).toHaveLength(0)
    // no settlement directory: the settlement is free text
    expect(await c.searchCities('volyn', 'Луцьк')).toEqual([])
  })

  it('asks the form again for a street id kept from an earlier session', async () => {
    const { client: c, calls } = client(VYN)
    const street = { id: 'Луцький|Луцьк|Винокурна', name: 'Винокурна', cityId: 'Луцький|Луцьк' }
    const houses = await c.searchHouses('volyn', street)
    expect(houses.length).toBeGreaterThan(0)
    expect(posted(calls[0]!)).toEqual(['Луцьк', 'Винокурна'])
    expect((await c.groupOf('volyn', houses[0]!, street)).address.street).toBe('Винокурна')
    await expect(c.searchHouses('volyn', { id: 'Луцький|Луцьк|Немає', name: 'Немає' })).rejects.toMatchObject(
      { code: 'not-found' },
    )
  })

  it('finds nothing where the operator knows no such street', async () => {
    const c = client(fixture('volyn/cherga-not-found.trimmed.html')).client
    expect(await c.searchStreets('volyn', 'Неіснуюча', { city: LUTSK })).toEqual([])
  })
})
