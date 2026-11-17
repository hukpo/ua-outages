import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { csrfFromCookie, maskCsrfToken, parseDisconScript } from '../../src/providers/dtek.js'
import { gpvCellsToSlots, parseGpvDays, parseUaDateTime } from '../../src/providers/gpv.js'
import type { FetchLike } from '../../src/http.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const PAGE = 'https://www.dtek-oem.com.ua/ua/shutdowns'
const AJAX = 'https://www.dtek-oem.com.ua/ua/ajax'

function setup(page = fixture('dtek/shutdowns.trimmed.html')) {
  const { fetch, calls } = mockFetch([
    {
      match: PAGE,
      body: page,
      headers: { 'set-cookie': '_csrf-dtek-oem=abc; path=/; HttpOnly' },
    },
    { match: AJAX, method: 'POST', body: fixture('dtek/ajax-getHomeNum-odesa-varnenska.json') },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
}

describe('GPV hourly format', () => {
  it('maps half-hour codes', () => {
    expect(gpvCellsToSlots({ '1': 'second', '2': 'no', '3': 'first', '4': 'mfirst', '5': 'yes' })).toEqual([
      { start: 30, end: 60, kind: 'off' },
      { start: 60, end: 120, kind: 'off' },
      { start: 120, end: 150, kind: 'off' },
      { start: 180, end: 210, kind: 'maybe' },
    ])
  })

  it('treats [] as an empty schedule and keys days by Kyiv date', () => {
    expect(parseGpvDays('odesa', [])).toEqual({})
    // 1793829600 = 2026-11-05 00:00 Kyiv
    const days = parseGpvDays('odesa', { '1793829600': { 'GPV1.1': { '1': 'no' } } })
    expect(days['1.1']![0]!.date).toBe('2026-11-05')
  })

  it('parses both date-time orders', () => {
    expect(parseUaDateTime('05.11.2026 21:31')).toBe('2026-11-05T21:31:00+02:00')
    expect(parseUaDateTime('23:18 05.11.2026')).toBe('2026-11-05T23:18:00+02:00')
    expect(parseUaDateTime('')).toBeNull()
  })
})

describe('DTEK sites', () => {
  it('reads the embedded schedule', async () => {
    const s = await setup().client.getSchedule('odesa', '1.1')
    expect(s.updatedAt).toBe('2026-11-05T21:31:00+02:00')
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(s.days[0]!.intervals).toEqual([
      { from: '2026-11-05T00:30:00+02:00', to: '2026-11-05T04:30:00+02:00', kind: 'off' },
      { from: '2026-11-05T21:30:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' },
    ])
  })

  it('extracts the script variables', () => {
    const vars = parseDisconScript(fixture('dtek/shutdowns.trimmed.html'))
    expect(Object.keys(vars)).toEqual(
      expect.arrayContaining(['streets', 'preset', 'fact', 'currentWeekDayIndex']),
    )
  })

  it('finds a group by address with the session cookie and CSRF token', async () => {
    const { client, calls } = setup()
    const m = await client.findGroup('odesa', { city: 'Одеса', street: 'Варненська', house: '1' })
    expect(m.group).toBe('2.2')
    const post = calls.find((c) => c.url === AJAX)!
    const headers = post.init!.headers as Record<string, string>
    expect(headers.Cookie).toBe('_csrf-dtek-oem=abc')
    expect(headers['X-CSRF-Token']).toBeTruthy()
    expect(String(post.init!.body)).toContain('method=getHomeNum')
  })

  it('reports houses that belong to two groups', async () => {
    const m = await setup().client.findGroup('odesa', {
      city: 'м. Одеса',
      street: 'вул. Варненська',
      house: '18/3',
    })
    expect(m).toMatchObject({ group: '3.1', otherGroups: ['4.1'] })
  })

  it('reuses the page for searches instead of reloading it', async () => {
    const { client, calls } = setup()
    await client.searchCities('odesa', 'Одеса')
    await client.searchCities('odesa', 'Ізмаїл')
    expect(calls.filter((c) => c.url === PAGE)).toHaveLength(1)
  })

  it('says when bot protection answered', async () => {
    await expect(setup(fixture('dtek/blocked.html')).client.getSchedules('odesa')).rejects.toMatchObject({
      code: 'blocked',
    })
  })

  it('says so when the bot check answers the address request instead of the page', async () => {
    // kyiv-region and donetsk: HTTP 200, under 1 KB, `_Incapsula_Resource` on every route
    const { fetch } = mockFetch([
      {
        match: PAGE,
        body: fixture('dtek/shutdowns.trimmed.html'),
        headers: { 'set-cookie': '_csrf-dtek-oem=abc' },
      },
      { match: AJAX, method: 'POST', body: fixture('dtek/blocked.html') },
    ])
    const client = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 })
    await expect(
      client.findGroup('odesa', { city: 'Одеса', street: 'Варненська', house: '1' }),
    ).rejects.toMatchObject({ code: 'blocked', message: expect.stringMatching(/Bot protection/) })
  })

  it('does not take a real page for a stub because it embeds the same script', async () => {
    // docs/sources/dtek-oem.md: the good page has `<script src="/_Incapsula_Resource?…">` too
    const page = fixture('dtek/shutdowns.trimmed.html').replace(
      '</head>',
      '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script></head>',
    )
    expect(page).toContain('_Incapsula_Resource')
    expect((await setup(page).client.getSchedules('odesa')).groups).toHaveLength(12)
  })

  it('reports the page as its one source, with `fact.update` and every day the page has', async () => {
    const s = await setup().client.getSchedules('odesa')
    expect(s.updatedAt).toBe('2026-11-05T21:31:00+02:00')
    expect(s.sources).toEqual([
      {
        id: 'site',
        url: PAGE,
        ok: true,
        // today and tomorrow: tomorrow is taken whenever `fact.data` has its key
        dates: ['2026-11-05', '2026-11-06'],
        updatedAt: '2026-11-05T21:31:00+02:00',
      },
    ])
    expect(assessFreshness(s, { now: NOW })).toMatchObject({
      state: 'fresh',
      tomorrow: 'published',
      issues: [],
    })
  })

  it('never shows a page that stopped moving as today: days keep the dates of their keys', async () => {
    // the same page (`fact.today` = 05.11, days 05.11 and 06.11) served two days later
    const now = new Date('2026-11-07T10:00:00+02:00')
    const { fetch } = mockFetch([{ match: PAGE, body: fixture('dtek/shutdowns.trimmed.html') }])
    const s = await new OutageClient({ fetch, now: () => now, cacheTtlMs: 0 }).getSchedules('odesa')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    const f = assessFreshness(s, { now })
    expect(f).toMatchObject({ state: 'stale', today: 'missing', coveredThrough: '2026-11-06' })
    expect(f.issues.map((i) => i.code)).toContain('behind')
  })

  it('says when the page changed', async () => {
    await expect(
      setup('<html>' + 'x'.repeat(30_000) + '</html>').client.getSchedules('odesa'),
    ).rejects.toMatchObject({
      code: 'parse',
    })
  })
})

describe('DTEK /ua/ajax route (Kyiv region)', () => {
  const KREM = 'https://www.dtek-krem.com.ua/ua/ajax'
  const TOKEN = 'hW9vzX0sQ1aB2cD3eF4gH5iJ6kL7mN8o'
  const COOKIE_VALUE = encodeURIComponent(
    `${'a'.repeat(64)}a:2:{i:0;s:15:"_csrf-dtek-krem";i:1;s:32:"${TOKEN}";}`,
  )
  const AT = new Date('2026-11-17T08:00:00+02:00')

  /** The token the site would recover from a masked `X-CSRF-Token` */
  const unmask = (masked: string) => {
    const bin = atob(masked.replace(/-/g, '+').replace(/_/g, '/'))
    const half = bin.length / 2
    let out = ''
    for (let i = 0; i < half; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ bin.charCodeAt(i + half))
    return out
  }

  function krem(opts: { stub?: boolean; noCookie?: boolean } = {}) {
    const calls: { url: string; headers: Record<string, string>; form: URLSearchParams }[] = []
    const fetch: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const form = new URLSearchParams(String(init?.body ?? ''))
      calls.push({ url, headers, form })
      if (url !== KREM || init?.method !== 'POST') throw new Error(`unexpected request ${url}`)
      if (opts.stub) return new Response(fixture('dtek/blocked.html'))
      const masked = headers['X-CSRF-Token']
      if (!masked || unmask(masked) !== TOKEN || !headers.Cookie?.includes('_csrf-dtek-krem='))
        return new Response('Bad Request (#400): Не вдалося перевірити передані дані.', {
          status: 400,
          headers: opts.noCookie ? {} : { 'set-cookie': `_csrf-dtek-krem=${COOKIE_VALUE}; path=/; HttpOnly` },
        })
      const method = form.get('method')
      if (method === 'checkDisconUpdate')
        return new Response(fixture('dtek/krem-ajax-checkDisconUpdate.trimmed.json'))
      if (method === 'getStreets') return new Response(fixture('dtek/krem-ajax-getStreets.trimmed.json'))
      if (method === 'getHomeNum')
        return new Response(JSON.stringify({ result: true, data: { '2': { sub_type_reason: ['GPV4.1'] } } }))
      throw new Error(`unexpected method ${method}`)
    }
    return { client: new OutageClient({ fetch, now: () => AT, cacheTtlMs: 0 }), calls }
  }

  it('reads the token out of the cookie and masks it the way the site unmasks it', () => {
    expect(csrfFromCookie(`_language=x; _csrf-dtek-krem=${COOKIE_VALUE}; visid=1`, 'krem')).toBe(TOKEN)
    expect(csrfFromCookie('_csrf-dtek-oem=abc', 'krem')).toBeNull()
    expect(csrfFromCookie('_csrf-dtek-krem=%E0%A4%A', 'krem')).toBeNull()
    expect(unmask(maskCsrfToken(TOKEN))).toBe(TOKEN)
    expect(maskCsrfToken(TOKEN)).not.toBe(maskCsrfToken(TOKEN))
    expect(maskCsrfToken('ab', new Uint8Array([0, 0]))).toBe(btoa('\0\0ab'))
  })

  it('reads the schedule with two POSTs and never asks for the page', async () => {
    const { client, calls } = krem()
    const s = await client.getSchedules('kyiv-region')
    expect(s.groups).toHaveLength(12)
    expect(s.updatedAt).toBe('2026-11-16T23:37:00+02:00')
    expect(s.schedules['1.1']![0]).toMatchObject({
      date: '2026-11-17',
      intervals: [
        { from: '2026-11-17T06:00:00+02:00', to: '2026-11-17T09:30:00+02:00', kind: 'off' },
        { from: '2026-11-17T16:00:00+02:00', to: '2026-11-17T21:30:00+02:00', kind: 'off' },
      ],
    })
    expect(s.sources).toEqual([
      { id: 'site', url: KREM, ok: true, dates: ['2026-11-17'], updatedAt: '2026-11-16T23:37:00+02:00' },
    ])
    expect(calls.map((c) => c.url)).toEqual([KREM, KREM])
    expect(calls[0]!.headers['X-CSRF-Token']).toBeUndefined()
    expect(calls[1]!.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest' })
  })

  it('finds a group by address through getStreets and getHomeNum', async () => {
    const { client, calls } = krem()
    const m = await client.findGroup('kyiv-region', { city: 'Ірпінь', street: 'Західна', house: '2' })
    expect(m).toMatchObject({ region: 'kyiv-region', group: '4.1' })
    expect(calls.map((c) => c.form.get('method'))).toEqual([
      'checkDisconUpdate',
      'checkDisconUpdate',
      'getStreets',
      'getHomeNum',
    ])
    // the street list is asked for once per session
    await client.searchStreets('kyiv-region', 'Захід', { city: { id: 'м. Ірпінь', name: 'м. Ірпінь' } })
    expect(calls.filter((c) => c.form.get('method') === 'getStreets')).toHaveLength(1)
  })

  it('is `blocked` when the bot check answers /ua/ajax too', async () => {
    await expect(krem({ stub: true }).client.getSchedules('kyiv-region')).rejects.toMatchObject({
      code: 'blocked',
    })
  })

  it('is a `parse` error when the refusal carries no CSRF cookie', async () => {
    await expect(krem({ noCookie: true }).client.getSchedules('kyiv-region')).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringMatching(/CSRF cookie/),
    })
  })
})
