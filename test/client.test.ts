import { describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import type { Provider } from '../src/providers/provider.js'
import { makeDay } from '../src/schedule.js'
import type { RegionSchedule } from '../src/types.js'

const NOW = new Date('2026-11-05T10:00:00+02:00')

function fakeProvider(over: Partial<Provider> = {}): Provider {
  const schedule = (): RegionSchedule => ({
    region: 'kyiv',
    groups: ['1.1', '1.2'],
    schedules: {
      '1.1': [makeDay('2026-11-05', [{ start: 480, end: 720, kind: 'off' }])],
      '1.2': [makeDay('2026-11-05', [])],
    },
    updatedAt: '2026-11-05T07:00:00+02:00',
    fetchedAt: NOW.toISOString(),
  })
  return {
    info: {
      id: 'kyiv',
      name: 'Київ',
      operator: 'Test',
      website: 'https://example.com',
      capabilities: { schedule: true, addressSearch: true },
    },
    sampleAddress: { street: 'Хрещатик', house: '1' },
    getSchedules: vi.fn(async () => schedule()),
    searchStreets: async () => [
      { id: 's1', name: 'вул. Хрещатик' },
      { id: 's2', name: 'пров. Хрещатий' },
    ],
    searchHouses: async (_ctx, street) => [
      { id: 'h1', number: '1', streetId: street.id },
      { id: 'h2', number: '1-А', streetId: street.id },
    ],
    groupOf: async (_ctx, house, street) => ({
      region: 'kyiv',
      group: house.id === 'h2' ? '1.2' : '1.1',
      address: { street: street.name, house: house.number },
    }),
    ...over,
  }
}

const client = (p: Provider, opts = {}) => new OutageClient({ providers: [p], now: () => NOW, ...opts })

describe('OutageClient', () => {
  it('returns one group and accepts loose names', async () => {
    const s = await client(fakeProvider()).getSchedule('kyiv', 'GPV1.1')
    expect(s.group).toBe('1.1')
    expect(s.days[0]!.intervals).toHaveLength(1)
  })

  it('explains an unknown group', async () => {
    await expect(client(fakeProvider()).getSchedule('kyiv', '9.9')).rejects.toThrow(/Known groups: 1.1, 1.2/)
  })

  it('caches and dedupes schedule requests', async () => {
    const p = fakeProvider()
    const c = client(p)
    await Promise.all([c.getSchedules('kyiv'), c.getSchedules('kyiv')])
    await c.getSchedules('kyiv')
    expect(p.getSchedules).toHaveBeenCalledTimes(1)
    await c.getSchedules('kyiv', { fresh: true })
    expect(p.getSchedules).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    let n = 0
    const p = fakeProvider({
      getSchedules: async () => {
        if (n++ === 0) throw new OutageError('network', 'down')
        return fakeProvider().getSchedules({} as never)
      },
    })
    const c = client(p)
    await expect(c.getSchedules('kyiv')).rejects.toThrow('down')
    await expect(c.getSchedules('kyiv')).resolves.toBeTruthy()
  })

  it('finds a group by address with loose spelling', async () => {
    const c = client(fakeProvider())
    expect((await c.findGroup('kyiv', { street: 'Хрещатик', house: '1' })).group).toBe('1.1')
    expect((await c.findGroup('kyiv', { street: 'вулиця Хрещатик', house: '1а' })).group).toBe('1.2')
  })

  it('reports a missing house with nearby options', async () => {
    await expect(
      client(fakeProvider()).findGroup('kyiv', { street: 'Хрещатик', house: '99' }),
    ).rejects.toThrow(/Closest: 1, 1-А/)
  })

  it('refuses address search where the operator has none', async () => {
    const p = fakeProvider({ searchStreets: undefined })
    await expect(client(p).findGroup('kyiv', { street: 'x', house: '1' })).rejects.toMatchObject({
      code: 'unsupported',
    })
  })

  it('health check reports ok, stale, empty and error', async () => {
    const ok = await client(fakeProvider()).healthCheck({ address: true })
    expect(ok.ok).toBe(true)
    expect(ok.regions[0]).toMatchObject({ status: 'ok', groups: 2, address: { ok: true, group: '1.1' } })

    const stale = await client(fakeProvider(), {
      now: () => new Date('2026-11-20T10:00:00+02:00'),
    }).healthCheck()
    expect(stale.regions[0]!.status).toBe('stale')

    const empty = await client(
      fakeProvider({
        getSchedules: async () => ({
          region: 'kyiv',
          groups: [],
          schedules: {},
          updatedAt: null,
          fetchedAt: NOW.toISOString(),
        }),
      }),
    ).healthCheck()
    expect(empty.regions[0]!.status).toBe('empty')
    expect(empty.ok).toBe(true)

    const broken = await client(
      fakeProvider({
        getSchedules: async () => {
          throw new OutageError('parse', 'format changed')
        },
      }),
    ).healthCheck()
    expect(broken.ok).toBe(false)
    expect(broken.regions[0]).toMatchObject({ status: 'error', message: 'parse: format changed' })
  })
})

describe('Http', () => {
  it('decodes windows-1251 pages', async () => {
    const { Http } = await import('../src/http.js')
    const bytes = new Uint8Array([0xd7, 0xe5, 0xf0, 0xe3, 0xe0]) // "Черга"
    const http = new Http({ fetch: async () => new Response(bytes) })
    expect(await http.text('https://x.test', { encoding: 'windows-1251' })).toBe('Черга')
  })

  it('classifies bot checks, HTTP errors and timeouts', async () => {
    const { Http } = await import('../src/http.js')
    const blocked = new Http({
      fetch: async () => new Response('<script src="/_Incapsula_Resource?x=1"></script>'),
    })
    await expect(blocked.text('https://x.test')).rejects.toMatchObject({ code: 'blocked' })
    const notFound = new Http({ fetch: async () => new Response('nope', { status: 404 }) })
    await expect(notFound.text('https://x.test')).rejects.toMatchObject({
      code: 'http',
      details: { status: 404 },
    })
    let n = 0
    const flaky = new Http({
      retries: 1,
      fetch: async () => (n++ === 0 ? new Response('', { status: 502 }) : new Response('ok')),
    })
    expect(await flaky.text('https://x.test')).toBe('ok')
    const slow = new Http({
      timeoutMs: 20,
      retries: 0,
      fetch: (_u, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
        ),
    })
    await expect(slow.text('https://x.test')).rejects.toMatchObject({ code: 'network' })
  })
})

describe('regions without a machine-readable schedule', () => {
  it('are reported as empty, not broken', async () => {
    const p = fakeProvider({
      getSchedules: async () => {
        throw new OutageError('unsupported', 'image only')
      },
    })
    ;(p.info.capabilities as { schedule: boolean }).schedule = false
    const r = await client(p).healthCheck({ address: true })
    expect(r.ok).toBe(true)
    expect(r.regions[0]).toMatchObject({ status: 'empty', address: { ok: true } })
  })
})

describe('direct address lookup', () => {
  it('is used instead of the search chain', async () => {
    const p = fakeProvider({
      searchStreets: undefined,
      lookupAddress: async (_ctx, a) => ({
        region: 'kyiv',
        group: '4.2',
        address: { street: a.street, house: a.house },
      }),
    })
    expect((await client(p).findGroup('kyiv', { street: 'Будь-яка', house: '1' })).group).toBe('4.2')
  })

  it('lets providers treat some statuses as answers', async () => {
    const { Http } = await import('../src/http.js')
    const http = new Http({ fetch: async () => new Response('{"error":"not found"}', { status: 404 }) })
    expect(await http.json('https://x.test', { acceptStatus: [404] })).toEqual({ error: 'not found' })
    const raw = await http.raw('https://x.test', { acceptStatus: [404] })
    expect(raw.status).toBe(404)
  })
})

describe('villages with the same name', () => {
  const twoVillages = () =>
    fakeProvider({
      searchCities: async () => [
        { id: 'c1', name: 'с. Хмелівка', district: 'Красилівська громада' },
        { id: 'c2', name: 'с. Хмелівка', district: 'Старокостянтинівська громада' },
      ],
      searchStreets: async (_ctx, _q, city) => [
        { id: `s-${city!.id}`, name: 'вул. Центральна', cityId: city!.id },
      ],
      groupOf: async (_ctx, house, street) => ({
        region: 'kyiv',
        group: street.cityId === 'c2' ? '2.2' : '1.1',
        address: { street: street.name, house: house.number },
      }),
    })

  it('asks for a district and names them', async () => {
    await expect(
      client(twoVillages()).findGroup('kyiv', { city: 'Хмелівка', street: 'Центральна', house: '1' }),
    ).rejects.toThrow(/Старокостянтинівська громада.*pass a district/)
  })

  it('uses the district to pick one', async () => {
    const m = await client(twoVillages()).findGroup('kyiv', {
      city: 'Хмелівка',
      district: 'Старокостянтинівська',
      street: 'Центральна',
      house: '1',
    })
    expect(m.group).toBe('2.2')
  })
})
