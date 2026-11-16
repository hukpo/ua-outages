import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { zaporizhzhiaProvider } from '../../src/providers/zaporizhzhia.js'
import {
  addSheet,
  groupLabel,
  mergeStrays,
  parseCsv,
  parseHouses,
  parseSheetLinks,
  type ZoeDirectory,
} from '../../src/providers/zaporizhzhia-addresses.js'
import { fixture, mockFetch } from '../helpers.js'

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
