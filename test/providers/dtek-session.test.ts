import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../../src/client.js'
import type { FetchLike } from '../../src/http.js'
import { fixture } from '../helpers.js'

const AT = new Date('2026-11-18T00:40:00+02:00')
const TOKEN = 'hW9vzX0sQ1aB2cD3eF4gH5iJ6kL7mN8o'
const AJAX = 'https://www.dtek-krem.com.ua/ua/ajax'
/** What Imperva answers instead of the site (dtek-kem, 18.11.2026 00:38) */
const CHALLENGE = fixture('dtek/blocked.html')

/**
 * dtek-krem's /ua/ajax: a POST without a token is refused with 400 and the CSRF cookie, as the
 * site does; Imperva's visitor cookies come with every answer. `blocked` puts the bot check in
 * front, `expireToken` makes the site refuse the token it handed out.
 */
function site() {
  const cookie = encodeURIComponent(`${'a'.repeat(64)}a:2:{i:0;s:15:"_csrf-dtek-krem";i:1;s:32:"${TOKEN}";}`)
  const state = { blocked: false, expireToken: false }
  const asked: { method: string; cookie: string }[] = []
  const imperva = ['visid_incap_2398465=V1; path=/; HttpOnly', 'incap_ses_786_2398465=S1; path=/']
  const fetch: FetchLike = async (url, init) => {
    if (url !== AJAX) throw new Error(`unexpected request ${url}`)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const method = new URLSearchParams(String(init?.body ?? '')).get('method')!
    asked.push({ method: headers['X-CSRF-Token'] ? method : 'handshake', cookie: headers.Cookie ?? '' })
    const h = new Headers()
    for (const c of imperva) h.append('set-cookie', c)
    if (state.blocked) return new Response(CHALLENGE, { headers: h })
    if (!headers['X-CSRF-Token'] || state.expireToken) {
      state.expireToken = false
      h.append('set-cookie', `_csrf-dtek-krem=${cookie}; path=/; HttpOnly`)
      return new Response('Bad Request (#400)', { status: 400, headers: h })
    }
    if (method === 'checkDisconUpdate')
      return new Response(JSON.stringify({ result: true, fact: { data: {}, update: '18.11.2026 00:10' } }), {
        headers: h,
      })
    if (method === 'getStreets')
      return new Response(JSON.stringify({ result: true, streets: { 'м. Ірпінь': ['вул. Західна'] } }), {
        headers: h,
      })
    if (method === 'getHomeNum')
      return new Response(JSON.stringify({ result: true, data: { '2': { sub_type_reason: ['GPV4.1'] } } }), {
        headers: h,
      })
    throw new Error(`unexpected method ${method}`)
  }
  return { fetch, asked, state }
}

const ADDRESS = { city: 'Ірпінь', street: 'Західна', house: '2' }
const methods = (s: ReturnType<typeof site>) => s.asked.map((a) => a.method)

describe('DTEK: one returning visitor, asking little', () => {
  afterEach(() => vi.useRealTimers())

  it("keeps the site's cookies, Imperva's included, and sends them back", async () => {
    const s = site()
    const c = new OutageClient({ fetch: s.fetch, now: () => AT, cacheTtlMs: 0 })
    await c.getSchedules('kyiv-region')
    expect(s.asked[0]!.cookie).toBe('')
    expect(s.asked[1]!.cookie).toMatch(/visid_incap_2398465=V1/)
    expect(s.asked[1]!.cookie).toMatch(/incap_ses_786_2398465=S1/)
    expect(s.asked[1]!.cookie).toMatch(/_csrf-dtek-krem=/)
  })

  it('a token is reused across readings; one the site refuses is renewed once', async () => {
    const s = site()
    const c = new OutageClient({ fetch: s.fetch, now: () => AT, cacheTtlMs: 0 })
    await c.getSchedules('kyiv-region')
    await c.getSchedules('kyiv-region')
    expect(methods(s)).toEqual(['handshake', 'checkDisconUpdate', 'checkDisconUpdate'])
    s.state.expireToken = true
    await c.getSchedules('kyiv-region')
    expect(methods(s).slice(3)).toEqual(['checkDisconUpdate', 'handshake', 'checkDisconUpdate'])
  })

  it('the street list is kept for a day, and an address needs no schedule reading', async () => {
    const s = site()
    const c = new OutageClient({ fetch: s.fetch, now: () => AT, cacheTtlMs: 0 })
    expect((await c.findGroup('kyiv-region', ADDRESS)).group).toBe('4.1')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * 3_600_000)
    await c.findGroup('kyiv-region', ADDRESS)
    expect(methods(s)).toEqual(['handshake', 'getStreets', 'getHomeNum', 'getHomeNum'])
  })

  it('after the bot check answers, the site is left alone: 5 minutes, then doubled, then asked again', async () => {
    const s = site()
    const c = new OutageClient({ fetch: s.fetch, now: () => AT, cacheTtlMs: 0 })
    await c.getSchedules('kyiv-region')
    s.state.blocked = true
    await expect(c.getSchedules('kyiv-region')).rejects.toMatchObject({ code: 'blocked' })
    const sent = s.asked.length

    // during the pause nothing is sent: not the schedule, not an address
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 4 * 60_000)
    await expect(c.getSchedules('kyiv-region')).rejects.toMatchObject({
      code: 'blocked',
      message: expect.stringMatching(/not asked again before \d{2}:\d{2}/),
    })
    await expect(c.findGroup('kyiv-region', ADDRESS)).rejects.toMatchObject({ code: 'blocked' })
    expect(s.asked.length).toBe(sent)

    // past it: asked once, still blocked, so the pause is 10 minutes now
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await expect(c.getSchedules('kyiv-region')).rejects.toMatchObject({ code: 'blocked' })
    expect(s.asked.length).toBe(sent + 1)
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await expect(c.getSchedules('kyiv-region')).rejects.toMatchObject({ code: 'blocked' })
    expect(s.asked.length).toBe(sent + 1)

    // lifted: the next try gets through and the pause is over
    s.state.blocked = false
    vi.setSystemTime(Date.now() + 5 * 60_000)
    expect((await c.getSchedules('kyiv-region')).groups).toHaveLength(12)
    expect((await c.findGroup('kyiv-region', ADDRESS)).group).toBe('4.1')
  })

  it('getHouseStatus while blocked: the schedule and the house record are gaps, not a throw', async () => {
    const s = site()
    s.state.blocked = true
    const c = new OutageClient({ fetch: s.fetch, now: () => AT, cacheTtlMs: 0 })
    const st = await c.getHouseStatus('kyiv-region', ADDRESS)
    expect(st.state).toBe('unknown')
    expect(st.gaps.map((g) => `${g.part}:${g.code}`)).toEqual(
      expect.arrayContaining(['address:blocked', 'house-outage:blocked', 'schedule:blocked']),
    )
    // one try at the site, then the pause: the four parts didn't each knock
    expect(s.asked.length).toBeLessThanOrEqual(2)
  })
})
