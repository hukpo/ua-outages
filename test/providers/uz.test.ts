import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import { assessFreshness } from '../../src/freshness.js'
import { parseUzPage, rememberToday, UZ_PAGES, uzProvider } from '../../src/providers/uz.js'
import {
  parseUzAddresses,
  parseUzHouses,
  uzDirectory,
  uzGroupHeader,
  uzHouseKey,
} from '../../src/providers/uz-addresses.js'
import type { RegionId } from '../../src/types.js'
import { fixture, mockFetch, expectUnpublished } from '../helpers.js'

const NOW = new Date('2026-11-08T14:00:00+02:00')
const KYIV = fixture('uz/kyiv.2026-11-08.html')
const VINNYTSIA = fixture('uz/vinnytsia.2026-11-08.html')
const DNIPRO = fixture('uz/dnipro.2026-11-08.html')
const VOLYN = fixture('uz/volyn.2026-11-08.html')
const KHARKIV = fixture('uz/kharkiv.2026-11-14.html')

const hhmm = (s: ReturnType<typeof parseUzPage>, g: string) =>
  s.schedules[g]![0]!.intervals.map((i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)}`)

describe('Укрзалізниця', () => {
  it('reads the time-span layout through the client', async () => {
    const { fetch } = mockFetch([{ match: 'grafikiobmezhen/649725/', body: KYIV }])
    const provider = uzProvider({ id: 'uz-kyiv', oblast: 'Київ', page: 649725 })
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [provider] })
    const s = await c.getSchedules('uz-kyiv')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']![0]!.date).toBe('2026-11-08')
    expect(hhmm(s, '1.1')).toEqual(['00:00–00:30', '07:30–14:30', '18:00–00:00'])
    expect(hhmm(s, '6.2')).toEqual(['00:00–00:30', '04:00–11:00', '14:30–21:30'])
    expect(provider.info.name).toBe('Київ (Укрзалізниця)')
  })

  it('ignores commented-out parts of the page', () => {
    // the Kyiv page has an old address list inside <!-- -->; it must not end the schedule early
    expect(KYIV).toContain('<!--')
    const s = parseUzPage(KYIV, NOW, 'uz-kyiv')
    expect(Object.values(s.schedules).every((d) => d[0]!.intervals.length)).toBe(true)
  })

  it('picks the table of one railway branch', () => {
    const sw = parseUzPage(VINNYTSIA, NOW, 'uz-vinnytsia', 'Південно-Західна')
    const od = parseUzPage(VINNYTSIA, NOW, 'uz-vinnytsia-odesa', 'Одеська')
    expect(hhmm(sw, '1.1')).toEqual(['00:00–01:30', '09:00–12:00', '19:00–22:00'])
    expect(hhmm(od, '1.1')).toEqual(['03:00–06:30', '13:30–17:00'])
    // "6(1)" names only the first subgroup
    expect(hhmm(sw, '6.1')).toEqual(['05:00–08:30'])
    expect(hhmm(sw, '6.2')).toEqual([])
    expect(od.schedules['1.1']![0]!.date).toBe('2026-11-08')
  })

  it('reads the group-column layout', () => {
    const s = parseUzPage(DNIPRO, NOW, 'uz-dnipro')
    expect(hhmm(s, '1.1')).toEqual(['03:30–07:00', '10:30–17:30'])
    expect(hhmm(s, '6.2')).toEqual(['00:00–03:30', '10:30–14:00', '17:30–00:00'])
  })

  it('reads a span with a typo from its neighbours', () => {
    // the Kharkiv table heads its second column "11500 14.30" (for 11.00–14.30)
    const s = parseUzPage(KHARKIV, new Date('2026-11-15T08:00:00+02:00'), 'uz-kharkiv')
    expect(s.schedules['5.1']![0]!.date).toBe('2026-11-15')
    expect(hhmm(s, '5.1')).toEqual(['11:00–14:30', '21:30–22:00'])
    expect(hhmm(s, '3.1')).toEqual(['08:00–11:00', '18:00–21:30'])
    expect(hhmm(s, '6.2')).toEqual(['11:00–14:30', '21:30–00:00'])
  })

  it('lists the groups as unknown, not "no outages", when no schedule is published', () => {
    expectUnpublished(parseUzPage(VOLYN, NOW, 'uz-volyn'), 12)
  })
})

const NOW17 = new Date('2026-11-17T00:30:00+02:00')
const KYIV17 = fixture('uz/kyiv.2026-11-17.trimmed.html')
const LVIV17 = fixture('uz/lviv.2026-11-17.trimmed.html')
const RIVNE17 = fixture('uz/rivne.2026-11-17.trimmed.html')
const KHMELNYTSKYI17 = fixture('uz/khmelnytskyi.2026-11-17.trimmed.html')
const CHERNIVTSI17 = fixture('uz/chernivtsi.2026-11-17.trimmed.html')
const KHERSON17 = fixture('uz/kherson.2026-11-17.trimmed.html')

const dates = (s: ReturnType<typeof parseUzPage>, g = '1.1') =>
  s.schedules[g]!.map((d) => `${d.date} ${d.status}`)

describe('Укрзалізниця: which day a table is for', () => {
  it('files each table under the date written above it: today and tomorrow on one page', () => {
    // the Chernivtsi page of 17.11 00:29 still has the table of 16.11 above the one of 17.11
    const s = parseUzPage(CHERNIVTSI17, NOW17, 'uz-chernivtsi')
    expect(dates(s)).toEqual(['2026-11-16 scheduled', '2026-11-17 scheduled'])
    expect(s.schedules['1.1']![0]!.intervals).not.toEqual(
      s.schedules['1.1']![1]!.intervals.map((i) => ({ ...i })),
    )
    expect(s.updatedAt).toBeNull()
    expect(assessFreshness(s, { now: NOW17 }).today).toBe('published')
    // read on the evening of the 16th, the same page has today and tomorrow
    const evening = parseUzPage(CHERNIVTSI17, new Date('2026-11-16T22:00:00+02:00'), 'uz-chernivtsi')
    expect(assessFreshness(evening, { now: new Date('2026-11-16T22:00:00+02:00') })).toMatchObject({
      today: 'published',
      tomorrow: 'published',
    })
  })

  it('never presents a table dated earlier as today', () => {
    // the page of 08.11 read three days later: its day stays 08.11, today is unknown
    const now = new Date('2026-11-11T09:00:00+02:00')
    const s = parseUzPage(KYIV, now, 'uz-kyiv')
    expect(dates(s)).toEqual(['2026-11-08 scheduled', '2026-11-11 unknown'])
    const f = assessFreshness(s, { now })
    expect(f.state).toBe('stale')
    expect(f.today).toBe('missing')
    expect(f.issues.map((i) => i.code)).toContain('behind')
  })

  it('lists today as unknown when the page has moved on to tomorrow', () => {
    // saved 14.11 in the evening: the Kharkiv page already showed only the table of 15.11
    const now = new Date('2026-11-14T22:00:00+02:00')
    const s = parseUzPage(KHARKIV, now, 'uz-kharkiv')
    expect(dates(s, '5.1')).toEqual(['2026-11-14 unknown', '2026-11-15 scheduled'])
  })

  it('keeps the table it read for today when the page drops it for tomorrow', () => {
    const seen = new Map()
    const morning = new Date('2026-11-14T09:00:00+02:00')
    const today = parseUzPage(KHARKIV.replace('&nbsp;15</span>', '&nbsp;14</span>'), morning, 'uz-kharkiv')
    expect(dates(today, '5.1')).toEqual(['2026-11-14 scheduled'])
    rememberToday(today, seen, morning)
    const evening = new Date('2026-11-14T22:00:00+02:00')
    const s = rememberToday(parseUzPage(KHARKIV, evening, 'uz-kharkiv'), seen, evening)
    expect(dates(s, '5.1')).toEqual(['2026-11-14 scheduled', '2026-11-15 scheduled'])
    expect(s.schedules['5.1']![0]).toEqual(today.schedules['5.1']![0])
    // a page with no table at all is the schedule taken down: nothing is put back
    const down = rememberToday(parseUzPage(VOLYN, evening, 'uz-kharkiv'), seen, evening)
    expectUnpublished(down, 12)
    // and yesterday's table is never kept for the next day
    const next = new Date('2026-11-16T09:00:00+02:00')
    rememberToday(parseUzPage(VOLYN, next, 'uz-kharkiv'), seen, next)
    expect([...seen.keys()]).toEqual([])
  })

  it('throws rather than guess the day of a table without a date', () => {
    const undated = KYIV.replace(/8 листопада/g, '')
    expect(() => parseUzPage(undated, NOW, 'uz-kyiv')).toThrow(/no date above the table/)
  })
})

describe('Укрзалізниця: address lists', () => {
  function client(routes: Record<number, string>, now = NOW17) {
    const { fetch, calls } = mockFetch(
      Object.entries(routes).map(([page, body]) => ({ match: `grafikiobmezhen/${page}/`, body })),
    )
    const providers = UZ_PAGES.map(([id, oblast, page, branch]) => uzProvider({ id, oblast, page, branch }))
    return { c: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers }), calls }
  }
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof OutageError ? e.code : String(e)),
    )

  it('reads every spelling of the group header', () => {
    expect(uzGroupHeader('І черга/ ІI підчерга')).toEqual({ queue: 1, sub: 2 })
    expect(uzGroupHeader('1 черга І підчерга')).toEqual({ queue: 1, sub: 1 })
    expect(uzGroupHeader('1черга ІІ підчерга')).toEqual({ queue: 1, sub: 2 })
    expect(uzGroupHeader('1 черга 1 півчерга')).toEqual({ queue: 1, sub: 1 })
    expect(uzGroupHeader('ІІІ Черга/ІІ Півчерга')).toEqual({ queue: 3, sub: 2 })
    // a space inside the numeral, Latin and Cyrillic letters mixed
    expect(uzGroupHeader('І V черга І півчерга')).toEqual({ queue: 4, sub: 1 })
    expect(uzGroupHeader('VI черга II підчерга')).toEqual({ queue: 6, sub: 2 })
    // two-level headers
    expect(uzGroupHeader('1 черга')).toEqual({ queue: 1 })
    expect(uzGroupHeader('2 півчерга')).toEqual({ sub: 2 })
    expect(uzGroupHeader('Сумська область')).toBeNull()
    expect(uzGroupHeader('7 черга 1 підчерга')).toBeNull()
  })

  it('takes a row that only names a group for a header, however it is laid out', () => {
    const section = parseUzAddresses(`Перелік адрес <table>
      <tr><td>Найменування населеного пункту</td><td>Найменування вулиці</td><td>Будинки</td></tr>
      <tr><td colspan="3">1 черга 1 підчерга</td></tr>
      <tr><td>с. А</td><td>Садова</td><td>1,2</td></tr>
      <tr><td>1 черга 2 підчерга</td><td></td><td></td></tr>
      <tr><td>с. Б</td><td>Лісова</td><td>5</td></tr>
      <tr><td>2 черга 1 підчерга</td></tr>
      <tr><td>с. В</td><td>Нова</td><td>7</td></tr>
      <tr><td>,9,11</td></tr>
    </table>`)!
    expect(section.rows.map((r) => `${r.group} ${r.settlement} ${r.street} ${r.houses}`)).toEqual([
      '1.1 с. А Садова 1,2',
      '1.2 с. Б Лісова 5',
      '2.1 с. В Нова 7,,9,11',
    ])
    expect(section.skipped).toEqual([])
  })

  it('finds a Kyiv address, and both groups of one listed twice', async () => {
    const { c } = client({ 649725: KYIV17 })
    expect(await c.findGroup('uz-kyiv', { city: 'Київ', street: 'Уманська', house: '5' })).toEqual({
      region: 'uz-kyiv',
      group: '5.1',
      address: { city: 'Київ', street: 'Уманська', house: '5' },
    })
    const twice = await c.findGroup('uz-kyiv', { city: 'Київ', street: 'площа Привокзальна', house: '1' })
    expect([twice.group, twice.otherGroups]).toEqual(['1.1', ['4.2']])
    const typed = await c.findGroup('uz-kyiv', { city: 'м. Київ', street: 'вул. Брюлова', house: '1' })
    expect([typed.group, typed.otherGroups]).toEqual(['1.2', ['3.2']])
    // an empty settlement cell continues the one above
    expect((await c.findGroup('uz-kyiv', { city: 'Київ', street: 'Чубинського', house: '4' })).group).toBe(
      '4.2',
    )
  })

  it('leaves out the tables under the list: they follow another schedule', async () => {
    // "Алматинська 14а" is in the Kyiv page's second table, which points to the Kyiv oblast page
    expect(KYIV17).toContain('14а,18,20')
    const { c } = client({ 649725: KYIV17 })
    expect(await code(c.findGroup('uz-kyiv', { city: 'Київ', street: 'Алматинська', house: '14а' }))).toBe(
      'not-found',
    )
    const section = parseUzAddresses(KYIV17)!
    expect(section.rows).toHaveLength(64)
    expect(section.rows.filter((r) => r.group === '6.2')).toHaveLength(1)
  })

  it('downloads the page once for the schedule and the addresses', async () => {
    const { c, calls } = client({ 649725: KYIV17 })
    await c.getSchedules('uz-kyiv')
    await c.findGroup('uz-kyiv', { city: 'Київ', street: 'Уманська', house: '5' })
    const cities = await c.searchCities('uz-kyiv', 'Київ')
    await c.searchStreets('uz-kyiv', 'Уманська', { city: cities[0] })
    expect(calls).toHaveLength(1)
  })

  it('reads rowspans and a list cut in two tables (Lviv)', async () => {
    const section = parseUzAddresses(LVIV17)!
    expect(section.rows).toHaveLength(515)
    // the second table starts with "4 черга ІІ півчерга" and has no column header
    expect(new Set(section.rows.map((r) => r.group)).size).toBe(12)
    const { c } = client({ 622320: LVIV17 })
    // <td rowspan="3">Львів</td> … <td>Двірцева</td><td>1</td>
    expect((await c.findGroup('uz-lviv', { city: 'Львів', street: 'Двірцева', house: '1' })).group).toBe(
      '1.1',
    )
    expect((await c.findGroup('uz-lviv', { city: 'Красне', street: 'Буська', house: '5' })).group).toBe('4.2')
  })

  it('says so when the page cannot settle a house', async () => {
    const { c } = client({ 622320: LVIV17 })
    // Родатичі, Залізнична: "1, 1 4, 5 1, 5 3,7, 7 1, 7 2, 7 5, 9,19,…"
    const at = (house: string) => c.findGroup('uz-lviv', { city: 'Родатичі', street: 'Залізнична', house })
    expect((await at('9')).group).toBe('1.2')
    await expect(at('5')).rejects.toThrow(/"5 1", "5 3", "7 5", which doesn't say whether 5 is included/)
    // "5 1" is not house 51 either
    await expect(at('51')).rejects.toMatchObject({ code: 'not-found' })
    await expect(at('100')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('reads a table with an empty leading column (Rivne) and drops rows it cannot place', () => {
    const section = parseUzAddresses(RIVNE17)!
    expect(section.rows).toHaveLength(186)
    // seven streets under an empty settlement cell right after a group header: whose are they?
    expect(section.unplaced).toBe(7)
    expect(section.rows.some((r) => r.street === 'Міцкевича' && r.group === '3.1')).toBe(false)
    expect(section.rows.every((r) => r.settlement && r.group)).toBe(true)
    // the "Примітка" table under the list is not part of it
    expect(section.rows.some((r) => /Відключення проводяться/.test(r.houses))).toBe(false)
  })

  it('joins a stray one-cell row to the house list above it (Khmelnytskyi)', () => {
    const section = parseUzAddresses(KHMELNYTSKYI17)!
    const row = section.rows.find((r) => /,149,153,155/.test(r.houses))!
    expect(row).toBeDefined()
    expect(parseUzHouses(row.houses).numbers).toContain('153')
    expect(section.rows).toHaveLength(136)
  })

  it('reads two-level headers (Dnipro) and both branches of a page (Vinnytsia)', async () => {
    const dnipro = parseUzAddresses(DNIPRO)!
    expect(new Set(dnipro.rows.map((r) => r.group)).size).toBe(12)
    const vinnytsia = parseUzAddresses(VINNYTSIA)!
    expect([...new Set(vinnytsia.rows.map((r) => r.branch))]).toEqual([
      'Південно-Західна залізниця',
      'Одеська залізниця',
    ])
    const { c } = client({ 622232: VINNYTSIA })
    const q = { city: 'Вапнярка', street: 'Українська', house: '21' }
    expect((await c.findGroup('uz-vinnytsia-odesa', q)).group).toBe('4.2')
    // "21, 23 – 44,60": 30 is inside the run
    expect((await c.findGroup('uz-vinnytsia-odesa', { ...q, house: '30' })).group).toBe('4.2')
    // the other branch's list doesn't have the town
    expect(await code(c.findGroup('uz-vinnytsia', q))).toBe('not-found')
  })

  it('reads the house cells as written, without guessing', () => {
    expect(parseUzHouses('1,10а,12,1а,3,5,5а').numbers).toEqual(['1', '10а', '12', '1а', '3', '5', '5а'])
    expect(parseUzHouses('1,1а;  3').numbers).toEqual(['1', '1а', '3'])
    expect(parseUzHouses('б/н')).toMatchObject({ unnumbered: true, numbers: [] })
    expect(parseUzHouses('')).toMatchObject({ unnumbered: true })
    expect(parseUzHouses('без номера').unnumbered).toBe(true)
    expect(parseUzHouses('всі').whole).toBe(true)
    // runs: mixed ends cover both sides, equal ends leave the other side open
    expect(parseUzHouses('1 - 52').ranges).toEqual([{ from: 1, to: 52, parity: 'all', text: '1 - 52' }])
    expect(parseUzHouses('1-31;').ranges[0]!.parity).toBe('same')
    expect(parseUzHouses('9-85 (непарні), 81А,  97, 113, ')).toMatchObject({
      ranges: [{ from: 9, to: 85, parity: 'odd' }],
      numbers: ['81А', '97', '113'],
    })
    expect(parseUzHouses('1 – 33неп.,87').ranges[0]).toMatchObject({ from: 1, to: 33, parity: 'odd' })
    // "335-0" is a number, not a run
    expect(parseUzHouses('300, 335-0, 320')).toMatchObject({ numbers: ['300', '335-0', '320'], ranges: [] })
    // letters continuing a number, dots typed for commas, notes in brackets, a trailing dot
    expect(parseUzHouses('13а,б,в').numbers).toEqual(['13а', '13б', '13в'])
    expect(parseUzHouses('2.3, 12а.28, 46.').numbers).toEqual(['2', '3', '12а', '28', '46'])
    expect(parseUzHouses('29(8 квартир), 312 (м)').numbers).toEqual(['29', '312'])
    expect(parseUzHouses('буд. 7, кв. 2').numbers).toEqual(['7'])
    expect(parseUzHouses('313 (Л-9, 27), 5').numbers).toEqual(['313', '5'])
    // not house numbers, or readable two ways: kept apart
    expect(parseUzHouses('123 км, 124 км, ФОП Сасюк М.К., 5 1, 47А 49А')).toMatchObject({
      numbers: [],
      unclear: ['123 км', '124 км', 'ФОП Сасюк М.К.', '5 1', '47А 49А'],
    })
  })

  it('compares house numbers without gluing their parts', () => {
    expect(uzHouseKey('12-А')).toBe(uzHouseKey('12 а'))
    expect(uzHouseKey('14A')).toBe('14а')
    expect(uzHouseKey('1/5')).not.toBe(uzHouseKey('15'))
    expect(uzHouseKey('5 1')).not.toBe(uzHouseKey('51'))
    expect(uzHouseKey('335-0')).not.toBe(uzHouseKey('3350'))
  })

  it('answers runs, unnumbered buildings and look-alike numbers exactly', async () => {
    const rows = [
      { branch: null, group: '1.1', settlement: 'с. Тест', street: 'Тиха', houses: '1 - 16' },
      { branch: null, group: '2.1', settlement: 'с. Тест', street: 'вул. Лугова', houses: '1-31; 40, 1/5' },
      { branch: null, group: '2.2', settlement: 'Тест', street: 'Лугова', houses: '2, 15, 1/5' },
      { branch: null, group: '3.1', settlement: 'с.Тест', street: 'Вокзальна', houses: 'б/н' },
      { branch: null, group: '3.2', settlement: 'с.Тест', street: 'пров. Вокзальний', houses: 'всі' },
    ]
    const provider = uzProvider({ id: 'uz-kyiv', oblast: 'Київ', page: 649725 })
    const dir = uzDirectory(rows)
    expect([...dir.cities.keys()]).toEqual(['тест'])
    const html = `<p>Перелік адрес</p><table><tr><td>Найменування населеного пункту</td><td>Найменування вулиці</td><td>№</td></tr>${rows
      .map(
        (r) =>
          `<tr><td colspan="3">${r.group.replace('.', ' черга ')} підчерга</td></tr><tr><td>${r.settlement}</td><td>${r.street}</td><td>${r.houses}</td></tr>`,
      )
      .join('')}</table>`
    const c = new OutageClient({
      fetch: mockFetch([{ match: '649725', body: html }]).fetch,
      now: () => NOW17,
      cacheTtlMs: 0,
      providers: [provider],
    })
    const at = (street: string, house: string) => c.findGroup('uz-kyiv', { city: 'Тест', street, house })
    expect((await at('Тиха', '7')).group).toBe('1.1')
    expect((await at('Тиха', '7а')).group).toBe('1.1')
    await expect(at('Тиха', '17')).rejects.toMatchObject({ code: 'not-found' })
    // "1-31": 3 for sure; 4 is not said, unless another row names it
    expect((await at('Лугова', '3')).group).toBe('2.1')
    await expect(at('Лугова', '4')).rejects.toThrow(/"1-31", which doesn't say whether 4 is included/)
    expect((await at('Лугова', '2')).group).toBe('2.2')
    // "15" is 15 (2.2, and inside 1-31), never "1/5"
    expect(await at('Лугова', '15')).toMatchObject({ group: '2.1', otherGroups: ['2.2'] })
    expect(await at('Лугова', '1/5')).toMatchObject({ group: '2.1', otherGroups: ['2.2'] })
    // a building without a number answers only for itself
    expect((await at('Вокзальна', 'б/н')).group).toBe('3.1')
    await expect(at('вул. Вокзальна', '5')).rejects.toMatchObject({ code: 'not-found' })
    expect((await at('пров. Вокзальний', '5')).group).toBe('3.2')
  })

  it('has no lookup where the page has no list, and degrades when a list disappears', async () => {
    const { c } = client({ 622384: KHERSON17, 649725: KHERSON17 })
    const caps = (id: RegionId) => c.regions().find((r) => r.id === id)!.capabilities
    expect(caps('uz-kherson')).toMatchObject({ addressSearch: false, streetSearch: false })
    expect(caps('uz-donetsk').addressSearch).toBe(false)
    expect(caps('uz-kyiv')).toMatchObject({ addressSearch: true, streetSearch: true })
    expect(c.regions().filter((r) => r.id.startsWith('uz-') && r.capabilities.addressSearch)).toHaveLength(24)
    expect(parseUzAddresses(KHERSON17)).toBeNull()
    const q = { city: 'Херсон', street: 'Залізнична', house: '2' }
    expect(await code(c.findGroup('uz-kherson', q))).toBe('unsupported')
    // the Kyiv page served without its section: a clear answer, not a crash
    expect(await code(c.findGroup('uz-kyiv', q))).toBe('unsupported')
    expectUnpublished(await c.getSchedules('uz-kherson'), 12)
  })

  it('has sample addresses that resolve', async () => {
    const { c } = client({ 649725: KYIV17, 622320: LVIV17, 622232: VINNYTSIA })
    const samples = UZ_PAGES.map(([id, oblast, page, branch]) => uzProvider({ id, oblast, page, branch }))
      .filter((p) => p.sampleAddress)
      .map((p) => [p.info.id, p.sampleAddress!] as const)
    expect(samples.map(([id]) => id)).toEqual(['uz-kyiv', 'uz-vinnytsia-odesa', 'uz-lviv'])
    for (const [id, address] of samples) expect((await c.findGroup(id, address)).group).toMatch(/^\d\.\d$/)
  })
})
