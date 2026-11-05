import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { splitHouses, zakarpattiaProvider } from '../../src/providers/zakarpattia.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const API = 'https://api-outage-zakarpat-energy.inneti.net/api'

function client(queues = fixture('zakarpattia/pw_address_queues.city-769.street-9373.json')) {
  const { fetch, calls } = mockFetch([
    { match: `${API}/pw_cities?pagination=false`, body: fixture('zakarpattia/pw_cities.json') },
    { match: `${API}/pw_streets?pagination=false&city.id=769`, body: fixture('zakarpattia/pw_streets.city-769.json') },
    { match: `${API}/pw_address_queues?pagination=false&city.id=769&street.id=9373`, body: queues },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [zakarpattiaProvider()] }), calls }
}

describe('Zakarpattiaoblenergo', () => {
  it('has no machine-readable schedule', async () => {
    const { client: c, calls } = client()
    expect(c.region('zakarpattia').capabilities).toEqual({ schedule: false, addressSearch: true })
    await expect(c.getSchedules('zakarpattia')).rejects.toThrow(expect.objectContaining({ code: 'unsupported' }))
    expect(calls).toHaveLength(0)
    const h = await c.healthCheck()
    expect(h.regions[0]!.status).toBe('empty')
  })

  it('finds the group of a house from the per-group house lists', async () => {
    const m = await client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '15' })
    expect(m).toEqual({ region: 'zakarpattia', group: '4.2', address: { city: 'Ужгород', street: 'Корзо', house: '15' } })
  })

  it('returns every group a house is listed under', async () => {
    const m = await client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'вул. Корзо', house: '20' })
    expect(m.group).toBe('4.2')
    expect(m.otherGroups).toEqual(['6.2'])
  })

  it('matches whole house numbers, not substrings', async () => {
    // "5" appears inside "15" and "25"; it is listed only for 4.1
    const m = await client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '5' })
    expect(m).toMatchObject({ group: '4.1' })
    expect(m.otherGroups).toBeUndefined()
    await expect(client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '3' })).rejects.toThrow(
      expect.objectContaining({ code: 'not-found' }),
    )
  })

  it('splits house lists, keeping commas inside parentheses', () => {
    expect(splitHouses(', 10, 17(2поверх,приміщення №2), 22/2, 24 б, б/н')).toEqual([
      '10',
      '17(2поверх,приміщення №2)',
      '22/2',
      '24 б',
      'б/н',
    ])
  })

  it('rejects a changed response format', async () => {
    await expect(
      client('{"rows": []}').client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '15' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('drops the nameless settlement and names the hromada', async () => {
    const cities = await client().client.searchCities('zakarpattia', 'Ужгород')
    expect(cities).toEqual([{ id: '769', name: 'Ужгород', district: 'Ужгородська громада' }])
  })
})
