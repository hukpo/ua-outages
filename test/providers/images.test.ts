import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { decodePng } from '../../src/image/png.js'
import { readScheduleTable } from '../../src/image/table.js'
import { latestImages } from '../../src/providers/khmelnytskyi.js'
import { latestGraphs } from '../../src/providers/volyn.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, fixtureBytes, mockFetch } from '../helpers.js'

const NOW = new Date('2026-10-17T19:00:00+03:00')
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

describe('PNG decoding', () => {
  it('decodes an RGBA screenshot and an RGB export', () => {
    const k = decodePng(fixtureBytes('khmelnytskyi/gpv-2026-10-17-1650.png'))
    expect([k.width, k.height]).toEqual([1920, 1021])
    const v = decodePng(fixtureBytes('volyn/gpv-2026-10-17-1847.png'))
    expect([v.width, v.height]).toEqual([1750, 2250])
  })

  it('rejects other files', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/)
  })
})

describe('Khmelnytskoblenergo image schedule', () => {
  function client() {
    const { fetch, calls } = mockFetch([
      {
        match: '/page/arhiv-grafikiv-pogodinnih-vidkljuchen-2026',
        body: fixture('khmelnytskyi/archive-2026.html'),
      },
      // the newest upload of the day is a text announcement, not the table
      {
        match: 'file20261017165858753.png',
        body: fixtureBytes('khmelnytskyi/announcement-2026-10-17-1658.png'),
      },
      { match: 'file20261017164437203.png', body: fixtureBytes('khmelnytskyi/gpv-2026-10-17-1650.png') },
    ])
    return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
  }

  it('reads the table, skipping an announcement image posted later', async () => {
    const s = await client().client.getSchedules('khmelnytskyi')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-10-17'])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['16:00-19:00'])
    expect(hhmm(s.schedules['3.1']![0]!)).toEqual(['10:00-13:00', '19:00-22:00'])
    expect(hhmm(s.schedules['6.2']![0]!)).toEqual(['14:00-16:00'])
    expect(s.updatedAt).toBe('2026-10-17T16:44:00+03:00')
  })

  it('lists images per date, newest first', () => {
    const dates = latestImages(fixture('khmelnytskyi/archive-2026.html'), '2026-10-17')
    expect(dates.map((d) => d.date)).toEqual(['2026-10-17'])
    expect(dates[0]!.images.map((i) => i.path.slice(-25))).toEqual([
      'file20261017165858753.png',
      'file20261017164437203.png',
      'file20261017104940210.png',
      'file20261017100602968.png',
    ])
  })

  it('is empty when nothing is published for today or later', async () => {
    const s = await new OutageClient({
      fetch: mockFetch([{ match: '/page/arhiv', body: fixture('khmelnytskyi/archive-2026.html') }]).fetch,
      now: () => new Date('2026-11-05T12:00:00+02:00'),
      cacheTtlMs: 0,
    }).getSchedules('khmelnytskyi')
    expect(s.groups).toEqual([])
  })

  it('reports a date whose images hold no table', async () => {
    const { fetch } = mockFetch([
      { match: '/page/arhiv', body: fixture('khmelnytskyi/archive-2026.html') },
      { match: '.png', body: fixtureBytes('khmelnytskyi/announcement-2026-10-17-1658.png') },
    ])
    await expect(
      new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }).getSchedules('khmelnytskyi'),
    ).rejects.toMatchObject({ code: 'parse' })
  })
})

describe('Volynoblenergo image schedule', () => {
  function client() {
    const { fetch } = mockFetch([
      { match: '/api/archive_gpv_graphs', body: fixture('volyn/archive_gpv_graphs-2026-10-17.json') },
      { match: '6ad3988b22570_GPV.png', body: fixtureBytes('volyn/gpv-2026-10-17-1847.png') },
    ])
    return new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 })
  }

  it('reads both half-day tables in half-hour steps', async () => {
    const s = await client().getSchedules('volyn')
    expect(s.groups).toHaveLength(12)
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['10:00-14:00'])
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual(['14:00-17:30'])
    expect(hhmm(s.schedules['3.1']![0]!)).toEqual(['11:00-14:00'])
    expect(hhmm(s.schedules['6.2']![0]!)).toEqual(['21:00-22:00'])
    expect(s.updatedAt).toBe('2026-10-17T18:47:00+03:00')
  })

  it('takes the newest image per date', () => {
    const dates = latestGraphs(JSON.parse(fixture('volyn/archive_gpv_graphs-2026-10-17.json')), '2026-10-17')
    expect(dates[0]!.images[0]!.path).toBe('/media/2026/10/6ad3988b22570_GPV.png')
  })

  it('rejects a changed archive', () => {
    expect(() => latestGraphs({ foo: 1 }, '2026-10-17')).toThrow(/expected a list/)
  })
})

describe('table reader', () => {
  it('refuses colours outside the palette instead of guessing', () => {
    const img = decodePng(fixtureBytes('volyn/gpv-2026-10-17-1847.png'))
    expect(() =>
      readScheduleTable(img, {
        columns: 24,
        rows: 12,
        tables: 2,
        halves: false,
        palette: { on: [0, 255, 0], off: [255, 0, 0] },
      }),
    ).toThrow(/unexpected cell colour/)
  })
})
