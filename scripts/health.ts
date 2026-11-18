/**
 * Live health check of every region: `npm run health`. Options after `--`:
 *   --address              also test each region's sample address lookup
 *   --house-outage         also run getHouseOutage on the sample address where supported
 *   --strict               stale data and degraded regions (a channel down) fail the check too
 *   --json                 machine-readable output: the `HealthReport`
 *   --skip a,b             leave out regions known to be unreachable (e.g. behind bot protection)
 *   kyiv lviv              only these regions
 *
 * Exit codes:
 *   0  every source works (without --strict, stale and degraded regions are only shown)
 *   1  something is broken: a region is `error`, or an address lookup or house outage check failed
 *   2  --strict only: nothing is broken, but a region is stale or degraded
 */
import { OutageClient } from '../src/index.js'
import type { Freshness, RegionId } from '../src/index.js'
import { processorOptions } from './processors.js'

const args = process.argv.slice(2)
const skipAt = args.indexOf('--skip')
const skip = new Set(skipAt === -1 ? [] : (args[skipAt + 1] ?? '').split(','))
const named = args.filter((a, i) => !a.startsWith('--') && (skipAt === -1 || i !== skipAt + 1)) as RegionId[]
const strict = args.includes('--strict')
const ai = await processorOptions()
const client = new OutageClient(ai.options)
const all = named.length ? named : client.regions().map((r) => r.id)
const report = await client.healthCheck({
  regions: all.filter((r) => !skip.has(r)),
  address: args.includes('--address'),
  houseOutage: args.includes('--house-outage'),
  strict,
})
const broken = report.regions.some(
  (r) => r.status === 'error' || r.address?.ok === false || r.houseOutage?.ok === false,
)

/** "3 h", "25 min", "2 d" */
const age = (minutes: number) =>
  minutes < 90
    ? `${minutes} min`
    : minutes < 48 * 60
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`

/** "today ✓ tomorrow – · through 2026-11-18 · changed 3 h ago" */
const coverage = (f: Freshness) =>
  `today ${f.today === 'published' ? '✓' : '–'} tomorrow ${f.tomorrow === 'published' ? '✓' : '–'}` +
  (f.coveredThrough ? ` · through ${f.coveredThrough}` : '') +
  (f.ageMinutes === null ? '' : ` · changed ${age(f.ageMinutes)} ago`)

if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  const icon = { ok: '✅', stale: '🟡', empty: '⚪', error: '❌' } as const
  for (const r of report.regions) {
    const addr = r.address
      ? r.address.ok
        ? `  address → ${r.address.group}`
        : `  address ❌ ${r.address.message}`
      : ''
    const house = r.houseOutage
      ? r.houseOutage.ok
        ? `  house → ${r.houseOutage.kind ?? 'no outage'}`
        : `  house ❌ ${r.houseOutage.message}`
      : ''
    console.log(
      `${r.degraded && r.status === 'ok' ? '🟠' : icon[r.status]} ${r.region.padEnd(16)} ${(r.degraded ? `${r.status}*` : r.status).padEnd(6)} ${String(r.groups).padStart(3)} groups ${String(r.latencyMs).padStart(6)} ms` +
        `${r.freshness ? `  ${coverage(r.freshness)}` : ''}${r.message ? `  — ${r.message}` : ''}${addr}${house}`,
    )
    // what the first line's message doesn't already say
    for (const i of r.freshness?.issues ?? [])
      if (['sources-disagree', 'tomorrow-missing', 'partial'].includes(i.code))
        console.log(`     · ${i.code}: ${i.message}`)
    for (const s of r.sources ?? [])
      console.log(
        `     ${s.ok ? (s.disagrees ? '≠' : '✓') : '✗'} ${s.id.padEnd(32)} ` +
          (s.ok
            ? `${s.dates.join(', ') || 'no day used'}${s.updatedAt ? `  published ${s.updatedAt}` : ''}${s.disagrees ? '  (differs from the newest source)' : ''}`
            : `${s.error?.code}: ${s.error?.message}`),
      )
  }
  console.log(
    broken
      ? '\nSome sources are broken.'
      : report.stale || report.degraded
        ? `\nAll sources answer; ${[report.stale && 'some data is stale', report.degraded && 'some regions lost a channel (*)'].filter(Boolean).join(', ')}.`
        : '\nAll sources work.',
  )
}
ai.done()
process.exit(broken ? 1 : report.ok ? 0 : 2)
