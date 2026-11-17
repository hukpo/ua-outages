import { describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import type { Provider } from '../src/providers/provider.js'
import { makeDay } from '../src/schedule.js'
import type { RegionSchedule } from '../src/types.js'
import type { StaleIfError } from '../src/index.js'

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

describe('forgiving street search', () => {
  /** A provider whose "server" only does exact substring search, like YASNO */
  function remoteProvider(calls: string[]) {
    const all = ['вул. Хрещатик', 'вул. Набережно-Хрещатицька', 'вул. Прорізна']
    return fakeProvider({
      remoteSearch: { streets: true },
      searchStreets: async (_ctx, q) => {
        calls.push(q)
        return all
          .filter((n) => n.toLowerCase().includes(q.toLowerCase()))
          .map((name, i) => ({ id: `s${i}${name}`, name }))
      },
    })
  }

  it('finds a misspelled street on a substring-only server through fragments', async () => {
    const calls: string[] = []
    const streets = await client(remoteProvider(calls)).searchStreets('kyiv', 'Хрищатик')
    expect(streets[0]!.name).toBe('вул. Хрещатик')
    expect(calls.length).toBeGreaterThan(1)
  })

  it('does not send fragments when the query already matches well', async () => {
    const calls: string[] = []
    await client(remoteProvider(calls)).searchStreets('kyiv', 'Прорізна')
    expect(calls).toEqual(['Прорізна'])
  })

  it('returns scores and respects the limit', async () => {
    const streets = await client(fakeProvider()).searchStreets('kyiv', 'Хрещ', { limit: 1 })
    expect(streets).toHaveLength(1)
    expect(streets[0]).toMatchObject({ name: 'вул. Хрещатик', score: expect.any(Number) })
  })

  it('findGroup accepts a misspelled street', async () => {
    expect((await client(fakeProvider()).findGroup('kyiv', { street: 'Крещатик', house: '1' })).group).toBe(
      '1.1',
    )
  })

  it('suggests streets when nothing is close enough', async () => {
    await expect(
      client(fakeProvider()).findGroup('kyiv', { street: 'Хрестовий', house: '1' }),
    ).rejects.toThrow(/Did you mean|No street matches/)
  })

  it('findGroup never takes a house that differs by a separator', async () => {
    const asked: string[] = []
    const p = fakeProvider({
      searchHouses: async (_ctx, street) =>
        ['2/3', '23', '4/1', '12-А', '7 к 2', '5 1', '30\\5'].map((number) => ({
          id: number,
          number,
          streetId: street.id,
        })),
      groupOf: async (_ctx, house, street) => {
        asked.push(house.number)
        return { region: 'kyiv', group: '1.1', address: { street: street.name, house: house.number } }
      },
    })
    const c = client(p)
    const find = (house: string) => c.findGroup('kyiv', { street: 'Хрещатик', house })
    // the fraction is listed first; "23" is the other house
    for (const house of ['23', '2/3', '2-3', '12а', '12 A', '7 корп. 2', '30/5']) await find(house)
    expect(asked).toEqual(['23', '2/3', '2/3', '12-А', '12-А', '7 к 2', '30\\5'])
    // 4/1 is listed and 41 is not; "5 1" is neither 51 nor 5/1
    for (const house of ['41', '51', '5/1', '72'])
      await expect(find(house)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('findGroup does not answer for a street with another number or of another type', async () => {
    const streets = (...names: string[]) =>
      client(fakeProvider({ searchStreets: async () => names.map((name) => ({ id: name, name })) }))
    const street = async (c: OutageClient, name: string) =>
      (await c.findGroup('kyiv', { street: name, house: '1' })).address.street
    const refused = (c: OutageClient, name: string) =>
      expect(c.findGroup('kyiv', { street: name, house: '1' })).rejects.toMatchObject({
        code: 'not-found',
        message: expect.stringMatching(/Did you mean/),
      })

    // a list without street types, like Chernihiv's
    const bare = streets('Миру', 'Шевченка', '8 Березня')
    expect(await street(bare, 'Миру')).toBe('Миру')
    expect(await street(bare, 'проспект Миру')).toBe('Миру')
    expect(await street(bare, 'вул. 8 березня')).toBe('8 Березня')
    await refused(bare, '2-й провулок Миру')
    await refused(bare, '1-й Шевченка')
    // the ordinal is the street's own
    const numbered = streets('2-й Миру', 'Садова')
    expect(await street(numbered, '2-й провулок Миру')).toBe('2-й Миру')
    await refused(numbered, 'Миру')

    const typed = streets('просп. Миру', 'Привокзальна площа')
    expect(await street(typed, 'Миру')).toBe('просп. Миру')
    expect(await street(typed, 'проспект Миру')).toBe('просп. Миру')
    await refused(typed, 'вулиця Миру')
    await refused(typed, 'провулок Миру')
    // a type written last
    expect(await street(typed, 'площа Привокзальна')).toBe('Привокзальна площа')
    await refused(typed, 'вул. Привокзальна')
    // both exist: the one asked for
    const both = streets('вул. Миру', 'просп. Миру')
    expect(await street(both, 'проспект Миру')).toBe('просп. Миру')
    expect(await street(both, 'вул. Миру')).toBe('вул. Миру')
    await expect(both.findGroup('kyiv', { street: 'Миру', house: '1' })).rejects.toThrow(/matches several/)
  })

  it('caches a directory between keystrokes', async () => {
    let n = 0
    const p = fakeProvider({
      searchStreets: async () => {
        n++
        return [{ id: 's1', name: 'вул. Хрещатик' }]
      },
    })
    const c = client(p)
    for (const q of ['Х', 'Хр', 'Хре', 'Хрещ']) await c.searchStreets('kyiv', q)
    expect(n).toBe(1)
  })
})

describe('staleIfError: the last good result instead of a failure', () => {
  /** A provider that works until `fail` is set, and a clock the test moves */
  function flaky() {
    const state = { fail: null as Error | null, now: NOW, calls: 0 }
    const good = fakeProvider()
    const p = fakeProvider({
      getSchedules: async (ctx) => {
        state.calls++
        if (state.fail) throw state.fail
        return { ...(await good.getSchedules(ctx)), fetchedAt: state.now.toISOString() }
      },
    })
    const make = (opts = {}) =>
      new OutageClient({ providers: [p], now: () => state.now, cacheTtlMs: 0, ...opts })
    return { state, make }
  }
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

  it('exports the option type', () => {
    const both: StaleIfError[] = [true, { maxAgeMs: 1000 }]
    expect(both).toHaveLength(2)
  })

  it('is off by default', async () => {
    const { state, make } = flaky()
    const c = make()
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    await expect(c.getSchedules('kyiv')).rejects.toThrow('down')
  })

  it('returns a copy of the last good result marked stale, for one group too', async () => {
    const { state, make } = flaky()
    const c = make()
    const good = await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    state.now = later(90)
    const s = await c.getSchedules('kyiv', { staleIfError: true })
    expect(s).toEqual({
      ...good,
      stale: { since: NOW.toISOString(), error: { code: 'network', message: 'down' } },
    })
    expect(good.stale).toBeUndefined()
    const g = await c.getSchedule('kyiv', '1.1', { staleIfError: true })
    expect(g.stale).toEqual(s.stale)
    expect(g.fetchedAt).toBe(NOW.toISOString())
  })

  it.each(['network', 'http', 'blocked', 'parse'] as const)('covers a %s error', async (code) => {
    const { state, make } = flaky()
    const c = make({ staleIfError: true })
    await c.getSchedules('kyiv')
    state.fail = new OutageError(code, 'x')
    expect((await c.getSchedules('kyiv')).stale!.error.code).toBe(code)
  })

  it('does not cover unsupported, not-found, a bug or a cancelled call', async () => {
    const { state, make } = flaky()
    const c = make({ staleIfError: true })
    await c.getSchedules('kyiv')
    for (const e of [
      new OutageError('unsupported', 'image only'),
      new OutageError('not-found', 'gone'),
      new TypeError('bug'),
    ]) {
      state.fail = e
      await expect(c.getSchedules('kyiv')).rejects.toBe(e)
    }
    // an unknown group is the caller's question, not a failure of the source
    state.fail = null
    await expect(c.getSchedule('kyiv', '9.9')).rejects.toMatchObject({ code: 'not-found' })
    state.fail = new OutageError('network', 'down')
    await expect(c.getSchedules('kyiv', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    })
    // cancelled while the fetch hangs: the reason, not the last good result
    let hang = false
    const good = fakeProvider()
    const hanging = client(
      fakeProvider({ getSchedules: (ctx) => (hang ? new Promise(() => {}) : good.getSchedules(ctx)) }),
      { staleIfError: true, cacheTtlMs: 0 },
    )
    await hanging.getSchedules('kyiv')
    hang = true
    const ctrl = new AbortController()
    const pending = hanging.getSchedules('kyiv', { signal: ctrl.signal })
    ctrl.abort(new Error('caller cap'))
    await expect(pending).rejects.toThrow('caller cap')
  })

  it('throws once the last good result is older than maxAgeMs (6 h by default)', async () => {
    const { state, make } = flaky()
    const c = make()
    await c.getSchedules('kyiv')
    state.fail = new OutageError('http', '503')
    state.now = later(6 * 60)
    await expect(c.getSchedules('kyiv', { staleIfError: true })).resolves.toHaveProperty('stale')
    state.now = later(6 * 60 + 1)
    await expect(c.getSchedules('kyiv', { staleIfError: true })).rejects.toThrow('503')
    await expect(
      c.getSchedules('kyiv', { staleIfError: { maxAgeMs: 24 * 3600_000 } }),
    ).resolves.toHaveProperty('stale')
    await expect(c.getSchedules('kyiv', { staleIfError: { maxAgeMs: 60_000 } })).rejects.toThrow('503')
    // an empty object means the default age
    state.now = later(60)
    await expect(c.getSchedules('kyiv', { staleIfError: {} })).resolves.toHaveProperty('stale')
  })

  it('a call can turn the client-wide default off', async () => {
    const { state, make } = flaky()
    const c = make({ staleIfError: { maxAgeMs: 3600_000 } })
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    await expect(c.getSchedules('kyiv')).resolves.toHaveProperty('stale')
    await expect(c.getSchedules('kyiv', { staleIfError: false })).rejects.toThrow('down')
  })

  it('has nothing to fall back on before the first success', async () => {
    const { state, make } = flaky()
    state.fail = new OutageError('network', 'down')
    await expect(make({ staleIfError: true }).getSchedules('kyiv')).rejects.toThrow('down')
  })

  it('uses `previous` after a restart, and the later of it and what it remembers', async () => {
    const { state, make } = flaky()
    const stored = JSON.parse(JSON.stringify(await make().getSchedules('kyiv'))) as RegionSchedule
    state.fail = new OutageError('blocked', 'bot check')
    state.now = later(30)
    const restarted = make()
    const s = await restarted.getSchedules('kyiv', { staleIfError: true, previous: stored })
    expect(s.stale).toEqual({ since: NOW.toISOString(), error: { code: 'blocked', message: 'bot check' } })
    expect(s.schedules).toEqual(stored.schedules)
    // `previous` without staleIfError changes nothing
    await expect(restarted.getSchedules('kyiv', { previous: stored })).rejects.toThrow('bot check')

    // the client's own memory is newer than what the app stored
    state.fail = null
    state.now = later(40)
    const own = await restarted.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    expect(
      (await restarted.getSchedules('kyiv', { staleIfError: true, previous: stored })).stale!.since,
    ).toBe(own.fetchedAt)
    // …and a stored one that is newer wins over the memory
    const newer = {
      ...stored,
      fetchedAt: later(50).toISOString(),
      stale: { since: 'x', error: { code: 'http' as const, message: 'old' } },
    }
    state.now = later(55)
    const t = await restarted.getSchedules('kyiv', { staleIfError: true, previous: newer })
    expect(t.stale).toEqual({ since: newer.fetchedAt, error: { code: 'network', message: 'down' } })
  })

  it('ignores a `previous` of another region or one that is not a valid schedule', async () => {
    const { state, make } = flaky()
    const stored = await make().getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    for (const previous of [
      { ...stored, region: 'lviv' as const },
      { ...stored, schedules: {} },
      { ...stored, fetchedAt: 'yesterday' },
      {} as RegionSchedule,
    ])
      await expect(make().getSchedules('kyiv', { staleIfError: true, previous })).rejects.toThrow('down')
  })

  it('never caches the stale answer as fresh: the operator is asked again and recovery shows', async () => {
    const { state, make } = flaky()
    const c = make({ staleIfError: true })
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    expect((await c.getSchedules('kyiv')).stale).toBeDefined()
    expect((await c.getSchedules('kyiv')).stale).toBeDefined()
    // cacheTtlMs 0: no pause between attempts
    expect(state.calls).toBe(3)
    state.fail = null
    const s = await c.getSchedules('kyiv')
    expect(s.stale).toBeUndefined()
    expect(state.calls).toBe(4)
  })

  it('with a cache, pauses retries for a minute at most; `fresh` and plain calls still ask', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW)
      const { state, make } = flaky()
      const c = make({ cacheTtlMs: 5 * 60_000 })
      await c.getSchedules('kyiv')
      state.fail = new OutageError('network', 'down')
      // the cached good result is served while its TTL lasts
      expect((await c.getSchedules('kyiv', { staleIfError: true })).stale).toBeUndefined()
      vi.setSystemTime(later(6))
      state.now = later(6)
      expect((await c.getSchedules('kyiv', { staleIfError: true })).stale).toBeDefined()
      expect(state.calls).toBe(2)
      // within the minute: the same stale answer, the operator isn't asked
      vi.setSystemTime(new Date(later(6).getTime() + 59_000))
      expect((await c.getSchedules('kyiv', { staleIfError: true })).stale).toBeDefined()
      expect(state.calls).toBe(2)
      // a call that didn't opt in asks, and gets the error
      await expect(c.getSchedules('kyiv')).rejects.toThrow('down')
      expect(state.calls).toBe(3)
      // `fresh` asks too
      expect((await c.getSchedules('kyiv', { staleIfError: true, fresh: true })).stale).toBeDefined()
      expect(state.calls).toBe(4)
      // after the minute it asks again; the source is back
      state.fail = null
      vi.setSystemTime(new Date(later(6).getTime() + 2 * 61_000))
      const s = await c.getSchedules('kyiv', { staleIfError: true })
      expect(s.stale).toBeUndefined()
      expect(state.calls).toBe(5)
      // and that success is cached as usual
      await c.getSchedules('kyiv', { staleIfError: true })
      expect(state.calls).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers every waiting caller on its own terms when they share one failed fetch', async () => {
    const { state, make } = flaky()
    const c = make({ cacheTtlMs: 60_000 })
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    const [a, b] = await Promise.allSettled([
      c.getSchedules('kyiv', { fresh: true, staleIfError: true }),
      c.getSchedules('kyiv', { fresh: true }),
    ])
    expect(a).toMatchObject({ status: 'fulfilled', value: { stale: { error: { code: 'network' } } } })
    expect(b.status).toBe('rejected')
  })

  it('answers a caller that joins a fetch still running with the last good result too', async () => {
    const { state, make } = flaky()
    const c = make({ staleIfError: true, cacheTtlMs: 60_000 })
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    // the second call finds the first one's fetch in the cache and waits on it
    const [a, b] = await Promise.allSettled([c.getSchedules('kyiv', { fresh: true }), c.getSchedules('kyiv')])
    expect(state.calls).toBe(2)
    for (const r of [a, b])
      expect(r).toMatchObject({ status: 'fulfilled', value: { stale: { error: { message: 'down' } } } })
    // …and one without staleIfError that joins still gets the error
    const [, d] = await Promise.allSettled([
      c.getSchedules('kyiv', { fresh: true }),
      c.getSchedules('kyiv', { staleIfError: false }),
    ])
    expect(d.status).toBe('rejected')
  })

  it('keeps the cached result when a `fresh` fetch fails', async () => {
    const { state, make } = flaky()
    const c = make({ cacheTtlMs: 60_000 })
    const good = await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    await expect(c.getSchedules('kyiv', { fresh: true })).rejects.toThrow('down')
    expect(state.calls).toBe(2)
    // still within the TTL: the operator that just failed isn't asked again
    expect(await c.getSchedules('kyiv')).toBe(good)
    expect(state.calls).toBe(2)
  })

  it('judges a `previous` by the later of its clock and the system clock, like a new result', async () => {
    const { state, make } = flaky()
    const stored = await make().getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    // the client's clock is set back (a replay); the stored result was changed two days after it
    const previous = { ...stored, updatedAt: later(48 * 60).toISOString() }
    expect(later(48 * 60).getTime()).toBeLessThan(Date.now())
    const s = await make().getSchedules('kyiv', { staleIfError: true, previous })
    expect(s.stale?.error.message).toBe('down')
  })

  it('the health check never uses it', async () => {
    const { state, make } = flaky()
    const c = make({ staleIfError: true })
    await c.getSchedules('kyiv')
    state.fail = new OutageError('network', 'down')
    const report = await c.healthCheck()
    expect(report).toMatchObject({ ok: false, stale: false, degraded: false })
    expect(report.regions[0]).toMatchObject({ status: 'error', message: 'network: down' })
    expect(report.regions[0]!.freshness).toBeUndefined()
  })
})

describe('health check: freshness and sources', () => {
  const withSchedule = (over: Partial<RegionSchedule>, days = [makeDay('2026-11-05', [])]) =>
    fakeProvider({
      getSchedules: async () => ({
        region: 'kyiv',
        groups: ['1.1'],
        schedules: { '1.1': days },
        updatedAt: '2026-11-05T07:00:00+02:00',
        fetchedAt: NOW.toISOString(),
        ...over,
      }),
    })
  const failedSource = {
    id: 'site',
    url: null,
    ok: false,
    dates: [],
    updatedAt: null,
    error: { code: 'blocked' as const, message: 'bot check' },
  }
  const okSource = {
    id: 'telegram:@x',
    url: 'https://t.me/s/x',
    ok: true,
    dates: ['2026-11-05'],
    updatedAt: null,
  }

  it('carries the freshness of what it fetched', async () => {
    const report = await client(fakeProvider()).healthCheck()
    expect(report).toMatchObject({ ok: true, stale: false, degraded: false })
    expect(report.regions[0]!.freshness).toEqual({
      state: 'fresh',
      today: 'published',
      tomorrow: 'missing',
      coveredThrough: '2026-11-05',
      ageMinutes: 180,
      fetchedMinutesAgo: 0,
      issues: [],
    })
    expect(report.regions[0]).not.toHaveProperty('sources')
    expect(report.regions[0]).not.toHaveProperty('degraded')
    expect(report.regions[0]).not.toHaveProperty('message')
  })

  it('reports a source stuck on a past day as stale, with the reasons', async () => {
    const p = withSchedule({ updatedAt: '2026-11-03T07:00:00+02:00' }, [makeDay('2026-11-04', [])])
    const report = await client(p).healthCheck()
    expect(report).toMatchObject({ ok: true, stale: true, degraded: false })
    expect(report.regions[0]).toMatchObject({
      status: 'stale',
      message: expect.stringMatching(/^The newest published day is 2026-11-04, .*; Not updated for 51 h/),
      freshness: { state: 'stale' },
    })
    expect((await client(p).healthCheck({ strict: true })).ok).toBe(false)
    // an old updatedAt alone is not stale while today is covered
    const ahead = await client(withSchedule({ updatedAt: '2026-11-01T07:00:00+02:00' })).healthCheck({
      strict: true,
    })
    expect(ahead.regions[0]!.status).toBe('ok')
    expect(ahead.ok).toBe(true)
  })

  it('does not call a region stale because its newest publication is a cancellation of today', async () => {
    const unknownToday = { date: '2026-11-05', status: 'unknown' as const, intervals: [] }
    const days = [makeDay('2026-11-04', []), unknownToday]
    const p = withSchedule({ sources: [okSource] }, days)
    const report = await client(p).healthCheck({ strict: true })
    expect(report).toMatchObject({ ok: true, stale: false })
    expect(report.regions[0]).toMatchObject({
      status: 'ok',
      freshness: { state: 'fresh', today: 'missing', coveredThrough: '2026-11-05' },
    })
    // a cancellation and nothing else is not "empty" either
    const only = await client(withSchedule({ sources: [okSource] }, [unknownToday])).healthCheck()
    expect(only.regions[0]!.status).toBe('ok')
    // no channel supplied today: stuck on yesterday, as before
    const behind = await client(withSchedule({}, days)).healthCheck({ strict: true })
    expect(behind).toMatchObject({ ok: false, stale: true })
  })

  it('passes staleAfterHours and tomorrowExpectedAt on', async () => {
    const p = withSchedule({ updatedAt: '2026-11-04T20:00:00+02:00' }, [makeDay('2026-11-06', [])])
    expect((await client(p).healthCheck()).regions[0]!.status).toBe('ok')
    expect((await client(p).healthCheck({ staleAfterHours: 12 })).regions[0]).toMatchObject({
      status: 'stale',
      message: expect.stringMatching(/^Not updated for 14 h/),
    })
    const late = await client(fakeProvider()).healthCheck({ tomorrowExpectedAt: '09:00', strict: true })
    // listed, but neither stale nor degraded
    expect(late.regions[0]!.freshness!.issues.map((i) => i.code)).toEqual(['tomorrow-missing'])
    expect(late.regions[0]!.status).toBe('ok')
    expect(late.ok).toBe(true)
  })

  it('marks a region that lost a source as degraded: ok unless strict', async () => {
    const p = withSchedule({ sources: [failedSource, okSource] })
    const report = await client(p).healthCheck()
    expect(report).toMatchObject({ ok: true, degraded: true, stale: false })
    expect(report.regions[0]).toMatchObject({
      status: 'ok',
      degraded: true,
      message: 'Failed: site (blocked: bot check)',
      sources: [failedSource, okSource],
    })
    expect((await client(p).healthCheck({ strict: true })).ok).toBe(false)
    // every source fine: sources are listed, nothing is degraded
    const fine = await client(withSchedule({ sources: [okSource] })).healthCheck({ strict: true })
    expect(fine).toMatchObject({ ok: true, degraded: false })
    expect(fine.regions[0]!.sources).toEqual([okSource])
    expect(fine.regions[0]).not.toHaveProperty('degraded')
  })

  it('keeps empty and stale apart from degraded, and says both', async () => {
    const empty = await client(
      withSchedule({ sources: [failedSource, { ...okSource, dates: [] }] }, [
        { date: '2026-11-05', status: 'unknown', intervals: [] },
      ]),
    ).healthCheck()
    expect(empty.regions[0]).toMatchObject({
      status: 'empty',
      degraded: true,
      message: 'No schedule published right now; Failed: site (blocked: bot check)',
      freshness: { state: 'unpublished' },
    })
    expect(empty).toMatchObject({ ok: true, degraded: true, stale: false })
    const stale = await client(
      withSchedule({ sources: [failedSource, okSource] }, [makeDay('2026-11-04', [])]),
    ).healthCheck()
    expect(stale.regions[0]).toMatchObject({ status: 'stale', degraded: true })
    expect(stale.regions[0]!.message).toMatch(/nothing for 2026-11-05 or later; Failed: site/)
    expect(stale).toMatchObject({ ok: true, degraded: true, stale: true })
  })

  it('strict still counts errors and failed address lookups', async () => {
    const p = fakeProvider({ sampleAddress: { street: 'Хрещатик', house: '99' } })
    const report = await client(p).healthCheck({ address: true, strict: true })
    expect(report.ok).toBe(false)
    expect(report.regions[0]).toMatchObject({ status: 'ok', address: { ok: false } })
  })
})
