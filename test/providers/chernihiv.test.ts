import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseChernihivText } from '../../src/providers/chernihiv.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, fixtureBytes, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T12:00:00+02:00')
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
// what an OCR engine / vision model returns for the 05.11.2026 image (transcribed from the fixture)
const OCR_TEXT = fixture('chernihiv/ocr-2026-11-05.txt')

describe('Chernihivoblenergo', () => {
  it('reads the cards from OCR text', () => {
    const s = parseChernihivText(OCR_TEXT, NOW)
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']![0]!.date).toBe('2026-11-05')
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['00:00-02:30', '09:30-16:30', '20:00-00:00'])
    expect(hhmm(s.schedules['5.2']![0]!)).toEqual(['02:30-09:30', '13:00-20:00'])
  })

  it('also accepts one line per group', () => {
    const text =
      '05.11.2026\n' +
      ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']
        .map((g) => `${g}: 00:00 - 02:30, 09:30 - 16:30`)
        .join('\n')
    expect(hhmm(parseChernihivText(text, NOW).schedules['6.2']![0]!)).toEqual(['00:00-02:30', '09:30-16:30'])
  })

  it('refuses incomplete recognition', () => {
    expect(() => parseChernihivText('05.11.2026\n1.1\n00:00 - 02:30', NOW)).toThrow(/1 of 12 groups/)
    expect(() => parseChernihivText('1.1\n00:00 - 02:30', NOW)).toThrow(/no date/)
  })

  it('sends the image to the app’s OCR function', async () => {
    const { fetch } = mockFetch([
      { match: 'schedule_groups.jpg', body: fixtureBytes('chernihiv/schedule_groups-2026-11-05.jpg') },
    ])
    let got: { mimeType: string; size: number } | null = null
    const c = new OutageClient({
      fetch,
      now: () => NOW,
      cacheTtlMs: 0,
      ocr: async ({ bytes, mimeType }) => {
        got = { mimeType, size: bytes.length }
        return OCR_TEXT
      },
    })
    expect((await c.getSchedule('chernihiv', '2.2')).days[0]!.intervals).toHaveLength(2)
    expect(got).toMatchObject({ mimeType: 'image/jpeg' })
    expect(got!.size).toBeGreaterThan(10_000)
  })

  it('without OCR it says what is missing, and the health check is not an error', async () => {
    const c = new OutageClient({ fetch: mockFetch([]).fetch, now: () => NOW, cacheTtlMs: 0 })
    await expect(c.getSchedules('chernihiv')).rejects.toMatchObject({ code: 'unsupported' })
    const h = await c.healthCheck({ regions: ['chernihiv'] })
    expect(h.ok).toBe(true)
    expect(h.regions[0]).toMatchObject({ status: 'empty', message: expect.stringMatching(/ocr/) })
  })
})
