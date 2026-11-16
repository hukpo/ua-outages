import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { compareQueues, emergencyQueues, queueNames } from '../../src/emergency/queues.js'
import { Http } from '../../src/http.js'
import { parseSearchAnswer } from '../../src/providers/ivano-frankivsk.js'
import { mykolaivProvider } from '../../src/providers/mykolaiv.js'
import { parseGavMessage } from '../../src/providers/poltava.js'
import { sumyProvider } from '../../src/providers/sumy.js'
import { buildingNamesToBuildings } from '../../src/providers/ternopil.js'
import { matchRecords, parseQueueTable } from '../../src/providers/volyn.js'
import { queuesToBuildings } from '../../src/providers/zakarpattia.js'
import { fixture, mockFetch } from '../helpers.js'

/**
 * Address → ГАВ / СГАВ / АЧР queues (`GroupMatch.emergency`), from the responses the providers
 * already fetch for the ГПВ group. Fixtures are live answers of 2026-11-16 (research/<region>/gav).
 */
describe('emergency queue values', () => {
  it('normalizes what operators write', () => {
    expect(queueNames('Не входить')).toEqual([])
    expect(queueNames('Не залучено')).toEqual([])
    expect(queueNames('')).toEqual([])
    expect(queueNames(null)).toEqual([])
    expect(queueNames('10 (48.2Гц)')).toEqual(['10'])
    expect(queueNames('8, 8, 3')).toEqual(['8', '8', '3'])
    expect(queueNames('1(Р)')).toEqual(['1(Р)'])
    // Poltava "ГАВ (черга 0)": outside the 1–10 rotation
    expect(queueNames('0')).toEqual([])
    expect(queueNames(9)).toEqual(['9'])
  })

  it('sorts numerically, a reserve queue after its plain one', () => {
    expect(['10', '2', '1(Р)', '1'].sort(compareQueues)).toEqual(['1', '1(Р)', '2', '10'])
  })

  it('omits empty schedules and the whole block when nothing is known', () => {
    expect(emergencyQueues({ gav: ['Не входить'], sgav: [''], achr: [null] })).toBeUndefined()
    expect(emergencyQueues({ gav: ['20', '6', '6'], sgav: ['Не входить'] })).toEqual({ gav: ['6', '20'] })
  })
})

describe('address emergency queues per operator', () => {
  it('Ivano-Frankivsk: current.gav.queue / current.sgav.queue', () => {
    const body = fixture('ivano-frankivsk/schedule-by-search.gav-9.json')
    expect(parseSearchAnswer(body, 200)).toEqual({ group: '1.1', emergency: { gav: ['9'] } })
    // no ГАВ block at all: nothing said
    expect(
      parseSearchAnswer(fixture('ivano-frankivsk/schedule-by-search.found-single.json'), 200),
    ).not.toHaveProperty('emergency')
  })

  it('Ivano-Frankivsk: findGroup carries it', async () => {
    const { fetch } = mockFetch([
      {
        match: 'be-svitlo.oe.if.ua/schedule-by-search',
        method: 'POST',
        body: fixture('ivano-frankivsk/schedule-by-search.gav-9.json'),
      },
    ])
    const c = new OutageClient({ fetch, cacheTtlMs: 0 })
    const m = await c.findGroup('ivano-frankivsk', {
      city: 'Івано-Франківськ',
      street: 'Незалежності',
      house: '1',
    })
    expect(m).toMatchObject({ group: '1.1', emergency: { gav: ['9'] } })
  })

  it('Ternopil: chergGav of building-names', () => {
    const rows = JSON.parse(fixture('ternopil/building-names.city-1032.street-10035.json')).buildingNames
    const byNumber = new Map(buildingNamesToBuildings(rows).map((b) => [b.number, b]))
    expect(byNumber.get('2')).toEqual({ number: '2', groups: ['1.2'], emergency: { gav: ['9'] } })
    // "Не входить": no block
    expect(byNumber.get('1')).toEqual({ number: '1', groups: ['3.2'] })
  })

  it('Zakarpattia: chergGav per row of houses', () => {
    const rows = JSON.parse(fixture('zakarpattia/pw_address_queues.city-769.chergGav-rows.json'))[
      'hydra:member'
    ]
    const byNumber = new Map(queuesToBuildings(rows).map((b) => [b.number, b]))
    // Гагаріна 108 → ГПВ 5.2, ГАВ 10 (АЧР "Не входить", СГАВ empty)
    expect(byNumber.get('108')).toEqual({ number: '108', groups: ['5.2'], emergency: { gav: ['10'] } })
    expect(byNumber.get('101')).toEqual({ number: '101', groups: ['2.1'], emergency: { gav: ['8'] } })
  })

  it('Volyn: the "Черга у ГАВ" column', () => {
    // the live row of 2026-11-16 (research/volyn/gav): Луцьк, Лесі Українки 94 → ГПВ 2.2, ГАВ 4
    const html = `<table class='table table-striped'><tr><td>Район</td><td>Нас. пункт</td><td>Вулиця</td><td>Будинок</td><td>Черга у ГПВ</td><td>Черга у ГАВ</td></tr>
<tr><td>Луцький</td><td>Луцьк</td><td>Лесі Українки</td><td>94, <>, Цент.парк ім.Л.Українки(з</td><td class='text-nowrap'>2.2</td><td class='text-nowrap'>4</td></tr>
<tr><td>Луцький</td><td>Луцьк</td><td>Лесі Українки</td><td>10, 12</td><td class='text-nowrap'>Не залучено</td><td class='text-nowrap'>Не залучено</td></tr></table>`
    const records = parseQueueTable(html)
    expect(records[0]).toMatchObject({ houses: ['94'], group: '2.2', gav: '4' })
    expect(records[1]!.gav).toBeNull()
    expect(matchRecords(records, { city: 'Луцьк', street: 'Лесі Українки', house: '94' })).toMatchObject({
      group: '2.2',
      emergency: { gav: ['4'] },
    })
  })

  it('Sumy: indexes 0 ГАВ, 1 АЧР, 2 СГАВ of queues-by-street', async () => {
    const { fetch } = mockFetch([
      {
        match: 'soe.com.ua/next-api/shutdowns/queues-by-street?',
        body: await encrypt(fixture('sumy/queues-by-street-konotop-2-myru.json')),
      },
    ])
    const c = new OutageClient({ fetch, cacheTtlMs: 0, providers: [sumyProvider()] })
    const m = await c.groupOf(
      'sumy',
      { id: '1', number: '3', streetId: '1' },
      { id: '1', name: 'провулок 2-Й Миру' },
    )
    // ["6","3","2","2.2",…] → ГАВ 6, АЧР 3, СГАВ 2, ГПВ 2.2
    expect(m).toMatchObject({ group: '2.2', emergency: { gav: ['6'], sgav: ['2'], achr: ['3'] } })
  })

  it('Poltava: "залучено до ГАВ (черга N)" in gav_message', () => {
    const samples = JSON.parse(fixture('poltava/result-gav-message-samples.json'))
    const message = (k: string) => samples[k].response[0].gav_message as string
    expect(parseGavMessage(message('вул. Родини Симиренків 10'))).toEqual({ gav: ['10'] })
    // "ГАВ (черга 0), АЧР, СГАВ": a zero queue and bare memberships give nothing to list
    expect(parseGavMessage(message('вул. Олени Пчілки 15'))).toBeUndefined()
    // "залучено до СГАВ, ГПВ (черга 3-1)": СГАВ is not ГАВ
    expect(parseGavMessage(message('вул. Колоритна 11-А'))).toBeUndefined()
    expect(parseGavMessage('')).toBeUndefined()
  })

  it('Mykolaiv: outageType 1 ГАВ and 2 СГАВ', async () => {
    const { fetch } = mockFetch([
      {
        match: '/addr/dom/110035/outage-queue',
        body: fixture('mykolaiv/addr-dom-110035-outage-queue.gav.json'),
      },
    ])
    const m = await mykolaivProvider().groupOf!(
      { http: new Http({ fetch }), now: () => new Date() },
      { id: '110035', number: '1', streetId: '1' },
      { id: '1', name: 'вул. Втората' },
    )
    expect(m).toMatchObject({ group: '4.2', emergency: { gav: ['10'], sgav: ['2'] } })
  })
})

/** The site's payload format: base64(iv ‖ AES-GCM(json)). */
async function encrypt(json: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('qasdw-enjenf-twfeft!!d451qwqw!-2'),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)),
  )
  const all = new Uint8Array(iv.length + ct.length)
  all.set(iv)
  all.set(ct, iv.length)
  return JSON.stringify({ payload: Buffer.from(all).toString('base64') })
}
