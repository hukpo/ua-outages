import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { houseOutage, streetsByCity, type HomeRecord } from '../../src/providers/dtek.js'
import type { FetchLike } from '../../src/http.js'

const AT = new Date('2026-11-17T22:40:00+02:00')
const TOKEN = 'hW9vzX0sQ1aB2cD3eF4gH5iJ6kL7mN8o'

const EMERGENCY = 'Екстренні відключення (Аварійне без застосування графіку погодинних відключень)'

// records as dtek-dnem.com.ua gave them on 17.11.2026 ~22:30, the evening after ЦЕК had cancelled
// the region-wide emergency at 12:56: вул. Бетховена 32, вул. Січеславська Набережна 7
const UNDER_EMERGENCY: HomeRecord = {
  sub_type: EMERGENCY,
  start_date: '10:40 16.11.2026',
  end_date: '00:25 18.11.2026',
  type: '2',
  sub_type_reason: ['GPV1.2'],
  voluntarily: null,
  cek: null,
}
const UNDER_REPAIR: HomeRecord = {
  sub_type: 'Аварійні ремонтні роботи',
  start_date: '14:59 15.11.2026',
  end_date: '23:30 17.11.2026',
  type: '2',
  sub_type_reason: ['GPV5.1'],
  voluntarily: null,
  cek: null,
}
const NOTHING: HomeRecord = {
  sub_type: '',
  start_date: '',
  end_date: '',
  type: '',
  sub_type_reason: ['GPV1.2'],
  voluntarily: null,
  cek: null,
}

/**
 * A DTEK site's /ua/ajax: the first POST without a token is refused with the CSRF cookie, then
 * `getStreets` and `getHomeNum` answer from `streets` / `houses`.
 */
function dtekSite(
  code: string,
  streets: Record<string, string[]> | string[],
  houses: Record<string, HomeRecord>,
) {
  const ajax = `https://www.dtek-${code}.com.ua/ua/ajax`
  const cookie = encodeURIComponent(
    `${'a'.repeat(64)}a:2:{i:0;s:${`_csrf-dtek-${code}`.length}:"_csrf-dtek-${code}";i:1;s:32:"${TOKEN}";}`,
  )
  const asked: string[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const form = new URLSearchParams(String(init?.body ?? ''))
    if (url !== ajax || init?.method !== 'POST') throw new Error(`unexpected request ${url}`)
    if (!headers['X-CSRF-Token'])
      return new Response('Bad Request (#400)', {
        status: 400,
        headers: { 'set-cookie': `_csrf-dtek-${code}=${cookie}; path=/; HttpOnly` },
      })
    const method = form.get('method')!
    // only the site's own requests are counted below
    asked.push(method === 'getHomeNum' ? `getHomeNum ${form.get('data[1][value]')}` : method)
    if (method === 'checkDisconUpdate')
      return new Response(JSON.stringify({ result: true, fact: { data: {}, update: '17.11.2026 21:18' } }))
    if (method === 'getStreets') return new Response(JSON.stringify({ result: true, streets }))
    if (method === 'getHomeNum')
      return new Response(
        JSON.stringify({
          result: true,
          data: houses,
          showCurOutageParam: true,
          updateTimestamp: '22:31 17.11.2026',
        }),
      )
    throw new Error(`unexpected method ${method}`)
  }
  return { fetch, asked }
}

describe('houseOutage: a getHomeNum record the way the site reads it', () => {
  it('екстрені: the schedule does not apply to the house', () => {
    expect(houseOutage(UNDER_EMERGENCY)).toEqual({
      kind: 'emergency',
      reason: EMERGENCY,
      scheduleApplies: false,
      from: '2026-11-16T10:40:00+02:00',
      to: '2026-11-18T00:25:00+02:00',
    })
  })

  it('аварійні ремонтні роботи: local damage, says nothing about the schedule', () => {
    expect(houseOutage(UNDER_REPAIR)).toMatchObject({ kind: 'repair', scheduleApplies: null })
  })

  it("the schedule's own outage", () => {
    expect(
      houseOutage({
        sub_type: 'Стабілізаційне відключення (Згідно графіку погодинних відключень)',
        start_date: '19:31 05.11.2026',
        end_date: '01:30 06.11.2026',
        type: '2',
      }),
    ).toMatchObject({ kind: 'scheduled', scheduleApplies: true, to: '2026-11-06T01:30:00+02:00' })
  })

  it('type "1" is planned repairs, named by the page when the record has no words', () => {
    expect(
      houseOutage({ sub_type: '', start_date: '09:00 18.11.2026', end_date: '17:00 18.11.2026', type: '1' }),
    ).toEqual({
      kind: 'planned',
      reason: 'Планові ремонтні роботи',
      scheduleApplies: null,
      from: '2026-11-18T09:00:00+02:00',
      to: '2026-11-18T17:00:00+02:00',
    })
  })

  it('a reason not seen before is `other`, with its words', () => {
    expect(
      houseOutage({ sub_type: 'Відключення за заявою', start_date: '10:00 17.11.2026', type: '2' }),
    ).toMatchObject({
      kind: 'other',
      reason: 'Відключення за заявою',
    })
  })

  it('no reason and no times: no outage', () => {
    expect(houseOutage(NOTHING)).toBeNull()
    expect(houseOutage({})).toBeNull()
  })
})

describe('getHouseOutage', () => {
  afterEach(() => vi.useRealTimers())

  it('Dnipro: groups come from YASNO, the house status from the DTEK site, by its own names', async () => {
    const site = dtekSite(
      'dnem',
      { 'м. Дніпро': ['вул. Бетховена', 'просп. Слобожанський'], 'м. Самар': ['просп. Слобожанський'] },
      { '32': UNDER_EMERGENCY, '4': NOTHING, '9': { ...NOTHING, cek: true } },
    )
    const client = new OutageClient({ fetch: site.fetch, now: () => AT, cacheTtlMs: 0 })
    expect(client.region('dnipro').capabilities.houseOutage).toBe(true)

    const s = await client.getHouseOutage('dnipro', {
      city: 'Дніпро',
      street: 'Бетховена вулиця',
      house: '32',
    })
    expect(s).toEqual({
      region: 'dnipro',
      address: { city: 'м. Дніпро', street: 'вул. Бетховена', house: '32' },
      kind: 'emergency',
      reason: EMERGENCY,
      scheduleApplies: false,
      from: '2026-11-16T10:40:00+02:00',
      to: '2026-11-18T00:25:00+02:00',
      groups: ['1.2'],
      updatedAt: '2026-11-17T22:31:00+02:00',
      url: 'https://www.dtek-dnem.com.ua/ua/shutdowns',
      fetchedAt: '2026-11-17T22:40:00+02:00',
    })

    // a neighbour with nothing on record; the street is asked for once while it is fresh
    expect(
      await client.getHouseOutage('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '4' }),
    ).toBeNull()
    expect(site.asked.filter((m) => m.startsWith('getHomeNum'))).toEqual(['getHomeNum вул. Бетховена'])
    // `fresh` asks again, once: the house list and the house are the same answer
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    await client.getHouseOutage(
      'dnipro',
      { city: 'Дніпро', street: 'вул. Бетховена', house: '4' },
      { fresh: true },
    )
    expect(site.asked.filter((m) => m.startsWith('getHomeNum'))).toHaveLength(2)

    // a house the site marks as ЦЕК's: DTEK knows nothing about it
    await expect(
      client.getHouseOutage('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '9' }),
    ).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/ЦЕК/) })
    await expect(
      client.getHouseOutage('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '200' }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('Kyiv: the site lists its streets without a city (an array, as dtek-kem sends it), so none is needed', async () => {
    const site = dtekSite('kem', ['вул. Ростиславська', 'вул. Хрещатик'], { '6': UNDER_REPAIR })
    const client = new OutageClient({ fetch: site.fetch, now: () => AT, cacheTtlMs: 0 })
    const s = await client.getHouseOutage('kyiv', { street: 'Хрещатик', house: '6' })
    expect(s).toMatchObject({
      region: 'kyiv',
      address: { city: 'м. Київ', street: 'вул. Хрещатик', house: '6' },
      kind: 'repair',
      url: 'https://www.dtek-kem.com.ua/ua/shutdowns',
    })
  })

  it('a DTEK region of its own (Kyiv region) uses its one site for both', async () => {
    const site = dtekSite('krem', { 'м. Ірпінь': ['вул. Західна'] }, { '2': UNDER_EMERGENCY })
    const client = new OutageClient({ fetch: site.fetch, now: () => AT, cacheTtlMs: 0 })
    const address = { city: 'Ірпінь', street: 'Західна', house: '2' }
    expect((await client.getHouseOutage('kyiv-region', address))?.kind).toBe('emergency')
    expect((await client.findGroup('kyiv-region', address)).group).toBe('1.2')
  })

  it('regions without per-house status say so', async () => {
    const client = new OutageClient({ fetch: async () => new Response('{}'), now: () => AT })
    expect(client.region('dnipro-cek').capabilities.houseOutage).toBe(false)
    expect(client.region('khmelnytskyi').capabilities.houseOutage).toBe(false)
    await expect(
      client.getHouseOutage('dnipro-cek', { city: 'Дніпро', street: 'Робоча', house: '1' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('streetsByCity', () => {
  it("a site's settlement map as is; Kyiv's flat list under its one city; anything else a parse error", () => {
    expect(streetsByCity({ 'м. Ірпінь': ['вул. Західна'] }, 'krem')).toEqual({
      'м. Ірпінь': ['вул. Західна'],
    })
    expect(streetsByCity(['вул. Хрещатик', 5], 'kem')).toEqual({ 'м. Київ': ['вул. Хрещатик'] })
    expect(() => streetsByCity(['вул. Х'], 'oem')).toThrow(/without settlements/)
    expect(() => streetsByCity('x', 'kem')).toThrow(/unexpected/)
  })
})

describe('one session per site', () => {
  it('getHouseStatus reads the schedule and the address on one session: one handshake, one street list', async () => {
    const site = dtekSite('krem', { 'м. Ірпінь': ['вул. Західна'] }, { '2': UNDER_EMERGENCY })
    const client = new OutageClient({ fetch: site.fetch, now: () => AT })
    const s = await client.getHouseStatus('kyiv-region', { city: 'Ірпінь', street: 'Західна', house: '2' })
    expect(s).toMatchObject({ state: 'off', basis: 'house-outage' })
    expect(site.asked.filter((m) => m === 'checkDisconUpdate')).toHaveLength(1)
    expect(site.asked.filter((m) => m === 'getStreets')).toHaveLength(1)
    expect(site.asked.filter((m) => m.startsWith('getHomeNum'))).toHaveLength(1)
  })

  it('Kyiv: the schedule channel and the house record share the DTEK site', async () => {
    const site = dtekSite('kem', ['вул. Хрещатик'], { '6': UNDER_REPAIR })
    const yasno: FetchLike = async (url, init) =>
      url.startsWith('https://www.dtek-kem.com.ua')
        ? site.fetch(url, init)
        : new Response('down', { status: 503 })
    const client = new OutageClient({ fetch: yasno, now: () => AT, cacheTtlMs: 0 })
    await client.getSchedules('kyiv').catch(() => {})
    await client.getHouseOutage('kyiv', { street: 'Хрещатик', house: '6' })
    // the house lookup found the session the schedule had loaded
    expect(site.asked.filter((m) => m === 'checkDisconUpdate')).toHaveLength(1)
  })
})
