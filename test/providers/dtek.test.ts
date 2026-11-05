import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseDisconScript } from '../../src/providers/dtek.js'
import { gpvCellsToSlots, parseGpvDays, parseUaDateTime } from '../../src/providers/gpv.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const PAGE = 'https://www.dtek-oem.com.ua/ua/shutdowns'
const AJAX = 'https://www.dtek-oem.com.ua/ua/ajax'

function setup(page = fixture('dtek/shutdowns.trimmed.html')) {
  const { fetch, calls } = mockFetch([
    {
      match: PAGE,
      body: page,
      headers: { 'set-cookie': '_csrf-dtek-oem=abc; path=/; HttpOnly' },
    },
    { match: AJAX, method: 'POST', body: fixture('dtek/ajax-getHomeNum-odesa-varnenska.json') },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
}

describe('GPV hourly format', () => {
  it('maps half-hour codes', () => {
    expect(gpvCellsToSlots({ '1': 'second', '2': 'no', '3': 'first', '4': 'mfirst', '5': 'yes' })).toEqual([
      { start: 30, end: 60, kind: 'off' },
      { start: 60, end: 120, kind: 'off' },
      { start: 120, end: 150, kind: 'off' },
      { start: 180, end: 210, kind: 'maybe' },
    ])
  })

  it('treats [] as an empty schedule and keys days by Kyiv date', () => {
    expect(parseGpvDays('odesa', [])).toEqual({})
    // 1793829600 = 2026-11-05 00:00 Kyiv
    const days = parseGpvDays('odesa', { '1793829600': { 'GPV1.1': { '1': 'no' } } })
    expect(days['1.1']![0]!.date).toBe('2026-11-05')
  })

  it('parses both date-time orders', () => {
    expect(parseUaDateTime('05.11.2026 21:31')).toBe('2026-11-05T21:31:00+02:00')
    expect(parseUaDateTime('23:18 05.11.2026')).toBe('2026-11-05T23:18:00+02:00')
    expect(parseUaDateTime('')).toBeNull()
  })
})

describe('DTEK sites', () => {
  it('reads the embedded schedule', async () => {
    const s = await setup().client.getSchedule('odesa', '1.1')
    expect(s.updatedAt).toBe('2026-11-05T21:31:00+02:00')
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(s.days[0]!.intervals).toEqual([
      { from: '2026-11-05T00:30:00+02:00', to: '2026-11-05T04:30:00+02:00', kind: 'off' },
      { from: '2026-11-05T21:30:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' },
    ])
  })

  it('extracts the script variables', () => {
    const vars = parseDisconScript(fixture('dtek/shutdowns.trimmed.html'))
    expect(Object.keys(vars)).toEqual(
      expect.arrayContaining(['streets', 'preset', 'fact', 'currentWeekDayIndex']),
    )
  })

  it('finds a group by address with the session cookie and CSRF token', async () => {
    const { client, calls } = setup()
    const m = await client.findGroup('odesa', { city: 'Одеса', street: 'Варненська', house: '1' })
    expect(m.group).toBe('2.2')
    const post = calls.find((c) => c.url === AJAX)!
    const headers = post.init!.headers as Record<string, string>
    expect(headers.Cookie).toBe('_csrf-dtek-oem=abc')
    expect(headers['X-CSRF-Token']).toBeTruthy()
    expect(String(post.init!.body)).toContain('method=getHomeNum')
  })

  it('reports houses that belong to two groups', async () => {
    const m = await setup().client.findGroup('odesa', {
      city: 'м. Одеса',
      street: 'вул. Варненська',
      house: '18/3',
    })
    expect(m).toMatchObject({ group: '3.1', otherGroups: ['4.1'] })
  })

  it('reuses the page for searches instead of reloading it', async () => {
    const { client, calls } = setup()
    await client.searchCities('odesa', 'Одеса')
    await client.searchCities('odesa', 'Ізмаїл')
    expect(calls.filter((c) => c.url === PAGE)).toHaveLength(1)
  })

  it('says when bot protection answered', async () => {
    await expect(setup(fixture('dtek/blocked.html')).client.getSchedules('odesa')).rejects.toMatchObject({
      code: 'blocked',
    })
  })

  it('says when the page changed', async () => {
    await expect(
      setup('<html>' + 'x'.repeat(30_000) + '</html>').client.getSchedules('odesa'),
    ).rejects.toMatchObject({
      code: 'parse',
    })
  })
})
