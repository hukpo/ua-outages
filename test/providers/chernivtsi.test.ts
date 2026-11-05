import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { chernivtsiProvider, parseDirectory, parseSchedulePage } from '../../src/providers/chernivtsi.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:50:00+02:00')
const SITE = 'https://oblenergo.cv.ua'
const TODAY = fixture('chernivtsi/shutdowns-2026-11-05.html')
const EMPTY_DISTRICT =
  '<div id="obl_tbl" class="res_tbl"><div class="h_line"><s>Населений пункт</s><p>Вулиця</p><b>Будинок</b><u>Група</u></div><div><s>с. Десь</s><p>вул. Інша</p><b>буд. 1</b><u>1</u></div></div>'

function client(today = TODAY) {
  const { fetch, calls } = mockFetch([
    { match: `${SITE}/shutdowns/?next`, body: fixture('chernivtsi/shutdowns-next-2026-11-06.html') },
    { match: `${SITE}/shutdowns/`, body: today },
    { match: `${SITE}/shutdowns-search/1/`, body: fixture('chernivtsi/shutdowns-search-1.trimmed.html') },
    { match: `${SITE}/shutdowns-search/2/`, body: fixture('chernivtsi/shutdowns-search-2.trimmed.html') },
    { match: /\/shutdowns-search\/\d+\/$/, body: EMPTY_DISTRICT },
  ])
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [chernivtsiProvider()] }),
    calls,
  }
}

const hhmm = (i: { from: string; to: string; kind: string }) =>
  `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`

describe('Chernivtsioblenergo', () => {
  it('reads today and tomorrow for groups 1–12', async () => {
    const s = await client().client.getSchedules('chernivtsi')
    expect(s.groups).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('turns 48 half-hour cells into intervals, "мз" as maybe', async () => {
    const s = await client().client.getSchedule('chernivtsi', '1')
    expect(s.days[0]!.intervals.map(hhmm)).toEqual([
      '02:00–04:00 off',
      '04:00–04:30 maybe',
      '08:00–11:00 off',
      '11:00–11:30 maybe',
      '15:00–17:00 off',
      '17:00–17:30 maybe',
      '20:00–22:30 off',
      '22:30–23:00 maybe',
    ])
    const g12 = (await client().client.getSchedule('chernivtsi', '12')).days[1]!
    expect(g12.intervals.at(-1)).toEqual({
      from: '2026-11-06T22:30:00+02:00',
      to: '2026-11-07T00:00:00+02:00',
      kind: 'off',
    })
  })

  it('dates the time-only "актуальний станом на" with the page render date', async () => {
    expect((await client().client.getSchedules('chernivtsi')).updatedAt).toBe('2026-11-05T23:30:00+02:00')
    // rendered just after midnight: 23:30 was yesterday
    const html = TODAY.replace('Сторінку відкрито 05.11.2026 о 23:50', 'Сторінку відкрито 06.11.2026 о 00:10')
    expect(parseSchedulePage(html, NOW).updatedAt).toBe('2026-11-05T23:30:00+02:00')
  })

  it('fetches only today while tomorrow is not published', async () => {
    const { client: c, calls } = client(TODAY.replace('href="/shutdowns/?next"', 'href="#"'))
    await c.getSchedules('chernivtsi')
    expect(calls.map((x) => x.url)).toEqual([`${SITE}/shutdowns/`])
  })

  it('marks an all-clear day as no outages', () => {
    const allOn = TODAY.replace(/<o>в<\/o>|<s>мз<\/s>/g, '<u>з</u>')
    const page = parseSchedulePage(allOn, NOW)
    expect(Object.values(page.days).every((d) => d.status === 'no-outages' && d.intervals.length === 0)).toBe(
      true,
    )
  })

  it('rejects a changed format', () => {
    expect(() => parseSchedulePage('<html><body>Технічні роботи</body></html>', NOW)).toThrow(/#gsv/)
    expect(() => parseSchedulePage(TODAY.replace('<o>в</o>', ''), NOW)).toThrow(
      expect.objectContaining({ code: 'parse', message: expect.stringMatching(/47 cells/) }),
    )
  })

  it('finds a house in the city directory, merging street spellings', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('chernivtsi', {
      city: 'Чернівці',
      street: 'бульвар Героїв Крут',
      house: '22',
    })
    expect(m).toEqual({
      region: 'chernivtsi',
      group: '4',
      address: { city: 'м. Чернівці', street: 'бульвар ГЕРОЇВ КРУТ', house: '22' },
    })
    // the city of Chernivtsi needs only its own directory
    expect(calls.filter((x) => x.url.includes('shutdowns-search'))).toHaveLength(1)
  })

  it('finds a village house that belongs to two groups', async () => {
    const m = await client().client.findGroup('chernivtsi', {
      city: 'Чорногузи',
      street: 'Ярослава Мудрого',
      house: '3',
    })
    expect(m).toEqual({
      region: 'chernivtsi',
      group: '7',
      otherGroups: ['9'],
      address: { city: 'с. Чорногузи', street: 'вул. ЯРОСЛАВА МУДРОГО', house: '3' },
    })
  })

  it('skips GUID rows and unifies the case of settlement names', () => {
    const city = parseDirectory(fixture('chernivtsi/shutdowns-search-1.trimmed.html'), 1, 'Чернівці')
    const streets = [...city.cities.values()][0]!.streets
    expect([...streets.values()].some((s) => /[0-9a-f]{8}-/.test(s.street.name))).toBe(false)
    const district = parseDirectory(fixture('chernivtsi/shutdowns-search-2.trimmed.html'), 2, 'Вижницька')
    const names = [...district.cities.values()].map((c) => c.city.name)
    expect(names).toContain('м. Вижниця')
    expect(names.filter((n) => n.toLowerCase() === 'м. вижниця')).toHaveLength(1)
  })

  it('reports an unknown house with the closest numbers', async () => {
    await expect(
      client().client.findGroup('chernivtsi', {
        city: 'Чернівці',
        street: 'бульвар Героїв Крут',
        house: '999',
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})
