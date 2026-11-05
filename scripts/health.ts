/**
 * Live health check of every region: `npm run health`. Options after `--`:
 *   --address              also test each region's sample address lookup
 *   --json                 machine-readable output
 *   --skip a,b             leave out regions known to be unreachable (e.g. behind bot protection)
 *   kyiv lviv              only these regions
 * Exits 1 if anything is broken.
 */
import { OutageClient } from '../src/index.js'
import type { RegionId } from '../src/index.js'

const args = process.argv.slice(2)
const skipAt = args.indexOf('--skip')
const skip = new Set(skipAt === -1 ? [] : (args[skipAt + 1] ?? '').split(','))
const named = args.filter((a, i) => !a.startsWith('--') && i !== skipAt + 1) as RegionId[]
const client = new OutageClient()
const all = named.length ? named : client.regions().map((r) => r.id)
const report = await client.healthCheck({
  regions: all.filter((r) => !skip.has(r)),
  address: args.includes('--address'),
})

if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  const icon = { ok: '✅', stale: '🟡', empty: '⚪', error: '❌' } as const
  for (const r of report.regions) {
    const addr = r.address
      ? r.address.ok
        ? `  address → ${r.address.group}`
        : `  address ❌ ${r.address.message}`
      : ''
    console.log(
      `${icon[r.status]} ${r.region.padEnd(16)} ${r.status.padEnd(6)} ${String(r.groups).padStart(3)} groups ${String(r.latencyMs).padStart(6)} ms` +
        `${r.updatedAt ? `  updated ${r.updatedAt}` : ''}${r.message && r.status !== 'ok' ? `  — ${r.message}` : ''}${addr}`,
    )
  }
  console.log(report.ok ? '\nAll sources work.' : '\nSome sources are broken.')
}
process.exit(report.ok ? 0 : 1)
