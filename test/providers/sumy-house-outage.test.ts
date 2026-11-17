import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { currentShutdown, sumyProvider, type ShutdownRow } from '../../src/providers/sumy.js'
import { fixture, mockFetch } from '../helpers.js'

const API = 'https://www.soe.com.ua/next-api/shutdowns'
/** Охтирка, пров. Сумський 2А as the site gave it on 17.11.2026 ~23:27 Kyiv (decrypted) */
const ROWS: ShutdownRow[] = JSON.parse(fixture('sumy/by-house-293436.2026-11-17.json')).data.list
const AT = new Date('2026-11-17T23:27:00+02:00')

/** The site's own wrapping (see sumy.test.ts) */
async function encrypt(plain: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('qasdw-enjenf-twfeft!!d451qwqw!-2'),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
  )
  return JSON.stringify({ payload: Buffer.concat([iv, data]).toString('base64') })
}

describe('Sumy by-house rows', () => {
  it('the running one, Kyiv wall clock; the planned ones ahead are not now', () => {
    expect(currentShutdown(ROWS, AT)).toEqual({
      kind: 'repair',
      reason: 'Аварійне',
      scheduleApplies: null,
      from: '2026-11-17T21:03:00+02:00',
      to: '2026-11-18T01:03:00+02:00',
    })
    expect(currentShutdown(ROWS, new Date('2026-11-18T01:03:00+02:00'))).toBeNull()
    expect(currentShutdown(ROWS, new Date('2026-11-18T09:00:00+02:00'))).toMatchObject({
      kind: 'planned',
      reason: 'Планове',
    })
    expect(currentShutdown([], AT)).toBeNull()
  })

  it("the site's type map; ГАВ and СГАВ (not seen live yet) come first", () => {
    const row = (type: number): ShutdownRow => [
      'м',
      'в',
      '1',
      '2026-11-17T20:00:00',
      '2026-11-18T02:00:00',
      type,
    ]
    const kind = (type: number) => currentShutdown([row(type)], AT)
    expect(kind(3)).toMatchObject({ kind: 'emergency', reason: 'ГАВ', scheduleApplies: false })
    expect(kind(6)).toMatchObject({ kind: 'emergency', reason: 'СГАВ' })
    expect(kind(4)).toMatchObject({ kind: 'scheduled', reason: 'ГПВ', scheduleApplies: true })
    expect(kind(5)?.kind).toBe('scheduled')
    expect(kind(7)).toMatchObject({ kind: 'planned', reason: 'Планове (термінове)' })
    expect(kind(9)?.kind).toBe('repair')
    expect(kind(8)).toMatchObject({ kind: 'other', reason: 'САВН' })
    expect(kind(10)).toMatchObject({ kind: 'other', reason: 'ГОП' })
    expect(kind(42)).toMatchObject({ kind: 'other', reason: 'тип 42' })
    expect(currentShutdown([row(2), row(3), row(4)], AT)?.kind).toBe('emergency')
  })
})

describe('getHouseOutage in Sumy', () => {
  async function client() {
    const { fetch, calls } = mockFetch([
      { match: `${API}/cities?`, body: await encrypt(fixture('sumy/cities-okhtyrka.json')) },
      {
        match: `${API}/streets?cityId=5910200000&`,
        body: await encrypt(fixture('sumy/streets-5910200000-sumskyi.json')),
      },
      { match: `${API}/houses?streetId=4899&`, body: await encrypt(fixture('sumy/houses-4899-2.json')) },
      {
        match: `${API}/by-house?houseId=293436`,
        body: await encrypt(fixture('sumy/by-house-293436.2026-11-17.json')),
      },
      {
        match: `${API}/queues-by-street?streetId=4899&houseId=293436`,
        body: await encrypt(fixture('sumy/queues-by-street-4899-293436.json')),
      },
    ])
    return {
      client: new OutageClient({ fetch, now: () => AT, cacheTtlMs: 0, providers: [sumyProvider()] }),
      calls,
    }
  }

  it('the house by its id, with its group', async () => {
    const { client: c, calls } = await client()
    expect(c.region('sumy').capabilities.houseOutage).toBe(true)
    const address = { city: 'Охтирка', street: 'пров. Сумський', house: '2А' }
    expect(await c.getHouseOutage('sumy', address)).toEqual({
      region: 'sumy',
      address: { city: 'м.Охтирка', street: 'провулок Сумський', house: '2А' },
      kind: 'repair',
      reason: 'Аварійне',
      scheduleApplies: null,
      from: '2026-11-17T21:03:00+02:00',
      to: '2026-11-18T01:03:00+02:00',
      groups: ['6.1'],
      updatedAt: null,
      url: 'https://www.soe.com.ua/consumers/shutdowns',
      fetchedAt: '2026-11-17T23:27:00+02:00',
    })
    await c.getHouseOutage('sumy', address)
    expect(calls.filter((x) => x.url.includes('by-house'))).toHaveLength(1)
  })

  it('nothing listed for the house: null', async () => {
    const { fetch } = mockFetch([
      { match: `${API}/cities?`, body: await encrypt(fixture('sumy/cities-shostka.json')) },
      {
        match: `${API}/streets?cityId=5911000000&`,
        body: await encrypt(fixture('sumy/streets-5911000000-shevch.json')),
      },
      { match: `${API}/houses?streetId=7549&`, body: await encrypt(fixture('sumy/houses-7549-1.json')) },
      {
        match: `${API}/by-house?houseId=211911`,
        body: await encrypt(fixture('sumy/by-house-211911.empty.json')),
      },
    ])
    const c = new OutageClient({ fetch, now: () => AT, cacheTtlMs: 0, providers: [sumyProvider()] })
    expect(
      await c.getHouseOutage('sumy', { city: 'Шостка', street: 'вул. Шевченка', house: '14' }),
    ).toBeNull()
  })
})
