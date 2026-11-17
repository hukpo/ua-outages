import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import type { FetchLike } from '../../src/http.js'
import { openPdf } from '../../src/pdf/text.js'
import type { Provider } from '../../src/providers/provider.js'
import { rivneProvider } from '../../src/providers/rivne.js'
import {
  buildRivneDirectory,
  decideRivne,
  houseKey,
  mentionKey,
  parseRivneLinks,
  parseStreetList,
  readOblastRow,
  RIVNE_ADDRESS_PAGE,
  rivneAddresses,
  type RivneMention,
  type RivneRow,
  tableRows,
} from '../../src/providers/rivne-addresses.js'
import { fixture, fixtureBytes, mockFetch, type Route } from '../helpers.js'

// The operator's two files without their embedded fonts: the city list whole (2 pages, 82 rows),
// and pages 1, 16, 19 and 20 of the 45 of the oblast list
const CITY = fixtureBytes('rivne/address/GPV_cherga_misto_Rivne-1.trimmed.pdf')
const OBLAST = fixtureBytes('rivne/address/GPV_cherga_Rivnenska_oblast-1.pages-1-16-19-20.pdf')
const PAGE = fixture('rivne/address/disconnections.address-buttons.2026-11-17.fragment.html')
const CITY_URL = 'https://www.roe.vsei.ua/wp-content/uploads/2026/10/GPV_cherga_misto_Rivne-1.pdf'
const OBLAST_URL = 'https://www.roe.vsei.ua/wp-content/uploads/2026/10/GPV_cherga_Rivnenska_oblast-1.pdf'
const CITY_HEADER = [/№/, /Назви вулиць/, /підчерга/]
const OBLAST_HEADER = [/громади/, /населених пунктів/, /Назви вулиць/, /Черга/]

const ROUTES: Route[] = [
  { match: CITY_URL, body: CITY, headers: { 'Last-Modified': 'Wed, 21 Oct 2026 12:35:14 GMT' } },
  { match: OBLAST_URL, body: OBLAST, headers: { 'Last-Modified': 'Tue, 20 Oct 2026 07:35:36 GMT' } },
  { match: RIVNE_ADDRESS_PAGE, body: PAGE },
]

/** The region as it will be wired: the schedule provider with the address part spread in */
function provider(): Provider & ReturnType<typeof rivneAddresses> {
  const base = rivneProvider()
  return {
    ...base,
    info: { ...base.info, capabilities: { ...base.info.capabilities, addressSearch: true } },
    ...rivneAddresses(base.info.id, base.info.operator),
  }
}

function setup(routes: Route[] = ROUTES) {
  const { fetch, calls } = mockFetch(routes)
  const p = provider()
  return { client: new OutageClient({ fetch, cacheTtlMs: 0, providers: [p] }), calls, p }
}

const refused = async (promise: Promise<unknown>): Promise<string> => {
  const e = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(e).toBeInstanceOf(OutageError)
  expect((e as OutageError).code).toBe('not-found')
  return (e as OutageError).message
}

const show = (m: RivneMention) => ({
  name: m.name,
  houses: [...m.houses.values()],
  ranges: m.ranges.map(
    (r) => `${r.from}-${r.to}${r.parity === null ? '' : r.parity ? ' odd' : ' even'}${r.loose ? ' ~' : ''}`,
  ),
  partial: m.partial,
})
const list = (text: string) => parseStreetList(text).map(show)

describe('Rivne address lists: the files', () => {
  it('finds the two files by their button text', () => {
    expect(parseRivneLinks(PAGE)).toEqual({ city: CITY_URL, oblast: OBLAST_URL })
    // the emergency lists on the same page are other files
    expect(PAGE).toContain('Avaria_Rivne.pdf')
    expect(parseRivneLinks('<a href="/x.pdf">Графік аварійних відключень у м. Рівне</a>')).toBeNull()
  })

  it('assembles the rows of the city table from its cell boxes', () => {
    const rows = tableRows(openPdf(CITY), CITY_HEADER)
    expect(rows).toHaveLength(82)
    // the operator's numbering: one row has no number, and there is no row 50
    expect(rows.map((r) => r.cells[0]).filter(Boolean)).toEqual(
      Array.from({ length: 82 }, (_, i) => String(i + 1)).filter((n) => n !== '50'),
    )
    expect(rows.find((r) => r.cells[1] === 'вул.Соборна 5а')).toEqual({
      cells: ['15', 'вул.Соборна 5а', '2,1'],
      cut: false,
    })
    // four printed lines of one cell, joined as printed
    const row8 = rows.find((r) => r.cells[0] === '8')!
    expect(row8.cells[1]).toMatch(
      /^вул\.Соборна 205,304,.* Пересопницька 167-195 \(непарні\), 180-230 \(парні\), Підгірна, .*Волонтерська 1-26$/,
    )
    expect(row8.cells[2]).toBe('1,2')
    for (const r of rows) expect(r.cells[2]).toMatch(/^[1-6],[12]$/)
  })

  it('joins a word Excel wrapped in the middle, and reads the oblast table', () => {
    const rows = tableRows(openPdf(OBLAST), OBLAST_HEADER)
    expect(rows).toHaveLength(60)
    expect(rows[0]!.cells[0]).toBe('Березнівська')
    expect(rows[0]!.cells[1]).toBe(
      'м.Березне (частково), с.Балашівка (частково), с.Яцковичі (повністю), с.Михалин (повністю), с.Лінчин (повністю)',
    )
    // "пров.Б.Хмельницьког" + "о,В.Стуса"
    expect(rows[0]!.cells[2]).toContain('Б.Хмельницького,пров.Б.Хмельницького,В.Стуса')
    expect(rows[0]!.cells[3]).toBe('1.2')
    // a cell whose text runs past its box: lines are missing from the file
    expect(rows.filter((r) => r.cut).map((r) => r.cells[1])).toEqual(['м.Здолбунів'])
  })

  it('refuses a table with other columns', () => {
    expect(() => tableRows(openPdf(CITY), OBLAST_HEADER)).toThrow(/table columns/)
    expect(() => tableRows(openPdf(OBLAST), [/a/, /b/, /c/, /d/])).toThrow(/header/)
  })
})

describe('Rivne address lists: a cell', () => {
  it('reads streets with their houses, ranges and sides', () => {
    expect(
      list(
        'вул.Соборна 205,304,312а, Пересопницька 167-195 (непарні), 180-230 (парні), Підгірна, пров.Підгірний',
      ),
    ).toEqual([
      { name: 'вул. Соборна', houses: ['205', '304', '312а'], ranges: [], partial: false },
      { name: 'Пересопницька', houses: [], ranges: ['167-195 odd', '180-230 even'], partial: false },
      { name: 'Підгірна', houses: [], ranges: [], partial: false },
      { name: 'пров. Підгірний', houses: [], ranges: [], partial: false },
    ])
    expect(list('Литовська 10, 11, 20 - 40, 41, 46 -52а, 53')).toEqual([
      {
        name: 'Литовська',
        houses: ['10', '11', '41', '52а', '53'],
        ranges: ['20-40', '46-52'],
        partial: false,
      },
    ])
  })

  it('ends a street at a number glued to the next name, and at text it cannot read', () => {
    expect(list('вул.Відінська,21а, 23авул.Данила Галицького 10,12А,62')).toEqual([
      { name: 'вул. Відінська', houses: ['21а', '23а'], ranges: [], partial: false },
      { name: 'вул. Данила Галицького', houses: ['10', '12А', '62'], ranges: [], partial: false },
    ])
    expect(list('І.Богуна 1,2Івана Огієнка 26,28, 41-57Степана Бандери 1')).toEqual([
      { name: 'І.Богуна', houses: ['1', '2'], ranges: [], partial: false },
      { name: 'Івана Огієнка', houses: ['26', '28'], ranges: ['41-57'], partial: false },
      { name: 'Степана Бандери', houses: ['1'], ranges: [], partial: false },
    ])
    // the note is about the street before it; the numbers after the new name are the new street's
    expect(list('вул.Соборна 5, (частково) вул.Грицая 7, 9')).toEqual([
      { name: 'вул. Соборна', houses: ['5'], ranges: [], partial: true },
      { name: 'вул. Грицая', houses: ['7', '9'], ranges: [], partial: false },
    ])
    // not a house and not a note: what follows is nobody's
    expect(list('Сонячна 4, 1-ого Грудня 1-25, 7, 9')).toEqual([
      { name: 'Сонячна', houses: ['4'], ranges: [], partial: true },
    ])
    // a lettered house is not a glued name
    expect(list('Шкільна 1А,2Б,49, 16 Липня 7')).toEqual([
      { name: 'Шкільна', houses: ['1А', '2Б', '49'], ranges: [], partial: false },
      { name: '16 Липня', houses: ['7'], ranges: [], partial: false },
    ])
  })

  it("keeps no houses for another settlement's streets in the city list", () => {
    expect(list('вул.Нова 3, с. Тинне, вул. Лугова 5, 7-11, Клубна')).toEqual([
      { name: 'вул. Нова', houses: ['3'], ranges: [], partial: false },
      { name: 'с. Тинне', houses: [], ranges: [], partial: true },
      { name: 'вул. Лугова', houses: [], ranges: [], partial: true },
      { name: 'Клубна', houses: [], ranges: [], partial: true },
    ])
    const row = (group: string, text: string): RivneRow => ({
      group,
      kind: 'streets',
      text,
      mentions: parseStreetList(text),
      cut: false,
    })
    const rows = [row('5.1', 'с. Тинне, вул. Лугова 5, 7'), row('2.1', 'вул.Лугова 1, 3')]
    expect(decideRivne(rows, mentionKey('Лугова'), '5')).toMatchObject({
      groups: null,
      candidates: [{ group: '5.1', why: 'the street is listed in part' }],
    })
    expect(decideRivne(rows, mentionKey('Лугова'), '3').groups).toEqual(['2.1'])
  })

  it('marks what it does not understand as partial', () => {
    expect(
      list(
        'вул.24 серпня (частково) , вул.Кооперативна 3а, (частково), вул.Пересопницька частково, Дорошенка-частково',
      ),
    ).toEqual([
      { name: 'вул. 24 серпня', houses: [], ranges: [], partial: true },
      { name: 'вул. Кооперативна', houses: ['3а'], ranges: [], partial: true },
      { name: 'вул. Пересопницька', houses: [], ranges: [], partial: true },
      { name: 'Дорошенка', houses: [], ranges: [], partial: true },
    ])
    expect(list('вул. Старицького,1-49,2-66(приватний сектор),(промзона) База ОРПК')).toEqual([
      { name: 'вул. Старицького', houses: [], ranges: ['1-49', '2-66 ~'], partial: true },
    ])
    expect(list('Київська від поліції до виїзду на Звягель')[0]).toMatchObject({ houses: [], ranges: [] })
  })

  it('keeps numbers that belong to a name, and survives the punctuation', () => {
    expect(list('ЗОШ №23, вул.Вербова 24, 38, 93. вул.Бухала 2, вул.16 Липня 7, 1 Травня')).toEqual([
      { name: 'ЗОШ №23', houses: [], ranges: [], partial: false },
      { name: 'вул. Вербова', houses: ['24', '38', '93'], ranges: [], partial: false },
      { name: 'вул. Бухала', houses: ['2'], ranges: [], partial: false },
      { name: 'вул. 16 Липня', houses: ['7'], ranges: [], partial: false },
      { name: '1 Травня', houses: [], ranges: [], partial: false },
    ])
    // "вул," cut off by a stray comma is no street
    expect(list('вул, Пересопницька 150,168А').map((m) => m.name)).toEqual(['Пересопницька'])
  })

  it('knows one street under its spellings', () => {
    expect(mentionKey('вулиця Степана Бандери')).toBe(mentionKey('вул.С.Бандери'))
    expect(mentionKey('Князя Володимира')).toBe(mentionKey('Кн.Володимира'))
    expect(mentionKey('провулок Підгірний')).not.toBe(mentionKey('Підгірна'))
    expect(mentionKey('Бандери')).not.toBe(mentionKey('С.Бандери'))
    expect(houseKey('5-А')).toBe(houseKey('5а'))
    expect(houseKey('14/44')).not.toBe(houseKey('1444'))
  })

  it('pairs settlements with their lists only when the row says which is whose', () => {
    const kinds = (a: string, b: string) => readOblastRow(a, b).map((s) => `${s.name}: ${s.kind}`)
    expect(kinds('с.Ганнівка, с.Копитів, с.Річки', 'повністю')).toEqual([
      'Ганнівка: whole',
      'Копитів: whole',
      'Річки: whole',
    ])
    expect(
      kinds(
        'м.Березне (частково), с.Балашівка (частково), с.Яцковичі (повністю)',
        'м.Березне (вул.15 Лютого,Зірненська) с.Балашівка (вул.Незалежності 54-138, Вигон)',
      ),
    ).toEqual(['Березне: streets', 'Балашівка: streets', 'Яцковичі: whole'])
    // two villages, one unmarked list: nobody's
    expect(kinds('с.Плоска, с.Корнин', '1 Травня,Заводська,Шевченка')).toEqual([
      'Плоска: unknown',
      'Корнин: unknown',
    ])
    // a village the row doesn't name leads a list
    expect(kinds('с.Хорів', 'с.Оженіно вул.Залізнична. с.Хорів вул. Соколюка.')).toEqual(['Хорів: unknown'])
    // an enterprise: nothing to look up
    expect(kinds('ТОВ "Ліспромсервіс"', 'повністю')).toEqual([])
  })
})

describe('Rivne address lists: deciding', () => {
  const dir = buildRivneDirectory(
    tableRows(openPdf(CITY), CITY_HEADER),
    tableRows(openPdf(OBLAST), OBLAST_HEADER),
  )
  const rivne = dir.places.get('rivne')!
  const decide = (street: string, house: string) =>
    decideRivne(rivne.rows, mentionKey(street), houseKey(house))

  it('counts what was read with certainty', () => {
    expect(dir.stats).toMatchObject({ rows: 142, skipped: 1 })
    expect(dir.stats.whole + dir.stats.streets + dir.stats.unknown + dir.stats.skipped).toBe(dir.stats.rows)
    expect(dir.stats.streets).toBeGreaterThan(90)
  })

  it('settles a named house, in every group that names it', () => {
    expect(decide('Соборна', '5а')).toEqual({ groups: ['2.1'], house: '5а', candidates: [] })
    // rows 9 (1,2) and 15… both name Соборна 63
    expect(decide('Соборна', '63').groups).toEqual(['1.2', '2.1'])
  })

  it('settles a house inside a range only on the side the range covers', () => {
    expect(decide('Пересопницька', '169').groups).toEqual(['1.2'])
    expect(decide('Пересопницька', '200').groups).toEqual(['1.2'])
    // even, inside "167-195 (непарні)" only
    expect(decide('Пересопницька', '170').groups).toBeNull()
    // "42-64": 44 for certain, 43 may be the other side of the street
    expect(decide('Кн.Володимира', '44').groups).toEqual(['1.2'])
    const odd = decide('Кн.Володимира', '43')
    expect(odd.groups).toBeNull()
    expect(odd.candidates.map((c) => `${c.group}: ${c.why}`)).toContain('1.2: a range that may include it')
    // a letter inside a range isn't named
    expect(decide('Кн.Володимира', '44а').groups).toBeNull()
  })

  it('takes a street listed whole in one group, and not one listed in part', () => {
    expect(decide('Підгірна', '3')).toEqual({ groups: ['1.2'], candidates: [] })
    const part = decide('Замкова', '1')
    expect(part.groups).toBeNull()
    expect(part.candidates.every((c) => c.why === 'the street is listed in part')).toBe(true)
    expect(part.candidates.map((c) => c.group)).toEqual(['1.2', '2.1'])
    expect(part.candidates[0]!.text).toContain('вул.Замкова (частково)')
  })

  it('has nothing to say about a street the list lacks', () => {
    expect(decide('Хрещатик', '1')).toEqual({ groups: null, candidates: [] })
    expect(decide('Соборна', '1000').groups).toBeNull()
  })

  it('does not settle a range against text of another group it could not read', () => {
    const mention = (text: string) => parseStreetList(text)
    const rows = [
      {
        group: '3.2',
        kind: 'streets' as const,
        text: 'Шевченка. 9- 140',
        mentions: mention('Шевченка 9-140'),
        cut: false,
      },
      {
        group: '5.1',
        kind: 'unknown' as const,
        text: 'м.Здолбунів вул. Шевченка 202, 93-151',
        mentions: [],
        cut: false,
      },
    ]
    const d = decideRivne(rows, mentionKey('Шевченка'), '100')
    expect(d.groups).toBeNull()
    expect([...new Set(d.candidates.map((c) => c.group))].sort()).toEqual(['3.2', '5.1'])
    expect(decideRivne(rows.slice(0, 1), mentionKey('Шевченка'), '100').groups).toEqual(['3.2'])
    // a street listed whole, against a row cut off in the file
    const whole = [
      { group: '1.1', kind: 'streets' as const, text: 'Зелена', mentions: mention('Зелена'), cut: false },
      {
        group: '2.1',
        kind: 'streets' as const,
        text: 'Дружби 15,26',
        mentions: mention('Дружби 15,26'),
        cut: true,
      },
    ]
    expect(decideRivne(whole, mentionKey('Зелена'), '7').groups).toBeNull()
    expect(decideRivne(whole.slice(0, 1), mentionKey('Зелена'), '7').groups).toEqual(['1.1'])
  })
})

describe('Rivne address lookup', () => {
  it('answers for a house the list names', async () => {
    const { client, calls } = setup()
    expect(await client.findGroup('rivne', { city: 'Рівне', street: 'Соборна', house: '5а' })).toEqual({
      region: 'rivne',
      group: '2.1',
      address: { city: 'Рівне', street: 'вул. Соборна', house: '5а' },
    })
    expect(
      await client.findGroup('rivne', { city: 'рівне', street: 'вул. Князя Володимира', house: '28-Б' }),
    ).toMatchObject({
      group: '1.2',
      address: { house: '28б' },
    })
    expect(await client.findGroup('rivne', { city: 'Рівне', street: 'Соборна', house: '63' })).toMatchObject({
      group: '1.2',
      otherGroups: ['2.1'],
    })
    // the page and the two files, once
    expect(calls.map((c) => c.url)).toEqual([RIVNE_ADDRESS_PAGE, CITY_URL, OBLAST_URL])
  })

  it('names the candidate groups and the wording instead of guessing', async () => {
    const { client } = setup()
    const message = await refused(client.findGroup('rivne', { city: 'Рівне', street: 'Замкова', house: '1' }))
    expect(message).toMatch(/doesn't settle it/)
    expect(message).toMatch(/1\.2 \(the street is listed in part: "вул\.24 серпня \(частково\)/)
    expect(message).toMatch(/2\.1 \(the street is listed in part/)
    expect(
      await refused(client.findGroup('rivne', { city: 'Рівне', street: 'Соборна', house: '1000' })),
    ).toMatch(/not in Рівнеобленерго's lists/)
    expect(
      await refused(client.findGroup('rivne', { city: 'Рівне', street: 'Хрещатик', house: '1' })),
    ).toMatch(/not in/)
    expect(await refused(client.findGroup('rivne', { street: 'Соборна', house: '5а' }))).toMatch(
      /specify a city/,
    )
  })

  it('keys settlements by their community', async () => {
    const { client } = setup()
    const query = { city: 'Ганнівка', street: 'Шевченка', house: '3' }
    expect(await refused(client.findGroup('rivne', query))).toMatch(
      /Ганнівка \(Корецька громада\); Ганнівка \(Деражненська громада\).*pass a district/,
    )
    // "с.Ганнівка, с.Копитів, с.Річки, … | повністю | 4.1"
    expect(await client.findGroup('rivne', { ...query, district: 'Корецька' })).toEqual({
      region: 'rivne',
      group: '4.1',
      address: { city: 'Ганнівка', street: 'Шевченка', house: '3' },
    })
    const cities = await client.searchCities('rivne', 'Ганнівка')
    expect(cities.map((c) => c.district).sort()).toEqual(['Деражненська громада', 'Корецька громада'])
  })

  it('answers for a village listed whole, and for a marked list of a shared row', async () => {
    const { client } = setup()
    expect(
      (await client.findGroup('rivne', { city: 'Коловерть', street: 'Центральна', house: '3' })).group,
    ).toBe('4.2')
    expect(
      (await client.findGroup('rivne', { city: 'Балашівка', street: 'Незалежності', house: '60' })).group,
    ).toBe('1.2')
    // "Незалежності 54-138": 10 is not in it
    await refused(client.findGroup('rivne', { city: 'Балашівка', street: 'Незалежності', house: '10' }))
  })

  it('does not pick one of two groups that both list a village whole', async () => {
    // "с.Яцковичі (повністю)" in a row of 1.2, and "с.Яцковичі повністю" with a list of its
    // streets in a row of 4.2
    const { client } = setup()
    for (const street of ['Центральна', 'Лісова', 'Шкільна']) {
      const said = await refused(client.findGroup('rivne', { city: 'Яцковичі', street, house: '3' }))
      expect(said).toMatch(
        /Could be 1\.2 \(the settlement is listed whole.*4\.2 \(the settlement is listed whole/,
      )
    }
  })

  it('credits houses to the street they follow, not to the one before a glued name', async () => {
    const { client } = setup()
    const find = (city: string, street: string, house: string) =>
      client.findGroup('rivne', { city, street, house })
    // "вул.Відінська,21а, 23А,…,23авул.Данила Галицького 10,…,12А,…,62,…" in a row of 6.2
    expect(await refused(find('Рівне', 'Відінська', '12а'))).toMatch(/not in/)
    expect(await refused(find('Рівне', 'Відінська', '62'))).toMatch(/not in/)
    const twelve = await find('Рівне', 'Відінська', '12')
    expect([twelve.group, twelve.otherGroups]).toEqual(['5.1', undefined])
    expect(await find('Рівне', 'Данила Галицького', '12а')).toMatchObject({
      group: '6.2',
      address: { street: 'вул. Данила Галицького', house: '12А' },
    })
    // "І.Богуна 1,2Івана Огієнка 26,28,…Зелена 53,53А,…": line breaks inside the cell
    await refused(find('Здолбунів', 'Богуна', '28'))
    await refused(find('Здолбунів', 'провулок Івана Огієнка', '53а'))
    expect(await find('Здолбунів', 'Івана Огієнка', '28')).toMatchObject({
      group: '6.1',
      address: { street: 'Івана Огієнка' },
    })
    expect((await find('Здолбунів', 'Зелена', '53а')).address).toMatchObject({ house: '53А' })
  })

  it('serves the search chain for autocomplete', async () => {
    const { client } = setup()
    const [city] = await client.searchCities('rivne', 'Рівне')
    expect(city).toMatchObject({ id: 'rivne', name: 'Рівне' })
    const streets = await client.searchStreets('rivne', 'Соборна', { city })
    expect(streets[0]!.name).toBe('вул. Соборна')
    const houses = await client.searchHouses('rivne', streets[0]!, '5а')
    expect(houses.map((h) => h.number)).toContain('5а')
  })
})

describe('Rivne address lists: download', () => {
  const query = { city: 'Рівне', street: 'Соборна', house: '5а' }

  it('keeps the lists for hours, then asks only whether the files changed', async () => {
    let now = Date.parse('2026-11-17T08:00:00+02:00')
    const seen: string[] = []
    const fetch: FetchLike = async (url, init) => {
      const route = ROUTES.find((r) => url.includes(r.match as string))!
      const since = new Headers(init?.headers).get('if-modified-since')
      seen.push(`${url.split('/').pop()}${since ? ' if-modified' : ''}`)
      if (since && since === route.headers?.['Last-Modified']) return new Response(null, { status: 304 })
      return new Response(route.body as BodyInit, { headers: route.headers })
    }
    const real = Date.now
    Date.now = () => now
    try {
      const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [provider()] })
      expect((await client.findGroup('rivne', query)).group).toBe('2.1')
      now += 5 * 3600_000
      await client.findGroup('rivne', query)
      expect(seen).toHaveLength(3)
      now += 2 * 3600_000
      expect((await client.findGroup('rivne', query)).group).toBe('2.1')
      expect(seen.slice(3)).toEqual([
        'disconnections',
        'GPV_cherga_misto_Rivne-1.pdf if-modified',
        'GPV_cherga_Rivnenska_oblast-1.pdf if-modified',
      ])
    } finally {
      Date.now = real
    }
  })

  it('answers from the lists it has when the site stops answering, and fails when it has none', async () => {
    let now = Date.parse('2026-11-17T08:00:00+02:00')
    let down = false
    const ok = mockFetch(ROUTES).fetch
    const fetch: FetchLike = async (url, init) => {
      if (down) throw new TypeError('fetch failed')
      return ok(url, init)
    }
    const real = Date.now
    Date.now = () => now
    try {
      const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [provider()] })
      expect((await client.findGroup('rivne', query)).group).toBe('2.1')
      down = true
      now += 7 * 3600_000
      expect((await client.findGroup('rivne', query)).group).toBe('2.1')
      const cold = new OutageClient({ fetch, cacheTtlMs: 0, providers: [provider()] })
      await expect(cold.findGroup('rivne', query)).rejects.toMatchObject({ code: 'network' })
    } finally {
      Date.now = real
    }
  })

  it('reports a page without the links, or a file that is not the table, as `parse`', async () => {
    const noLinks = setup([{ match: RIVNE_ADDRESS_PAGE, body: '<p>Графік погодинних відключень</p>' }])
    await expect(noLinks.client.findGroup('rivne', query)).rejects.toMatchObject({
      code: 'parse',
      details: { region: 'rivne', url: RIVNE_ADDRESS_PAGE },
    })
    // the two files swapped: the columns are not the ones expected
    const swapped = setup([
      { match: CITY_URL, body: OBLAST },
      { match: OBLAST_URL, body: CITY },
      { match: RIVNE_ADDRESS_PAGE, body: PAGE },
    ])
    await expect(swapped.client.findGroup('rivne', query)).rejects.toMatchObject({
      code: 'parse',
      details: { url: CITY_URL },
    })
  })

  it('does not answer for a street with another number or type in its name', async () => {
    const { client } = setup()
    expect((await client.findGroup('rivne', { ...query, street: 'вул. Соборна' })).group).toBe(
      (await client.findGroup('rivne', query)).group,
    )
    expect(await refused(client.findGroup('rivne', { ...query, street: '2-й провулок Соборний' }))).toMatch(
      /Did you mean|not found|no street/i,
    )
  })

  it('says which files it read', async () => {
    const { client, p } = setup()
    await client.findGroup('rivne', query)
    const ctx = { http: (client as unknown as { ctx: { http: never } }).ctx.http, now: () => new Date() }
    expect(await p.addressSource(ctx)).toEqual({
      files: [
        { url: CITY_URL, modified: '2026-10-21T12:35:14.000Z' },
        { url: OBLAST_URL, modified: '2026-10-20T07:35:36.000Z' },
      ],
    })
  })
})
