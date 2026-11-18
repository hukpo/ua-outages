/**
 * Records what the per-house sources say while an emergency (ГАВ / СГАВ) is in force, to verify
 * the mappings that have never been seen live: PowerOn `switchSubReason` 1 / 3, Sumy types 3 / 6,
 * Mykolaiv's per-house ГАВ rows, Poltava's ГАВ wording, Khmelnytskyi's `/shutdown-events`.
 * `npm run capture-gav`. Options after `--`:
 *   --every 10      minutes between `getEmergency` polls (default 10)
 *   --out <dir>     where to write (default research/capture, which git ignores)
 *   --once          capture every region now, emergency or not, and exit (to test the script)
 *   lviv sumy       only these regions (default: every region with a per-house source)
 *
 * When a region's `getEmergency` turns `active`, it runs `getHouseOutage` on the region's sample
 * address and saves that, the raw answers of the per-house endpoints it asked, and one region-wide
 * list where there is one (PowerOn's `pw_accidents` page 1, Mykolaiv's feed of the last hour),
 * which may show ГАВ rows anywhere in the region. A region is captured at most once per 30 minutes
 * while active. Dispatcher notes (`koment`) are redacted except a bare group ("3,1"): they can
 * hold names. DTEK regions are captured only while their site lets the SDK in (it backs off).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OutageClient, kyivDate } from '../src/index.js'
import type { EmergencyStatus, RegionId } from '../src/index.js'
import { createProviders } from '../src/providers/index.js'
import { groupInNote } from '../src/providers/poweron.js'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const everyMin = Number(opt('--every') ?? 10)
const out = opt('--out') ?? 'research/capture'
const once = args.includes('--once')
const valueOf = new Set([opt('--every'), opt('--out')])
const named = args.filter((a) => !a.startsWith('--') && !valueOf.has(a)) as RegionId[]
const REPEAT_MS = 30 * 60_000

/** URLs of the per-house endpoints whose raw answers are worth keeping */
const RAW =
  /pw_accidents|shutdowns\/by-house|outage\/api\/v1\/outage|disconnectinforesult-cabinet|shutdown-events|\/ua\/ajax/

interface Raw {
  method: string
  url: string
  request?: string
  status: number
  body: unknown
}
let recording: Raw[] | null = null

const client = new OutageClient({
  fetch: async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init)
    if (recording && RAW.test(url)) {
      const text = await res.clone().text()
      let body: unknown = text
      try {
        body = redact(JSON.parse(text))
      } catch {
        // HTML (Khmelnytskyi) is kept as text
      }
      recording.push({
        method: init?.method ?? 'GET',
        url,
        ...(typeof init?.body === 'string' || init?.body instanceof URLSearchParams
          ? { request: String(init.body) }
          : {}),
        status: res.status,
        body,
      })
    }
    return res
  },
})

/** `koment` holds dispatchers' notes, names included (Zakarpattia, 17.11.2026): only a group ("ГПВ-6.1") stays */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === 'koment' && typeof x === 'string' && !groupInNote(x) && x.trim() ? '[redacted]' : redact(x),
      ]),
    )
  return v
}

const providers = new Map(createProviders().map((p) => [p.info.id, p]))
const all = client
  .regions()
  .filter((r) => r.capabilities.houseOutage || r.id === 'khmelnytskyi')
  .map((r) => r.id)
const regions = (named.length ? named : all).filter((r) => client.region(r).capabilities.emergency)

/** One region-wide list per region, where the operator has one */
const REGION_WIDE: Partial<Record<RegionId, () => Promise<unknown>>> = {
  lviv: () => get('https://power-api.loe.lviv.ua/api/pw_accidents?page=1'),
  ternopil: () => get('https://api-poweron.toe.com.ua/api/pw_accidents?page=1'),
  zakarpattia: () => get('https://api-outage-zakarpat-energy.inneti.net/api/pw_accidents?page=1'),
  zhytomyr: () => get('https://api-ztoe-poweron.inneti.net/api/pw_accidents?page=1'),
  mykolaiv: () => {
    const now = Math.floor(Date.now() / 1000)
    return post('https://www.energy.mk.ua/outage/api/v1/outage', {
      page: 1,
      perPage: 100,
      from: now - 3600,
      to: now,
    })
  },
}
const get = async (url: string) => redact(await (await fetch(url)).json())
const post = async (url: string, body: unknown) =>
  redact(
    await (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
    ).json(),
  )

const lastCapture = new Map<RegionId, number>()

async function capture(region: RegionId, emergency: EmergencyStatus | null) {
  const p = providers.get(region)!
  const address = (p.houseOutages ?? p).sampleAddress ?? p.sampleAddress
  const at = new Date().toISOString()
  const record: Record<string, unknown> = { region, at, emergency, address }
  recording = []
  try {
    record.houseOutage = address ? await client.getHouseOutage(region, address, { fresh: true }) : null
  } catch (e) {
    record.houseOutageError = e instanceof Error ? e.message : String(e)
  }
  if (region === 'khmelnytskyi' && address) {
    // no per-house source in the SDK yet: its per-address page, raw, for the first sample of an outage
    record.shutdownEvents = await khmelnytskyiEvents().catch((e: unknown) => String(e))
  }
  record.raw = recording
  recording = null
  const wide = REGION_WIDE[region]
  if (wide) record.regionWide = await wide().catch((e: unknown) => String(e))
  // dated and named in Kyiv time, as the operators write it
  const dir = join(out, kyivDate(new Date(at)))
  mkdirSync(dir, { recursive: true })
  const clock = new Date(at).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour12: false })
  const file = join(dir, `${region}-${clock.replace(/:/g, '')}.json`)
  writeFileSync(file, JSON.stringify(record, null, 1))
  lastCapture.set(region, Date.now())
  console.log(`${new Date().toISOString()} ${region}: saved ${file}`)
}

/** Хмельницький, вул. Проскурівська 2 (the provider's sample): street 280957 */
async function khmelnytskyiEvents() {
  const res = await fetch('https://hoe.com.ua/shutdown-events', {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://hoe.com.ua/shutdown/queue',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'streetId=280957&house=2',
  })
  return { status: res.status, body: await res.text() }
}

async function round() {
  for (const region of regions) {
    let e: EmergencyStatus | null = null
    try {
      e = await client.getEmergency(region, { fresh: true })
    } catch (err) {
      console.log(`${new Date().toISOString()} ${region}: getEmergency failed: ${(err as Error).message}`)
      if (!once) continue
    }
    const due = Date.now() - (lastCapture.get(region) ?? 0) > REPEAT_MS
    if (once || (e?.state === 'active' && due)) await capture(region, e)
  }
}

console.log(`Watching ${regions.join(', ')}${once ? ' (once)' : ` every ${everyMin} min`}; writing to ${out}`)
await round()
if (!once) setInterval(() => void round().catch((e) => console.error(e)), everyMin * 60_000)
