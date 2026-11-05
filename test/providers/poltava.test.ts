import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseFilials, parseGpvFragment } from '../../src/providers/poltava.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const C = 'https://www.poe.pl.ua/customs'

function client(result = 'poltava/result-11389-1004324-house-10.json') {
  const { fetch, calls } = mockFetch([
    { match: `${C}/dynamicgpv-info.php`, body: fixture('poltava/dynamicgpv-info-2026-11-05.trimmed.html') },
    { match: /poe\.pl\.ua\/$/, body: fixture('poltava/home-trimmed.html') },
    {
      match: `${C}/search-disconnection-cabinet.php`,
      method: 'POST',
      body: () => {
        const payload = JSON.parse(new URLSearchParams(String(calls.at(-1)!.init!.body)).get('disconn')!)
        if (payload.operation_type === 'city')
          return payload.filial_id === '123' ? fixture('poltava/search-city-filial-123.json') : '[]'
        if (payload.operation_type === 'street') return fixture('poltava/search-street-city-11389.json')
        return fixture('poltava/search-building-street-1004324.json')
      },
    },
    { match: `${C}/disconnectinforesult-cabinet.php`, method: 'POST', body: fixture(result) },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
}

describe('Poltavaoblenergo', () => {
  const s = parseGpvFragment(fixture('poltava/dynamicgpv-info-2026-11-05.trimmed.html'), NOW)

  it('reads both days and all groups', () => {
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('matches the operator’s own list of off periods', () => {
    const off = s.schedules['1.1']![0]!.intervals.filter((i) => i.kind === 'off').map(
      (i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)}`,
    )
    // from <ul class="gpv-periods"> on the same page
    expect(off).toEqual(['00:00–00:30', '05:00–09:00', '11:00–15:00', '17:00–21:00', '23:00–00:00'])
  })

  it('marks switching time as maybe', () => {
    expect(s.schedules['1.1']![0]!.intervals[1]).toEqual({
      from: '2026-11-05T00:30:00+02:00',
      to: '2026-11-05T01:00:00+02:00',
      kind: 'maybe',
    })
  })

  it('treats a notice without a table as no schedule', () => {
    expect(parseGpvFragment('<p>Відключення не застосовуються</p>', NOW).groups).toEqual([])
  })

  it('reads the district list', () => {
    expect(parseFilials(fixture('poltava/home-trimmed.html'))).toEqual([
      { id: '123', name: 'Полтавська об&#039;єднана філія' },
      { id: '115', name: 'Кременчуцька філія' },
    ])
  })

  it('finds a group by address', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('poltava', { city: 'Полтава', street: 'Європейська', house: '10' })
    expect(m).toEqual({
      region: 'poltava',
      group: '1.1',
      address: { city: 'місто Полтава', street: 'вул. Європейська', house: '10' },
    })
    const last = new URLSearchParams(String(calls.at(-1)!.init!.body)).get('disconn')
    expect(JSON.parse(last!)).toEqual({ cityid: '11389', streerid: '1004324', house: '10' })
  })

  it('explains buildings with several connections', async () => {
    await expect(
      client('poltava/result-11389-1004324-house-1-multiple-connections.json').client.findGroup('poltava', {
        city: 'Полтава',
        street: 'Європейська',
        house: '1',
      }),
    ).rejects.toThrow(/several connections/)
  })
})
