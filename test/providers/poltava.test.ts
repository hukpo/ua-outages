import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { parseFilials, parseGpvFragment, poltavaOutage } from '../../src/providers/poltava.js'
import { expectUnpublished, fixture, mockFetch } from '../helpers.js'

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

  it('reads the operator\'s change time: the newest "Оновлено:" of the day blocks', async () => {
    // the 5.11 block says "Оновлено: 5 листопада 2026 21:22", the 6.11 one "… 20:18"
    expect(s.updatedAt).toBe('2026-11-05T21:22:00+02:00')
    expect((await client().client.getSchedules('poltava')).updatedAt).toBe('2026-11-05T21:22:00+02:00')
    const html = fixture('poltava/dynamicgpv-info-2026-11-05.trimmed.html')
    // "Зараз 23:36" on the page is the render time, not a change time
    expect(parseGpvFragment(html.replace(/Оновлено:/g, 'Станом на:'), NOW).updatedAt).toBeNull()
    expect(parseGpvFragment(html.replace('21:22', '25:61'), NOW).updatedAt).toBe('2026-11-05T20:18:00+02:00')
  })

  it('never dates an old fragment today: every block carries its own date', () => {
    const later = new Date('2026-11-08T09:00:00+02:00')
    const old = parseGpvFragment(fixture('poltava/dynamicgpv-info-2026-11-05.trimmed.html'), later)
    expect(old.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(assessFreshness(old, { now: later })).toMatchObject({
      state: 'stale',
      today: 'missing',
      coveredThrough: '2026-11-06',
    })
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

  it('treats a notice without a table as nothing published: twelve groups, every day unknown', () => {
    expectUnpublished(parseGpvFragment('<p>Відключення не застосовуються</p>', NOW), 12)
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

describe('Poltava getHouseOutage: the status line of the address', () => {
  const RESULT = JSON.parse(fixture('poltava/result-11389-1004324-house-10.json'))[0]

  it('a ГПВ outage, with its start and expected end', () => {
    expect(poltavaOutage(RESULT)).toEqual({
      kind: 'scheduled',
      reason:
        'зареєстрована перерва в електропостачанні внаслідок застосування графіку погодинних відключень (ГПВ) 05.11.2026 р. з 23 годин(и) 00 хвилин(и). Очікуваний час закінчення перерви в електропостачанні: 06.11.2026 р. о 02 годин(и) 00 хвилин(и).',
      scheduleApplies: true,
      from: '2026-11-05T23:00:00+02:00',
      to: '2026-11-06T02:00:00+02:00',
    })
  })

  it('"не зареєстровано перерв": none', () => {
    const none = JSON.parse(fixture('poltava/result-gav-message-samples.json'))
    const rows = Object.values(none).flatMap((v) => (v as { response?: unknown[] }).response ?? [])
    const quiet = rows.find((r) => (r as { message_type?: number }).message_type === 0)
    expect(quiet).toBeDefined()
    expect(poltavaOutage(quiet as never)).toBeNull()
    expect(poltavaOutage({ fn_accident_message: '', message_type: 0 })).toBeNull()
  })

  it('wording not seen yet is `other`, never a guessed emergency', () => {
    const gav = {
      fn_accident_message:
        'зареєстрована перерва в електропостачанні внаслідок застосування графіку аварійних відключень (ГАВ) 17.11.2026 р. з 10 годин(и) 40 хвилин(и).',
      message_type: 5,
      accident_str: '17.11.2026 10:40',
    }
    expect(poltavaOutage(gav)).toMatchObject({
      kind: 'other',
      reason: gav.fn_accident_message,
      scheduleApplies: null,
      from: '2026-11-17T10:40:00+02:00',
      to: null,
    })
    expect(poltavaOutage({ message_type: 3 })).toMatchObject({ kind: 'other', reason: 'message_type 3' })
  })

  it('reads the same answer as findGroup, once per house while it is fresh', async () => {
    const { client: c, calls } = client()
    expect(c.region('poltava').capabilities.houseOutage).toBe(true)
    const address = { city: 'Полтава', street: 'Європейська', house: '10' }
    expect(await c.getHouseOutage('poltava', address)).toMatchObject({
      region: 'poltava',
      address: { city: 'місто Полтава', street: 'вул. Європейська', house: '10' },
      kind: 'scheduled',
      groups: ['1.1'],
      url: 'https://www.poe.pl.ua/disconnection/power-outages/',
    })
    await c.getHouseOutage('poltava', address)
    expect(calls.filter((x) => x.url.includes('disconnectinforesult'))).toHaveLength(1)
    await expect(
      client('poltava/result-11389-1004324-house-1-multiple-connections.json').client.getHouseOutage(
        'poltava',
        {
          ...address,
          house: '1',
        },
      ),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})
