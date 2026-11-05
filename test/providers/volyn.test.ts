import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseQueueTable, volynProvider } from '../../src/providers/volyn.js'
import { fixture, mockFetch } from '../helpers.js'

const FORM = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/'
const RESULT = fixture('volyn/cherga-lutsk-vynnychenka.trimmed.html')

function client(body = RESULT) {
  const { fetch, calls } = mockFetch([{ match: FORM, method: 'POST', body }])
  return { client: new OutageClient({ fetch, now: () => new Date('2026-11-05T23:50:00+02:00'), cacheTtlMs: 0, providers: [volynProvider()] }), calls }
}

describe('Volynoblenergo', () => {
  it('has no machine-readable schedule', async () => {
    const c = client().client
    expect(c.region('volyn').capabilities).toEqual({ schedule: false, addressSearch: true })
    await expect(c.getSchedules('volyn')).rejects.toMatchObject({ code: 'unsupported' })
    expect((await c.healthCheck()).regions[0]).toMatchObject({ status: 'empty' })
  })

  it('posts bare names and finds the group of a house', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('volyn', { city: 'м. Луцьк', street: 'вул. Винниченка', house: '8' })
    expect(m).toEqual({ region: 'volyn', group: '4.2', address: { city: 'Луцьк', street: 'Винниченка', house: '8' } })
    const body = new URLSearchParams(String(calls[0]!.init!.body))
    expect([body.get('formCity'), body.get('formStreet')]).toEqual(['Луцьк', 'Винниченка'])
  })

  it('collects the groups of every record listing the house', async () => {
    // "1" is in a record with 1.2 and in one that isn't part of the schedule
    expect(await client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '1' })).toMatchObject({
      group: '1.2',
    })
    expect(await client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '47А' })).toMatchObject({
      group: '4.1',
    })
  })

  it('explains houses outside the hourly schedule', async () => {
    await expect(client().client.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '13' })).rejects.toThrow(
      /Не залучено/,
    )
  })

  it('reports an unknown address', async () => {
    const c = client(fixture('volyn/cherga-not-found.trimmed.html')).client
    await expect(c.findGroup('volyn', { city: 'Луцьк', street: 'Неіснуюча', house: '1' })).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('splits house lists and drops placeholders', () => {
    const rows = parseQueueTable(RESULT)
    expect(rows[1]).toEqual({ district: 'Луцький', city: 'Луцьк', street: 'Винниченка', houses: ['1', '2', '62'], group: '1.2' })
    expect(rows[0]!.group).toBeNull()
  })

  it('rejects a changed format', () => {
    expect(() => parseQueueTable('<p>Сервіс тимчасово недоступний</p>')).toThrow(expect.objectContaining({ code: 'parse' }))
    expect(() => parseQueueTable(RESULT.replace('Черга у ГПВ', 'Група'))).toThrow(/header/)
  })
})
