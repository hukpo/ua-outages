import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/index.js'

/**
 * Hits every real source. Run with `npm run test:live`. A `blocked` result is tolerated
 * (bot protection depends on the network you run from); a `parse` error is not.
 */
const client = new OutageClient({ cacheTtlMs: 0 })

describe('live sources', () => {
  for (const region of client.regions()) {
    it(`${region.id} parses`, { timeout: 60_000 }, async () => {
      const [r] = (await client.healthCheck({ regions: [region.id], address: true })).regions
      if (r!.status === 'error') expect(r!.message).toMatch(/^(blocked|network):/)
      if (r!.address && !r!.address.ok) throw new Error(`address lookup: ${r!.address.message}`)
    })
  }
})
