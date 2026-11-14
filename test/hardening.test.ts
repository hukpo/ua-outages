import { describe, expect, it } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import { Http, type FetchLike } from '../src/http.js'
import { ivanoFrankivskProvider } from '../src/providers/ivano-frankivsk.js'
import { kirovohradProvider } from '../src/providers/kirovohrad.js'
import { ternopilProvider } from '../src/providers/ternopil.js'
import { mapLimit } from '../src/util.js'
import { fixture, mockFetch } from './helpers.js'

const IF_API = 'https://be-svitlo.oe.if.ua'
const IF_EMPTY = fixture('ivano-frankivsk/schedule-by-queue.1.1.current-empty.json')
const tick = () => new Promise((r) => setTimeout(r, 10))

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
