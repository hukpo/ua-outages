import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import { Http, type FetchLike } from '../src/http.js'
import { parseGpvDays } from '../src/providers/gpv.js'
import { scheduleFromImages } from '../src/providers/image-schedule.js'
import { ivanoFrankivskProvider } from '../src/providers/ivano-frankivsk.js'
import { kirovohradProvider } from '../src/providers/kirovohrad.js'
import type { Provider } from '../src/providers/provider.js'
import { postsToSchedule } from '../src/providers/posts.js'
import { ternopilProvider } from '../src/providers/ternopil.js'
import { parseGroupLines } from '../src/providers/ua-text.js'
import { kyivDate } from '../src/time.js'
import { unpublished } from '../src/schedule.js'
import type { RegionSchedule } from '../src/types.js'
import { mapLimit } from '../src/util.js'
import { fixture, mockFetch } from './helpers.js'

const IF_API = 'https://be-svitlo.oe.if.ua'
const IF_EMPTY = fixture('ivano-frankivsk/schedule-by-queue.1.1.current-empty.json')
const tick = () => new Promise((r) => setTimeout(r, 10))
// markers for "which fetch won"; real timestamps, since the client validates what providers return
const OLD = '2026-11-05T08:00:00+02:00'
const NEW = '2026-11-05T09:00:00+02:00'

/**
 * A fetch that never answers on its own: it records the call and settles only when its
 * request is aborted (or, with `ignoreSignal`, never).
 */
function hangingFetch(opts: { ignoreSignal?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init })
    return new Promise((_, reject) => {
      if (opts.ignoreSignal) return
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  }
  return { fetch, calls }
}

describe('cancellation', () => {
  const ifClient = (fetch: FetchLike) =>
    new OutageClient({ fetch, cacheTtlMs: 0, providers: [ivanoFrankivskProvider()] })

  it('rejects at once and sends nothing more when the caller aborts mid-way', async () => {
    const { fetch, calls } = hangingFetch()
    const ctrl = new AbortController()
    const pending = ifClient(fetch).getSchedules('ivano-frankivsk', { signal: ctrl.signal })
    await tick()
    const before = calls.length
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(12)
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    // the requests in flight were cancelled, and the remaining groups were never asked for
    for (const c of calls) expect(c.init?.signal?.aborted).toBe(true)
    await tick()
    expect(calls).toHaveLength(before)
  })

  it('rejects promptly even when the fetch ignores the signal', async () => {
    const { fetch, calls } = hangingFetch({ ignoreSignal: true })
    const ctrl = new AbortController()
    const pending = ifClient(fetch).getSchedules('ivano-frankivsk', { signal: ctrl.signal })
    await tick()
    const before = calls.length
    ctrl.abort(new Error('caller cap'))
    await expect(pending).rejects.toThrow('caller cap')
    await tick()
    expect(calls).toHaveLength(before)
  })

  it('sends no request at all with an already aborted signal', async () => {
    const { fetch, calls } = hangingFetch()
    await expect(
      ifClient(fetch).getSchedules('ivano-frankivsk', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      ifClient(fetch).getSchedule('ivano-frankivsk', '1.1', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(0)
  })

  it('stops between requests of a sequential loop', async () => {
    const ctrl = new AbortController()
    const { fetch: serve, calls } = mockFetch([
      { match: `${IF_API}/schedule-by-queue?queue=`, body: IF_EMPTY },
    ])
    // the caller's cap fires while the third response is on its way
    const fetch: FetchLike = (url, init) => {
      if (calls.length === 2) ctrl.abort()
      return serve(url, init)
    }
    const client = new OutageClient({
      fetch,
      cacheTtlMs: 0,
      providers: [ivanoFrankivskProvider()],
    })
    await expect(client.getSchedules('ivano-frankivsk', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await tick()
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it('does not retry an aborted request as a network error', async () => {
    const { fetch, calls } = hangingFetch()
    const ctrl = new AbortController()
    const http = new Http({ fetch, retries: 3 }).withSignal(ctrl.signal)
    const pending = http.text('https://example.ua/')
    await tick()
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    expect(calls).toHaveLength(1)
  })

  it('still times out on its own when the caller never aborts', async () => {
    const { fetch } = hangingFetch()
    const http = new Http({ fetch, retries: 0, timeoutMs: 20 }).withSignal(new AbortController().signal)
    await expect(http.text('https://example.ua/')).rejects.toMatchObject({ code: 'network' })
  })

  it('a cancelled call does not fail a concurrent one that shares the cache', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => (release = r))
    const { fetch: serve, calls } = mockFetch([
      { match: `${IF_API}/schedule-by-queue?queue=`, body: IF_EMPTY },
    ])
    const fetch: FetchLike = async (url, init) => {
      await gate
      init?.signal?.throwIfAborted()
      return serve(url, init)
    }
    const client = new OutageClient({ fetch, providers: [ivanoFrankivskProvider()] })
    const ctrl = new AbortController()
    const cancelled = client.getSchedules('ivano-frankivsk', { signal: ctrl.signal })
    const plain = client.getSchedules('ivano-frankivsk')
    ctrl.abort()
    release!()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await expect(plain).resolves.toMatchObject({ region: 'ivano-frankivsk' })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a cancelled call does not fail another waiting on the same shared session', async () => {
    const B = 'https://kiroe.com.ua/electricity-blackout'
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => (release = r))
    const { fetch: serve } = mockFetch([
      {
        match: /electricity-blackout$/,
        method: 'GET',
        body: fixture('kirovohrad/blackout-page-offices.html'),
        headers: { 'set-cookie': 'sess=1; path=/' },
      },
      {
        match: `${B}/actual-gpv-graphs`,
        method: 'POST',
        body: fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-05.json'),
      },
    ])
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('electricity-blackout')) await gate
      init?.signal?.throwIfAborted()
      return serve(url, init)
    }
    const client = new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T23:40:00+02:00'),
      cacheTtlMs: 0,
      providers: [kirovohradProvider()],
    })
    const ctrl = new AbortController()
    const cancelled = client.getSchedules('kirovohrad', { signal: ctrl.signal })
    await tick()
    const plain = client.getSchedules('kirovohrad')
    ctrl.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    release!()
    const s = await plain
    expect(s.groups.length).toBeGreaterThan(0)
  })

  it('stops a health check from starting more regions', async () => {
    const { fetch, calls } = hangingFetch()
    const ctrl = new AbortController()
    const client = new OutageClient({ fetch, cacheTtlMs: 0 })
    const pending = client.healthCheck({ concurrency: 2, signal: ctrl.signal })
    await tick()
    const before = calls.length
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    expect(calls).toHaveLength(before)
  })
})

describe('mapLimit', () => {
  it('starts nothing new after the first failure', async () => {
    const started: number[] = []
    const items = Array.from({ length: 12 }, (_, i) => i)
    await expect(
      mapLimit(items, 3, async (i) => {
        started.push(i)
        await tick()
        if (i === 0) throw new Error('blocked')
        return i
      }),
    ).rejects.toThrow('blocked')
    await tick()
    await tick()
    // the three already in flight finish; none of the other nine is started
    expect(started).toEqual([0, 1, 2])
  })

  it('still runs everything when nothing fails, keeping the order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })

  it('starts nothing new once the signal aborts', async () => {
    const ctrl = new AbortController()
    const started: number[] = []
    await expect(
      mapLimit(
        [0, 1, 2, 3, 4],
        1,
        async (i) => {
          started.push(i)
          if (i === 1) ctrl.abort()
          return i
        },
        ctrl.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual([0, 1])
  })

  it('a site that blocks the first group gets no further requests', async () => {
    const FIRST = /a_gpv_g\?.*group%5B%5D=1\.1/
    const { fetch: serve, calls } = mockFetch([
      // the first group is refused at once; the others would answer, a little later
      { match: FIRST, body: 'Forbidden', status: 403 },
      { match: 'https://api-poweron.toe.com.ua/api/a_gpv_g?', body: '{"hydra:member":null}' },
    ])
    const fetch: FetchLike = async (url, init) => {
      if (!FIRST.test(url)) await tick()
      return serve(url, init)
    }
    const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [ternopilProvider()] })
    await expect(client.getSchedules('ternopil')).rejects.toMatchObject({ code: 'blocked' })
    await tick()
    await tick()
    // three workers were in flight; before the fix all twelve groups were asked
    expect(calls.length).toBeLessThanOrEqual(3)
  })
})

describe('bot checks on error statuses', () => {
  const http = (body: string, status = 503) => {
    const m = mockFetch([{ match: 'https://example.ua/', body, status }])
    return { http: new Http({ fetch: m.fetch, retries: 2 }), calls: m.calls }
  }

  for (const file of ['incapsula-503.html', 'cloudflare-503.html'])
    it(`reports a challenge page served as 503 as blocked, without retrying (${file})`, async () => {
      const { http: h, calls } = http(fixture(`http/${file}`))
      const err = await h.text('https://example.ua/', { region: 'kyiv-region' }).catch((e) => e)
      expect(err).toBeInstanceOf(OutageError)
      expect(err).toMatchObject({ code: 'blocked', details: { status: 503, region: 'kyiv-region' } })
      expect(calls).toHaveLength(1)
    })

  it('treats a challenge on the binary path the same way', async () => {
    const { http: h, calls } = http(fixture('http/incapsula-503.html'))
    await expect(h.bytes('https://example.ua/')).rejects.toMatchObject({ code: 'blocked' })
    expect(calls).toHaveLength(1)
  })

  it('still retries an ordinary 503 and then reports it as an http error', async () => {
    const { http: h, calls } = http(fixture('http/server-error-503.html'))
    await expect(h.text('https://example.ua/')).rejects.toMatchObject({
      code: 'http',
      details: { status: 503 },
    })
    expect(calls).toHaveLength(3)
  })

  it('reports a 500 that recovers on retry as a normal answer', async () => {
    let n = 0
    const fetch: FetchLike = async () =>
      ++n === 1 ? new Response('oops', { status: 500 }) : new Response('{"ok":true}')
    await expect(new Http({ fetch }).json('https://example.ua/')).resolves.toEqual({ ok: true })
    expect(n).toBe(2)
  })
})

describe('a body that fails after the headers arrived', () => {
  const failing =
    (error: unknown): FetchLike =>
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('partial'))
            c.error(error)
          },
        }),
      )

  it('reports a timeout while reading the body as a network error, for text and bytes', async () => {
    const h = new Http({ fetch: failing(new DOMException('timed out', 'TimeoutError')), timeoutMs: 300 })
    for (const read of [
      h.text('https://example.ua/x', { region: 'lviv' }),
      h.bytes('https://example.ua/x', { region: 'lviv' }),
    ]) {
      const err = await read.catch((e) => e)
      expect(err).toBeInstanceOf(OutageError)
      expect(err).toMatchObject({ code: 'network', details: { region: 'lviv' } })
      expect(err.message).toBe('example.ua did not finish answering in 300 ms')
    }
  })

  it('reports a dropped connection the same way, and staleIfError covers it', async () => {
    const h = new Http({ fetch: failing(new TypeError('terminated')) })
    await expect(h.text('https://example.ua/x')).rejects.toMatchObject({
      code: 'network',
      message: 'example.ua dropped the connection',
    })

    let broken = false
    const fetch: FetchLike = (url, init) =>
      broken ? failing(new TypeError('terminated'))(url, init) : Promise.resolve(new Response('ok'))
    const provider: Provider = {
      info: {
        id: 'lviv',
        name: 'L',
        operator: 'o',
        website: 'w',
        capabilities: { schedule: true, addressSearch: false },
      },
      getSchedules: async (ctx) => {
        await ctx.http.text('https://example.ua/x', { region: 'lviv' })
        return unpublished('lviv', ['1.1'], ctx.now())
      },
    }
    const c = new OutageClient({ providers: [provider], fetch, cacheTtlMs: 0, staleIfError: true })
    await c.getSchedules('lviv')
    broken = true
    expect((await c.getSchedules('lviv')).stale?.error.code).toBe('network')
  })

  it("still rejects with the signal's reason when the call is cancelled mid-body", async () => {
    const ctrl = new AbortController()
    const fetch: FetchLike = async () => new Response(new ReadableStream({ start() {} }))
    const pending = new Http({ fetch }).withSignal(ctrl.signal).text('https://example.ua/x')
    await tick()
    ctrl.abort(new Error('user left'))
    await expect(pending).rejects.toThrow('user left')
    await expect(pending).rejects.not.toBeInstanceOf(OutageError)
  })
})

// Regressions for what the independent (GPT) review of this change found
describe('cancellation edge cases', () => {
  it('leaves no unhandled rejection when the abort lands while the fetch is failing', async () => {
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctrl = new AbortController()
      const fetch: FetchLike = () => {
        ctrl.abort()
        return Promise.reject(new Error('connection reset'))
      }
      const http = new Http({ fetch }).withSignal(ctrl.signal)
      await expect(http.text('https://example.ua/')).rejects.toMatchObject({ name: 'AbortError' })
      await tick()
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('cancels a shared session load (and its retry) when its only caller gives up', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => (release = r))
    const calls: string[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push(url)
      await gate
      init?.signal?.throwIfAborted()
      return new Response('upstream down', { status: 503 })
    }
    const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [kirovohradProvider()] })
    const ctrl = new AbortController()
    const pending = client.getSchedules('kirovohrad', { signal: ctrl.signal })
    await tick()
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release!()
    await tick()
    // the 503 would normally be retried once; nobody waits for it, so it isn't. Two requests were
    // in flight when the caller left, the site's page and the channel's preview: one of each
    expect(calls.filter((u) => u.includes('kiroe.com.ua'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('t.me/s/'))).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it('cancels the address lookup of a health check too', async () => {
    const { fetch, calls } = hangingFetch()
    const provider: Provider = {
      info: {
        id: 'sumy',
        name: 'test',
        operator: 'test',
        website: 'https://example.ua/',
        capabilities: { schedule: true, addressSearch: true },
      },
      sampleAddress: { street: 'Соборна', house: '1' },
      getSchedules: async (ctx) => unpublished('sumy', ['1.1'], ctx.now()),
      lookupAddress: async (ctx) => {
        await ctx.http.text('https://example.ua/lookup')
        throw new Error('unreachable')
      },
    }
    const client = new OutageClient({ fetch, cacheTtlMs: 0, providers: [provider] })
    const ctrl = new AbortController()
    const pending = client.healthCheck({ address: true, signal: ctrl.signal })
    await tick()
    expect(calls).toHaveLength(1)
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls[0]!.init?.signal?.aborted).toBe(true)
  })

  it('reports a cancelled image read as cancelled, not as an unreadable image', async () => {
    const { fetch, calls } = hangingFetch()
    const ctrl = new AbortController()
    const ctx = {
      http: new Http({ fetch }).withSignal(ctrl.signal),
      now: () => new Date(),
      signal: ctrl.signal,
    }
    const at = new Date()
    const pending = scheduleFromImages(
      ctx,
      'volyn',
      [
        {
          date: '2026-11-15',
          images: [
            { path: '/a.png', at },
            { path: '/b.png', at },
          ],
        },
      ],
      (p) => `https://example.ua${p}`,
      { columns: 24, rows: 12, tables: 1, halves: false, palette: { on: [255, 255, 255], off: [0, 0, 0] } },
    )
    await tick()
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(1)
  })

  it('never lets an older cancellable fetch overwrite a newer cached schedule', async () => {
    const resolvers: ((s: RegionSchedule) => void)[] = []
    const provider: Provider = {
      info: {
        id: 'sumy',
        name: 'test',
        operator: 'test',
        website: 'https://example.ua/',
        capabilities: { schedule: true, addressSearch: false },
      },
      getSchedules: () => new Promise((r) => resolvers.push(r)),
    }
    const client = new OutageClient({ providers: [provider] })
    const schedule = (updatedAt: string) => ({ ...unpublished('sumy', ['1.1'], new Date()), updatedAt })
    const older = client.getSchedules('sumy', { signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 2))
    const newer = client.getSchedules('sumy', { fresh: true })
    resolvers[1]!(schedule(NEW))
    await newer
    resolvers[0]!(schedule(OLD))
    await older
    await tick()
    expect((await client.getSchedules('sumy')).updatedAt).toBe(NEW)
  })

  it('on Node 20.0–20.2 (no AbortSignal.any) leaves no listeners on the caller signal once requests are over', async () => {
    const any = AbortSignal.any
    // @ts-expect-error simulate an older Node 20
    delete AbortSignal.any
    try {
      const ctrl = new AbortController()
      const http = new Http({ fetch: async () => new Response('ok'), timeoutMs: 20 }).withSignal(ctrl.signal)
      for (let i = 0; i < 12; i++) await http.text('https://example.ua/')
      await new Promise((r) => setTimeout(r, 60))
      expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0)
    } finally {
      AbortSignal.any = any
    }
  })
})

// Regressions for the second independent (GPT) review: decisions, not just bugs
describe('silence is never "no outages"', () => {
  const NOW = new Date('2026-11-15T10:00:00+02:00')
  const midnight = String(Date.parse('2026-11-15T00:00:00+02:00') / 1000)

  it('GPV: a group without cells is unknown, not power on all day', () => {
    const s = parseGpvDays('dnipro', { [midnight]: { 'GPV1.1': {} } })
    expect(s['1.1']).toEqual([{ date: '2026-11-15', status: 'unknown', intervals: [] }])
  })

  it('GPV: a cell value nobody has seen is a parse error, not "on"', () => {
    expect(() => parseGpvDays('dnipro', { [midnight]: { 'GPV1.1': { '1': 'yes', '2': 'later' } } })).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('text: a group named without times is unknown unless the line says the power stays on', () => {
    const g = parseGroupLines(
      '<p>1.1: графік уточнюється</p><p>2.1. Електроенергія є.</p><p>3.1 08:00-12:00</p>',
    )
    expect(g['1.1']).toBeNull()
    expect(g['2.1']).toEqual([])
    expect(g['3.1']).toHaveLength(1)
  })

  it('posts: a named group without times stays unknown even where unlisted groups mean "no outages"', () => {
    const s = postsToSchedule(
      'zaporizhzhia',
      [
        {
          title: 'ГПВ на 15 листопада',
          body: '<p>1.1: графік уточнюється</p><p>3.1: 08:00 – 12:00</p>',
          publishedAt: NOW.toISOString(),
        },
      ],
      NOW,
      { omitted: 'none', groups: ['1.1', '1.2', '3.1'] },
    )
    expect(s.schedules['1.1']![0]).toMatchObject({ status: 'unknown', intervals: [] })
    // the operator lists only groups with outages: an unlisted one has none
    expect(s.schedules['1.2']![0]).toMatchObject({ status: 'scheduled', intervals: [] })
    expect(s.schedules['3.1']![0]!.intervals).toHaveLength(1)
  })

  it('health: a published day without outages counts as published, not "empty"', async () => {
    const provider: Provider = {
      info: {
        id: 'sumy',
        name: 'test',
        operator: 'test',
        website: 'https://example.ua/',
        capabilities: { schedule: true, addressSearch: false },
      },
      getSchedules: async (ctx) => ({
        ...unpublished('sumy', ['1.1'], ctx.now()),
        schedules: { '1.1': [{ date: kyivDate(ctx.now()), status: 'scheduled', intervals: [] }] },
      }),
    }
    const h = await new OutageClient({ providers: [provider] }).healthCheck()
    expect(h.regions[0]!.status).toBe('ok')
  })
})

describe('cancellation while waiting on shared work', () => {
  const sharedProvider = (shared: Promise<RegionSchedule>): Provider => ({
    info: {
      id: 'sumy',
      name: 'test',
      operator: 'test',
      website: 'https://example.ua/',
      capabilities: { schedule: true, addressSearch: true },
    },
    sampleAddress: { street: 'Соборна', house: '1' },
    // e.g. a directory another call is loading
    getSchedules: () => shared,
    lookupAddress: async () => {
      await shared
      throw new Error('unreachable')
    },
  })

  it('getSchedules leaves at once even when the provider waits on something shared', async () => {
    const client = new OutageClient({ cacheTtlMs: 0, providers: [sharedProvider(new Promise(() => {}))] })
    const ctrl = new AbortController()
    const pending = client.getSchedules('sumy', { signal: ctrl.signal })
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a health check leaves its address lookup at once', async () => {
    const shared = new Promise<RegionSchedule>(() => {})
    const p = sharedProvider(shared)
    const client = new OutageClient({
      cacheTtlMs: 0,
      providers: [{ ...p, getSchedules: async (ctx) => unpublished('sumy', ['1.1'], ctx.now()) }],
    })
    const ctrl = new AbortController()
    const pending = client.healthCheck({ address: true, signal: ctrl.signal })
    await tick()
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an older fetch never overwrites a newer one, even within the same millisecond', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const resolvers: ((s: RegionSchedule) => void)[] = []
      const provider: Provider = {
        info: {
          id: 'sumy',
          name: 'test',
          operator: 'test',
          website: 'https://example.ua/',
          capabilities: { schedule: true, addressSearch: false },
        },
        getSchedules: () => new Promise((r) => resolvers.push(r)),
      }
      const client = new OutageClient({ providers: [provider] })
      const schedule = (updatedAt: string) => ({ ...unpublished('sumy', ['1.1'], new Date()), updatedAt })
      const older = client.getSchedules('sumy', { fresh: true, signal: new AbortController().signal })
      const newer = client.getSchedules('sumy', { fresh: true, signal: new AbortController().signal })
      resolvers[1]!(schedule(NEW))
      await newer
      resolvers[0]!(schedule(OLD))
      await older
      await Promise.resolve()
      expect((await client.getSchedules('sumy')).updatedAt).toBe(NEW)
    } finally {
      spy.mockRestore()
    }
  })
})
