/**
 * The relay: some operators refuse servers outside Ukraine (a Cloudflare challenge for data
 * centres, or no route at all), so GitHub's runners can't read them. Run this on any machine in
 * Ukraine (a laptop, a Raspberry Pi, a VPS) every 15 minutes; it reads those regions and
 * force-pushes the result as `relay.json` to the `relay` branch, a single orphan commit. The site
 * build uses it for a region it couldn't reach itself, while the relay's data is fresh.
 *
 *   npx tsx site/scripts/relay.ts            print what it collects
 *   npx tsx site/scripts/relay.ts --push     … and publish it
 *   npx tsx site/scripts/relay.ts --push kharkiv poltava    only these regions
 *
 * Pushing uses this checkout's `origin` and your git credentials.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OutageClient } from '../../src/index.js'
import type { RegionId } from '../../src/index.js'
import { mapLimit } from '../../src/util.js'
import { RELAY_BRANCH, RELAYED, collect, logEntry } from './collect.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const push = args.includes('--push')
const named = args.filter((a) => !a.startsWith('--')) as RegionId[]

const client = new OutageClient({ cacheTtlMs: 0, timeoutMs: 25_000, retries: 2 })
const now = new Date()
const wanted = named.length ? named : RELAYED
const regions = await mapLimit(
  client.regions().filter((r) => wanted.includes(r.id)),
  4,
  (info) => collect(client, info, now),
)
regions.forEach(logEntry)

if (push) {
  const ok = regions.filter((r) => r.ok)
  if (!ok.length) {
    console.error('nothing collected, not publishing')
    process.exit(1)
  }
  const origin = execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  const dir = mkdtempSync(join(tmpdir(), 'ua-outages-relay-'))
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
    writeFileSync(join(dir, 'relay.json'), JSON.stringify({ generatedAt: now.toISOString(), regions: ok }))
    git('init', '-q', '-b', RELAY_BRANCH)
    git('add', 'relay.json')
    git(
      '-c',
      'user.name=ua-outages relay',
      '-c',
      'user.email=relay@users.noreply.github.com',
      'commit',
      '-q',
      '-m',
      `relay ${now.toISOString()}`,
    )
    git('push', '-q', '--force', origin, `HEAD:refs/heads/${RELAY_BRANCH}`)
    console.log(`published ${ok.length} regions to ${RELAY_BRANCH}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
