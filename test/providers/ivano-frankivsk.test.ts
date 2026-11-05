import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseQueueSchedules, withoutTypes } from '../../src/providers/ivano-frankivsk.js'
import { ivanoFrankivskProvider } from '../../src/providers/ivano-frankivsk.js'
import { fixture, mockFetch } from '../helpers.js'

const API = 'https://be-svitlo.oe.if.ua'
const EMPTY = fixture('ivano-frankivsk/schedule-by-queue.1.1.current-empty.json')
// No schedule was active while this provider was written: this populated sample is
// RECONSTRUCTED from a third-party test fixture (odykyi-dev/shutdown-notification-bot, MIT),
// not a captured response. Its shape matches the TypeScript types of other API clients.
const POPULATED = fixture('ivano-frankivsk/schedule-by-queue.RECONSTRUCTED-populated.json')

function client(opts: { schedule?: string; search?: { file: string; status: number } } = {}) {
  const { fetch, calls } = mockFetch([
    { match: `${API}/schedule-by-queue?queue=4.2`, body: opts.schedule ?? EMPTY },
    { match: `${API}/schedule-by-queue?queue=`, body: EMPTY },
    {
      match: `${API}/schedule-by-search`,
      method: 'POST',
      body: fixture(`ivano-frankivsk/${opts.search?.file ?? 'schedule-by-search.found-single.json'}`),
      status: opts.search?.status ?? 200,
    },
  ])
  const now = () => new Date('2025-11-25T10:00:00+02:00')
  return {
    client: new OutageClient({ fetch, now, cacheTtlMs: 0, providers: [ivanoFrankivskProvider()] }),
    calls,
  }
}

describe('Prykarpattiaoblenergo', () => {
  it('asks for every group and reads the published intervals', async () => {
    const { client: c, calls } = client({ schedule: POPULATED })
    const s = await c.getSchedules('ivano-frankivsk')
    expect(calls.filter((x) => x.url.includes('schedule-by-queue'))).toHaveLength(12)
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['4.2']).toEqual([
      {
        date: '2025-11-25',
        status: 'scheduled',
        intervals: [{ from: '2025-11-25T16:30:00+02:00', to: '2025-11-25T20:00:00+02:00', kind: 'off' }],
      },
    ])
    // the day doesn't mention 1.1 at all
    expect(s.schedules['1.1']![0]!.status).toBe('unknown')
    expect(s.updatedAt).toBe('2025-11-24T19:52:00+02:00')
  })

  it('treats an empty group list on a published day as no outages', () => {
    const s = parseQueueSchedules(
      [
        [
          {
            eventDate: '25.11.2025',
            queues: { '1.1': [], '1.2': [{ from: '22:00', to: '24:00', status: 1 }] },
          },
        ],
      ],
      new Date(),
    )
    expect(s.schedules['1.1']![0]!.status).toBe('no-outages')
    expect(s.schedules['1.2']![0]!.intervals).toEqual([
      { from: '2025-11-25T22:00:00+02:00', to: '2025-11-26T00:00:00+02:00', kind: 'off' },
    ])
  })

  it('returns no groups when nothing is published', async () => {
    const s = await client().client.getSchedules('ivano-frankivsk')
    expect(s).toMatchObject({ groups: [], schedules: {}, updatedAt: null })
  })

  it('rejects a changed format', () => {
    expect(() => parseQueueSchedules([{ data: [] }], new Date())).toThrow(/expected a list of days/)
    expect(() => parseQueueSchedules([[{ date: '2025-11-25', queues: {} }]], new Date())).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('looks up a free-text address without type words', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('ivano-frankivsk', {
      city: 'м. Івано-Франківськ',
      street: 'вул. Галицька',
      house: '1',
    })
    expect(m).toEqual({
      region: 'ivano-frankivsk',
      group: '3.2',
      address: { city: 'Івано-Франківськ', street: 'Галицька', house: '1' },
    })
    const body = new URLSearchParams(String(calls.at(-1)!.init!.body))
    expect(body.get('address')).toBe('Івано-Франківськ,Галицька,1')
    expect(body.get('userSearchChoice')).toBe('pob')
  })

  it('reports every group of an address with several connections (HTTP 300)', async () => {
    const m = await client({
      search: { file: 'schedule-by-search.many-300.json', status: 300 },
    }).client.findGroup('ivano-frankivsk', { city: 'Івано-Франківськ', street: 'Незалежності', house: '2' })
    expect(m).toMatchObject({ group: '1.1', otherGroups: ['1.2'] })
  })

  it('turns HTTP 404 into not-found', async () => {
    await expect(
      client({ search: { file: 'schedule-by-search.not-found-404.json', status: 404 } }).client.findGroup(
        'ivano-frankivsk',
        {
          city: 'Калуш',
          street: 'Шевченка',
          house: '5',
        },
      ),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('needs a city', async () => {
    await expect(
      client().client.findGroup('ivano-frankivsk', { street: 'Галицька', house: '1' }),
    ).rejects.toThrow(/city/)
  })

  it('strips address type words but keeps case', () => {
    expect(withoutTypes('вул.Галицька')).toBe('Галицька')
    expect(withoutTypes('с. Крихівці')).toBe('Крихівці')
    expect(withoutTypes('Т. Шевченка вул.')).toBe('Т. Шевченка')
  })
})
