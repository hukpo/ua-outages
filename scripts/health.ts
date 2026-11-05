/**
 * Live health check of every region: `npm run health` (add `-- --address` to also test lookups,
 * `-- --json` for machine output, `-- kyiv lviv` to limit regions). Exits 1 if anything is broken.
 */
import { OutageClient } from '../src/index.js'
import type { RegionId } from '../src/index.js'

const args = process.argv.slice(2)
const regions = args.filter((a) => !a.startsWith('--')) as RegionId[]
const client = new OutageClient()
const report = await client.healthCheck({
  regions: regions.length ? regions : undefined,
  address: args.includes('--address'),
})

if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  const icon = { ok: '✅', stale: '🟡', empty: '⚪', error: '❌' } as const
  for (const r of report.regions) {
    const addr = r.address ? (r.address.ok ? `  address → ${r.address.group}` : `  address ❌ ${r.address.message}`) : ''
    console.log(
      `${icon[r.status]} ${r.region.padEnd(16)} ${r.status.padEnd(6)} ${String(r.groups).padStart(3)} groups ${String(r.latencyMs).padStart(6)} ms` +
        `${r.updatedAt ? `  updated ${r.updatedAt}` : ''}${r.message && r.status !== 'ok' ? `  — ${r.message}` : ''}${addr}`,
    )
  }
  console.log(report.ok ? '\nAll sources work.' : '\nSome sources are broken.')
}
process.exit(report.ok ? 0 : 1)
