import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { khmelnytskyiProvider, parseQueues } from '../../src/providers/khmelnytskyi.js'
import { fixture, mockFetch } from '../helpers.js'

const SITE = 'https://hoe.com.ua'

function client(queues = 'khmelnytskyi/shutdown-queues-280957-house-2.html') {
  const { fetch, calls } = mockFetch([
    // the fixture was captured for the term "Хмел"
    { match: `${SITE}/settlements/?term=`, body: fixture('khmelnytskyi/address-1-settlements.json') },
    { match: `${SITE}/streets/26499?term=`, body: fixture('khmelnytskyi/address-2-streets.json') },
    { match: `${SITE}/houses/280957`, body: fixture('khmelnytskyi/address-3-houses.json') },
    { match: `${SITE}/shutdown-queues`, method: 'POST', body: fixture(queues) },
  ])
  return {
    client: new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T23:50:00+02:00'),
      cacheTtlMs: 0,
      providers: [khmelnytskyiProvider()],
    }),
    calls,
  }
}

describe('Khmelnytskoblenergo', () => {
  it('has no machine-readable schedule', async () => {
    await expect(client().client.getSchedules('khmelnytskyi')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('walks settlement → street → house → subgroup', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('khmelnytskyi', {
      city: 'Хмельницький',
      street: 'вул. Проскурівська',
      house: '2',
    })
    expect(m).toEqual({
      region: 'khmelnytskyi',
      group: '6.1',
      address: { city: 'м. Хмельницький', street: 'вул. Проскурівська', house: '2' },
    })
    expect(
      calls.every(
        (x) => (x.init!.headers as Record<string, string>)['X-Requested-With'] === 'XMLHttpRequest',
      ),
    ).toBe(true)
    // the server searches by substring and has no "вул." in its names
    expect(decodeURIComponent(calls[1]!.url)).toBe(`${SITE}/streets/26499?term=проскурівська`)
    expect(String(calls.at(-1)!.init!.body)).toBe('streetId=280957&house=2')
  })

  it('returns every subgroup of a building with several connections', async () => {
    const m = await client('khmelnytskyi/address-5-queues.html').client.findGroup('khmelnytskyi', {
      city: 'Хмельницький',
      street: 'Проскурівська',
      house: '1',
    })
    expect(m).toMatchObject({ group: '1.1', otherGroups: ['3.1', '4.1', '6.1', '6.2'] })
  })

  it('splits the settlement name from its community', async () => {
    const cities = await client().client.searchCities('khmelnytskyi', 'Хмелівка')
    expect(cities).toEqual([
      { id: '26030', name: 'с. Хмелівка', district: 'Городоцька громада' },
      { id: '26772', name: 'с. Хмелівка', district: 'Михайлюцька громада' },
    ])
    await expect(
      client().client.findGroup('khmelnytskyi', { city: 'Хмелівка', street: 'Проскурівська', house: '1' }),
    ).rejects.toThrow(/matches several/)
  })

  it('rejects a changed format', () => {
    expect(() => parseQueues('<!DOCTYPE html><html><title>Помилка</title></html>')).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })
})
