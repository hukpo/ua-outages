/**
 * Collects raw Telegram posts for the AI eval set (eval/raw/<channel>.json).
 *
 *   npx tsx scripts/collect-eval.ts                 # every channel, 3 pages each
 *   npx tsx scripts/collect-eval.ts --pages 5 dtek_ua
 *   npx tsx scripts/collect-eval.ts --around Zaporizhzhyaoblenergo_news/3628   # one page before id+1
 *   npx tsx scripts/collect-eval.ts --regression    # the posts of test/fixtures/telegram/posts.json
 *                                                   # with their metadata, into eval/raw/regression/
 *
 * Reads the public preview `https://t.me/s/<channel>` (`?before=<id>` to page back), sequential
 * requests ~1 s apart. Posts are merged into the existing raw file by id, so re-running adds and
 * refreshes rather than losing older posts. Photo-only posts are kept (their text is '').
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseTelegramPreview, type TelegramPost } from '../src/emergency/telegram.js'

export const CHANNELS = [
  'SumyEnergo',
  'SvitloKropyvnytskyiMisto',
  'SvitloHolovanivskohoRayonu',
  'Ukrenergo',
  'Zaporizhzhyaoblenergo_news',
  'cek_info',
  'chernigivoblenergo',
  'dtek_ua',
  'kharkivenergy',
  'khmelnytskoblenergo',
  'lvivoblenergo',
  'mk_energy_ua',
  'oe_cv_ua',
  'pat_cherkasyoblenergo',
  'poltavaOE',
  'prykarpattyaoblenergo_official',
  'ternopiloblenerho',
  'ztoe_ua',
  'zakarpatenergyofficial',
]

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
let DIR = new URL('../eval/raw/', import.meta.url)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let last = 0
async function page(
  channel: string,
  before: number | null,
): Promise<{ posts: TelegramPost[]; ids: number[] }> {
  const wait = last + 1100 - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'uk,en;q=0.8' },
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const html = await res.text()
  const ids = [...html.matchAll(/data-post="[^"/]+\/(\d+)"/g)].map((m) => Number(m[1]))
  return { posts: parseTelegramPreview(html, { withPhotoOnly: true }), ids }
}

async function load(channel: string): Promise<Map<number, TelegramPost>> {
  try {
    const list = JSON.parse(await readFile(new URL(`${channel}.json`, DIR), 'utf8')) as TelegramPost[]
    return new Map(list.map((p) => [p.id, p]))
  } catch {
    return new Map()
  }
}

async function save(channel: string, byId: Map<number, TelegramPost>): Promise<void> {
  await mkdir(DIR, { recursive: true })
  const list = [...byId.values()].sort((a, b) => a.id - b.id)
  await writeFile(new URL(`${channel}.json`, DIR), JSON.stringify(list, null, 1) + '\n')
}

async function collect(
  channel: string,
  pages: number,
  before: number | null = null,
  keep?: Set<number>,
): Promise<void> {
  const byId = await load(channel)
  let fetched = 0
  for (let i = 0; i < pages; i++) {
    const { posts, ids } = await page(channel, before)
    if (!ids.length) break
    for (const p of posts) if (!keep || keep.has(p.id)) (byId.set(p.id, p), fetched++)
    const oldest = Math.min(...ids)
    if (oldest <= 1 || (before !== null && oldest >= before)) break
    before = oldest
  }
  await save(channel, byId)
  console.log(`${channel}: +${fetched} (total ${byId.size})`)
}

/** Regression posts: one page around each missing one, keeping only the posts named in the fixture */
async function regression(): Promise<void> {
  DIR = new URL('../eval/raw/regression/', import.meta.url)
  const fixture = JSON.parse(
    await readFile(new URL('../test/fixtures/telegram/posts.json', import.meta.url), 'utf8'),
  ) as { posts: Record<string, unknown> }
  const wanted = new Map<string, Set<number>>()
  for (const key of Object.keys(fixture.posts)) {
    const [channel, id] = key.split('/')
    if (!wanted.has(channel!)) wanted.set(channel!, new Set())
    wanted.get(channel!)!.add(Number(id))
  }
  for (const [channel, ids] of wanted) {
    const have = await load(channel)
    for (const id of [...ids].sort((a, b) => b - a)) {
      if (have.has(id)) continue
      await collect(channel, 1, id + 1, ids)
      for (const [k, v] of await load(channel)) have.set(k, v)
      if (!have.has(id)) console.log(`${channel}/${id}: not served`)
    }
  }
}

const args = process.argv.slice(2)
let pages = 3
const around: string[] = []
const channels: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pages') pages = Number(args[++i])
  else if (args[i] === '--around') around.push(args[++i]!)
  else channels.push(args[i]!)
}
if (args.includes('--regression')) {
  await regression()
  process.exit(0)
}
for (const spec of around) {
  const [channel, id] = spec.split('/')
  await collect(channel!, 1, Number(id) + 1)
}
if (!around.length || channels.length)
  for (const c of channels.length ? channels : CHANNELS) await collect(c, pages)
