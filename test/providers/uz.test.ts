import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseUzPage, uzProvider } from '../../src/providers/uz.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-08T14:00:00+02:00')
const KYIV = fixture('uz/kyiv.2026-11-08.html')
const VINNYTSIA = fixture('uz/vinnytsia.2026-11-08.html')
const DNIPRO = fixture('uz/dnipro.2026-11-08.html')
const VOLYN = fixture('uz/volyn.2026-11-08.html')

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

  it('has no groups when no schedule is published', () => {
    const s = parseUzPage(VOLYN, NOW, 'uz-volyn')
    expect(s.groups).toEqual([])
    expect(s.schedules).toEqual({})
  })
})
