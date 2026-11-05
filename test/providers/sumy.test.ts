import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import { decryptSumyResponse, parseSumySchedules, sumyProvider } from '../../src/providers/sumy.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const API = 'https://www.soe.com.ua/next-api/shutdowns'
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

/** Encrypts like the site does, so decrypted fixtures can be served as real responses. */
async function encrypt(plain: string, keyString = 'qasdw-enjenf-twfeft!!d451qwqw!-2'): Promise<string> {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(keyString), 'AES-GCM', false, [
    'encrypt',
  ])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
  )
  return JSON.stringify({ payload: Buffer.concat([iv, data]).toString('base64') })
}

async function routes(): Promise<Route[]> {
  return [
    { match: `${API}/schedules`, body: fixture('sumy/schedules-2026-11-05.encrypted.json') },
    { match: `${API}/cities?`, body: await encrypt(fixture('sumy/cities-shostka.json')) },
    {
      match: `${API}/streets?cityId=5911000000&`,
      body: fixture('sumy/streets-5911000000-shevch.encrypted.json'),
    },
    { match: `${API}/houses?streetId=7549&`, body: await encrypt(fixture('sumy/houses-7549-1.json')) },
    {
      match: `${API}/queues-by-street?streetId=7549&houseId=211911`,
      body: await encrypt(fixture('sumy/queues-by-street-7549-211911.json')),
    },
  ]
}

async function client(r?: Route[]) {
  const { fetch, calls } = mockFetch(r ?? (await routes()))
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] }),
    calls,
  }
}

describe('Sumyoblenergo', () => {
  it('decrypts the schedule and dates it today, merging overlapping windows', async () => {
    const { client: c, calls } = await client()
    const s = await c.getSchedules('sumy')
    expect(s.groups).toEqual([
      '1.1',
      '1.2',
      '2.1',
      '2.2',
      '3.1',
      '3.2',
      '4.1',
      '4.2',
      '5.1',
      '5.2',
      '6.1',
      '6.2',
    ])
    const g11 = s.schedules['1.1']!
    expect(g11.map((d) => d.date)).toEqual(['2026-11-05'])
    // source: 08–12, 14–18, 20–00 and 22–00
    expect(g11[0]!.intervals).toEqual([
      { from: '2026-11-05T08:00:00+02:00', to: '2026-11-05T12:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T14:00:00+02:00', to: '2026-11-05T18:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T20:00:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' },
    ])
    expect(hhmm(s.schedules['3.1']![0]!)).toEqual([
      '00:00-04:00',
      '06:00-10:00',
      '12:00-16:00',
      '18:00-21:30',
    ])
    expect(hhmm(s.schedules['6.2']![0]!)).toEqual(['10:00-14:00', '16:00-20:00', '22:00-00:00'])
    expect((calls[0]!.init?.headers as Record<string, string>).Referer).toMatch(
      /^https:\/\/www\.soe\.com\.ua\//,
    )
  })

  it('reads the update time', async () => {
    const s = await (await client()).client.getSchedules('sumy')
    expect(s.updatedAt).toBe('2026-11-05T21:21:00+02:00')
  })

  it('keeps groups without windows as a day with no outages scheduled', () => {
    const res = JSON.parse(fixture('sumy/schedules-2026-11-05.json'))
    for (const e of res.data) e.lst_time_disc = []
    const s = parseSumySchedules(res, NOW)
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-05', status: 'scheduled', intervals: [] }])
  })

  it('returns an empty schedule when every group has no data', () => {
    const res = JSON.parse(fixture('sumy/schedules-2026-11-05.json'))
    for (const e of res.data) Object.assign(e, { no_data: true, lst_time_disc: [] })
    const s = parseSumySchedules(res, NOW)
    expect(s.groups).toEqual([])
    expect(s.schedules).toEqual({})
  })

  it('rejects a changed schedule format', () => {
    expect(() => parseSumySchedules({} as never, NOW)).toThrow(OutageError)
    const res = JSON.parse(fixture('sumy/schedules-2026-11-05.json'))
    res.data[0].lst_time_disc = [{ from: '08:00', to: '12:00' }]
    expect(() => parseSumySchedules(res, NOW)).toThrow(/bad time/)
  })

  it('fails with a parse error when the key no longer decrypts', async () => {
    const body = await encrypt(fixture('sumy/schedules-2026-11-05.json'), 'a-different-key-of-32-bytes-xxxx')
    const err = await (
      await client([{ match: `${API}/schedules`, body }])
    ).client
      .getSchedules('sumy')
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('parse')
    expect(err.message).toMatch(/^Sumy: cannot decrypt/)
    await expect(decryptSumyResponse({ payload: 'bm90IGVuY3J5cHRlZA==' })).rejects.toThrow(/cannot decrypt/)
    await expect(decryptSumyResponse({ message: 'x' } as never)).rejects.toThrow(/no encrypted "payload"/)
  })

  it('finds the group of a house', async () => {
    const { client: c, calls } = await client()
    const m = await c.findGroup('sumy', { city: 'Шостка', street: 'вул. Шевченка', house: '14' })
    expect(m).toEqual({
      region: 'sumy',
      group: '6.1',
      address: { city: 'м.Шостка', street: 'вулиця Шевченка', house: '14' },
    })
    // the server matches substrings, so the street type is left out of the query
    expect(calls.find((x) => x.url.includes('/streets?'))!.url).toContain(
      `search=${encodeURIComponent('шевченка')}`,
    )
    expect(calls.find((x) => x.url.includes('/houses?'))!.url).toContain('search=14')
  })

  it('returns every group of a building with several connections', async () => {
    const { fetch } = mockFetch([
      {
        match: `${API}/queues-by-street?streetId=7549&`,
        body: await encrypt(fixture('sumy/queues-by-street-7549.json')),
      },
    ])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] })
    const m = await c.groupOf(
      'sumy',
      { id: '1', number: '2', streetId: '7549' },
      { id: '7549', name: 'вулиця Шевченка' },
    )
    expect(m.group).toBe('4.1')
    expect(m.otherGroups).toEqual(['6.1'])
  })

  it('reports a house without an hourly schedule group as not found', async () => {
    const { fetch } = mockFetch([
      {
        match: `${API}/queues-by-street?`,
        body: await encrypt(fixture('sumy/queues-by-street-sumy-kharkivska.json')),
      },
    ])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] })
    const err = await c
      .groupOf('sumy', { id: '1', number: '1', streetId: '1' }, { id: '1', name: 'вулиця Харківська' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('not-found')
  })
})
