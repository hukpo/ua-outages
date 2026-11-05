import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseDisconnections, rivneProvider } from '../../src/providers/rivne.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-02-10T21:00:00+02:00')
// Wayback Machine captures of the live page: the region had no outages when this was written
const FEB = fixture('rivne/disconnections.HISTORICAL-wayback-20260210.fragment.html')
const JAN = fixture('rivne/disconnections.HISTORICAL-wayback-20260111.fragment.html')
const CURRENT = fixture('rivne/disconnections.current-2026-11-05.fragment.html')

const hhmm = (i: { from: string; to: string }) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)}`

describe('Rivneoblenergo', () => {
  it('reads both dates and all twelve groups through the client', async () => {
    const { fetch } = mockFetch([{ match: 'https://www.roe.vsei.ua/disconnections', body: FEB }])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [rivneProvider()] })
    const s = await c.getSchedules('rivne')
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-02-10', '2026-02-11'])
    expect(s.updatedAt).toBe('2026-02-10T22:00:00+02:00')
  })

  it('maps "23:59" to midnight', () => {
    const day = parseDisconnections(FEB, NOW).schedules['1.1']![0]!
    expect(day.status).toBe('scheduled')
    expect(day.intervals.map(hhmm)).toEqual(['00:00–01:00', '03:00–09:00', '11:00–17:00', '19:00–00:00'])
    expect(day.intervals.at(-1)!.to).toBe('2026-02-11T00:00:00+02:00')
    expect(day.intervals.every((i) => i.kind === 'off')).toBe(true)
  })

  it('reads the columns in header order', () => {
    const s = parseDisconnections(JAN, NOW)
    expect(s.schedules['3.1']![0]!.intervals.map(hhmm)).toEqual(['00:00–03:00', '15:00–19:00'])
    expect(s.schedules['6.2']![0]!.intervals.map(hhmm)).toEqual(['11:00–15:00', '22:00–00:00'])
  })

  it('treats "Очікується" as not published yet', () => {
    expect(parseDisconnections(JAN, NOW).schedules['1.1']![1]).toEqual({ date: '2026-01-12', status: 'unknown', intervals: [] })
    const now = parseDisconnections(CURRENT, NOW)
    expect(Object.values(now.schedules).every((days) => days.every((d) => d.status === 'unknown'))).toBe(true)
    expect(now.updatedAt).toBe('2026-11-05T23:30:00+02:00')
  })

  it('rejects a changed format', () => {
    expect(() => parseDisconnections('<div>Сторінку переміщено</div>', NOW)).toThrow(/fetched-data-container/)
    expect(() => parseDisconnections(FEB.replace('Підчерга', 'Група'), NOW)).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('has no address search', async () => {
    const c = new OutageClient({ fetch: mockFetch([]).fetch, providers: [rivneProvider()] })
    expect(c.region('rivne').capabilities.addressSearch).toBe(false)
    await expect(c.findGroup('rivne', { street: 'Соборна', house: '1' })).rejects.toMatchObject({ code: 'unsupported' })
  })
})
