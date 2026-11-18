/**
 * Runs the labelled eval set (`eval/`) against a processor and scores it.
 *
 *   npm run eval -- --backend claude-cli [--model haiku]          Claude via `claude -p` (subscription)
 *   npm run eval -- --backend codex-cli [--model gpt-6.1-terra]   via `codex exec`
 *   npm run eval -- --backend anthropic [--model claude-haiku-5-5] needs ANTHROPIC_API_KEY
 *   npm run eval -- --backend openai --model <id>                 needs OPENAI_API_KEY
 *
 * Options: --only text|image, --filter <substring of the case name>, --tag <tag>, --sample N,
 * --long-edge 800,1100 (image sweep), --min-short-edge 400 (scale thin pictures up until their short side reaches it), --concurrency 4, --effort low|medium|high,
 * --record (save the raw answers to test/fixtures/ai/<backend>/ for the CI replay tests),
 * --price-in / --price-out ($ per 1M tokens, for the cost line).
 *
 * Every answer goes through the SDK's own validation and is compared with the label field by
 * field; a case passes only when every event matches.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { AiRuntime } from '../src/ai/runtime.js'
import type {
  ImageProcessor,
  ImageReading,
  PostAnalysis,
  PostEvent,
  PostInput,
  PostRegion,
  ProcessorResult,
  TextProcessor,
} from '../src/ai/types.js'
import { validateImageReading, validatePostAnalysis } from '../src/ai/validate.js'
import { mapLimit } from '../src/util.js'
import { canon, diffEvents, diffImage, photosMatter, readsPhotos } from '../eval/score.js'
import { claudeCliImage, claudeCliText, codexCliImage, codexCliText } from './cli-processors.js'

const { values: args } = parseArgs({
  options: {
    backend: { type: 'string', default: 'claude-cli' },
    model: { type: 'string' },
    only: { type: 'string' },
    filter: { type: 'string' },
    tag: { type: 'string' },
    'long-edge': { type: 'string' },
    'min-short-edge': { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    effort: { type: 'string' },
    record: { type: 'boolean', default: false },
    'price-in': { type: 'string' },
    'price-out': { type: 'string' },
    verbose: { type: 'boolean', short: 'v', default: false },
    sample: { type: 'string' },
  },
})

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const EVAL = join(ROOT, 'eval')

interface TextCase {
  name: string
  input: PostInput
  expected: PostAnalysis
  tags?: string[]
  uncertain?: boolean
}
interface ImageCase {
  name: string
  input: { url: string; caption: string | null; publishedAt: string; region: PostRegion; file: string }
  expected: ImageReading
  tags?: string[]
  uncertain?: boolean
}

function load<T>(dir: string): (T & { name: string })[] {
  const path = join(EVAL, dir)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(path, f), 'utf8')), name: f.replace(/\.json$/, '') }))
    .filter(
      (c) => (!args.filter || c.name.includes(args.filter)) && (!args.tag || c.tags?.includes(args.tag)),
    )
    .filter((_, i, all) => {
      // --sample N: N cases evenly spread over the sorted list, the same ones every run
      const n = Number(args.sample)
      if (!n || n >= all.length) return true
      return Math.floor((i * n) / all.length) !== Math.floor(((i - 1) * n) / all.length)
    })
}

async function processors(
  edge?: number,
): Promise<{ text: TextProcessor; image: ImageProcessor; tag: string }> {
  const model = args.model
  const effort = args.effort as 'low' | 'medium' | 'high' | undefined
  const minEdge = args['min-short-edge'] ? Number(args['min-short-edge']) : undefined
  switch (args.backend) {
    case 'claude-cli':
      return {
        text: claudeCliText(model),
        image: claudeCliImage(model, edge, minEdge),
        tag: `claude-cli-${model ?? 'haiku'}`,
      }
    case 'codex-cli':
      return {
        text: codexCliText(model, effort),
        image: codexCliImage(model, edge, minEdge, effort),
        tag: `codex-cli-${model ?? 'gpt-6.1-terra'}`,
      }
    case 'anthropic': {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const { anthropicImageProcessor, anthropicTextProcessor } = await import('../src/adapters/anthropic.js')
      const client = new Anthropic()
      const o = { client, model, effort }
      return {
        text: anthropicTextProcessor(o),
        image: anthropicImageProcessor({ ...o, maxLongEdge: edge }),
        tag: `anthropic-${model ?? 'claude-haiku-5-5'}`,
      }
    }
    case 'openai': {
      if (!model) throw new Error('--model is required for openai')
      const { default: OpenAI } = await import('openai')
      const { openaiImageProcessor, openaiTextProcessor } = await import('../src/adapters/openai.js')
      const client = new OpenAI()
      const o = { client, model, reasoningEffort: effort }
      return {
        text: openaiTextProcessor(o),
        image: openaiImageProcessor({ ...o, maxLongEdge: edge, minShortEdge: minEdge }),
        tag: `openai-${model}`,
      }
    }
    case 'replay': {
      // answers recorded earlier (--record): re-score them offline after a change to validation,
      // mapping or labels
      if (!model) throw new Error('--model <recording> is required for replay (a dir in test/fixtures/ai)')
      const dir = join(ROOT, 'test/fixtures/ai', model)
      const read = (kind: string) =>
        existsSync(join(dir, `${kind}.json`))
          ? JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8'))
          : {}
      const text = read('text') as Record<string, unknown>
      const image = read('image') as Record<string, unknown>
      const byUrl = (answers: Record<string, unknown>, kind: string) => {
        const m = new Map<string, unknown>()
        for (const name of Object.keys(answers)) {
          const c = JSON.parse(readFileSync(join(EVAL, kind, `${name}.json`), 'utf8'))
          const index =
            kind === 'image' && c.tags?.includes('album') ? (/-(\d+)$/.exec(name)?.[1] ?? '0') : '0'
          m.set(`${c.input.url}#${index}`, answers[name])
        }
        return m
      }
      const t = byUrl(text, 'text')
      const i = byUrl(image, 'image')
      return {
        text: {
          id: `replay:${model}`,
          analyzePost: async (input) => ({ value: t.get(`${input.url}#0`) ?? null }),
        },
        image: {
          id: `replay:${model}`,
          readImage: async (input) => ({ value: i.get(`${input.url}#${input.index}`) ?? null }),
        },
        // --record then refreshes that recording's pass list in place
        tag: model,
      }
    }
    default:
      throw new Error(`unknown backend ${args.backend}`)
  }
}

/** Records the raw answer of every call, by input url */
function recording<P extends TextProcessor | ImageProcessor>(p: P, sink: Map<string, unknown>): P {
  const wrap =
    (fn: (i: { url: string; index?: number }, o: object) => Promise<ProcessorResult>, kind: string) =>
    async (i: { url: string; index?: number }, o: object) => {
      const r = await fn(i, o)
      sink.set(`${kind}:${i.url}#${i.index ?? 0}`, r.value)
      return r
    }
  const out: Record<string, unknown> = { ...p }
  if ('analyzePost' in p) out.analyzePost = wrap(p.analyzePost.bind(p) as never, 'text')
  if ('readImage' in p) out.readImage = wrap(p.readImage.bind(p) as never, 'image')
  return out as P
}

// --- run ---

interface Result {
  name: string
  ok: boolean
  diffs: string[]
  error?: string
  uncertain?: boolean
  tags?: string[]
}

function report(
  title: string,
  results: Result[],
  usage: { inputTokens: number; outputTokens: number; calls: number },
) {
  const pass = results.filter((r) => r.ok).length
  const sure = results.filter((r) => !r.uncertain)
  console.log(
    `\n=== ${title}: ${pass}/${results.length} pass (${sure.filter((r) => r.ok).length}/${sure.length} excluding uncertain labels)`,
  )
  const byTag = new Map<string, [number, number]>()
  for (const r of results)
    for (const t of r.tags ?? []) {
      const [p, n] = byTag.get(t) ?? [0, 0]
      byTag.set(t, [p + (r.ok ? 1 : 0), n + 1])
    }
  if (byTag.size)
    console.log(
      [...byTag.entries()]
        .sort()
        .map(([t, [p, n]]) => `${t} ${p}/${n}`)
        .join(' · '),
    )
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`✗ ${r.name}${r.uncertain ? ' (uncertain label)' : ''}`)
    if (r.error) console.log(`    error: ${r.error}`)
    for (const d of r.diffs.slice(0, args.verbose ? 50 : 6)) console.log(`    ${d}`)
  }
  const pin = Number(args['price-in'])
  const pout = Number(args['price-out'])
  const cost =
    pin && pout ? ` ≈ $${((usage.inputTokens * pin + usage.outputTokens * pout) / 1e6).toFixed(4)}` : ''
  if (usage.calls)
    console.log(
      `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out over ${usage.calls} calls (${Math.round(usage.inputTokens / usage.calls)} in per call)${cost}`,
    )
}

async function main() {
  const concurrency = Number(args.concurrency)
  const edges = args['long-edge'] ? args['long-edge'].split(',').map(Number) : [undefined]

  if (args.only !== 'image') {
    const cases = load<TextCase>('text')
    const { text, tag } = await processors()
    const raw = new Map<string, unknown>()
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 }
    const ai = new AiRuntime({
      textProcessor: args.record ? recording(text, raw) : text,
      processorConcurrency: concurrency,
      onProcessed: (e) => {
        if (e.cached || !e.usage) return
        usage.inputTokens += e.usage.inputTokens
        usage.outputTokens += e.usage.outputTokens
        usage.calls++
      },
    })
    const results = await mapLimit(cases, concurrency, async (c): Promise<Result> => {
      const base = { name: c.name, uncertain: c.uncertain, tags: c.tags }
      let expected: PostAnalysis
      try {
        expected = validatePostAnalysis(c.expected, c.input)
      } catch (e) {
        return { ...base, ok: false, diffs: [], error: `LABEL INVALID: ${(e as Error).message}` }
      }
      try {
        const got = await ai.analyzePost(c.input.regions[0]!.id, c.input)
        const diffs = diffEvents(expected.events, got.events)
        if (photosMatter(c.input) && readsPhotos(expected) !== readsPhotos(got))
          diffs.push(`reads the photos: want ${readsPhotos(expected)} got ${readsPhotos(got)}`)
        if (args.verbose && diffs.length) diffs.push(`got: ${JSON.stringify(got.events.map(canon))}`)
        return { ...base, ok: !diffs.length, diffs }
      } catch (e) {
        return { ...base, ok: false, diffs: [], error: (e as Error).message }
      }
    })
    report(`text · ${tag}`, results, usage)
    if (args.record) save(tag, 'text', cases, raw, results)
  }

  if (args.only !== 'text') {
    const cases = load<ImageCase>('image')
    for (const edge of edges) {
      const { image, tag } = await processors(edge)
      const raw = new Map<string, unknown>()
      const usage = { inputTokens: 0, outputTokens: 0, calls: 0 }
      const sizes: string[] = []
      const ai = new AiRuntime({
        imageProcessor: args.record ? recording(image, raw) : image,
        processorConcurrency: concurrency,
        onProcessed: (e) => {
          if (e.image) sizes.push(`${e.image.sent.width}×${e.image.sent.height}`)
          if (e.cached || !e.usage) return
          usage.inputTokens += e.usage.inputTokens
          usage.outputTokens += e.usage.outputTokens
          usage.calls++
        },
      })
      const results = await mapLimit(cases, concurrency, async (c): Promise<Result> => {
        const base = { name: c.name, uncertain: c.uncertain, tags: c.tags }
        const bytes = new Uint8Array(readFileSync(resolve(ROOT, c.input.file)))
        // an album's picture may give some of the queues: as in the SDK, it is told it is one of several
        const album = c.tags?.includes('album') ? /-(\d+)$/.exec(c.name) : null
        const src = {
          url: c.input.url,
          bytes,
          caption: c.input.caption,
          publishedAt: c.input.publishedAt,
          region: c.input.region,
          ...(album ? { index: Number(album[1]), of: 2 } : {}),
        }
        try {
          const got = await ai.readImage(c.input.region.id, src)
          const expected = validateImageReading(c.expected, {
            index: 0,
            of: 1,
            ...src,
            mediaType: 'image/png',
            width: 0,
            height: 0,
          })
          const diffs = diffImage(expected, got)
          return { ...base, ok: !diffs.length, diffs }
        } catch (e) {
          return { ...base, ok: false, diffs: [], error: (e as Error).message }
        }
      })
      report(`image · ${tag} · long edge ${edge ?? 'default'}`, results, usage)
      if (args.record) save(`${tag}${edge ? `-${edge}` : ''}`, 'image', cases, raw, results)
    }
  }
}

/** The raw answers, keyed by case, and which cases passed, for the CI replay test */
function save(
  tag: string,
  kind: 'text' | 'image',
  cases: { name: string; input: { url: string } }[],
  raw: Map<string, unknown>,
  results: Result[],
) {
  const dir = join(ROOT, 'test/fixtures/ai', tag)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${kind}.json`)
  const passedFile = join(dir, `${kind}.passed.json`)
  // added to what is recorded already: a later run of some cases replaces just those
  const out: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  for (const c of cases) {
    // an album's pictures share the post's url: the case name ends with the picture's index
    const index =
      kind === 'image' && /album/.test(JSON.stringify(c)) ? (/-(\d+)$/.exec(c.name)?.[1] ?? '0') : '0'
    const v = raw.get(`${kind}:${c.input.url}#${index}`)
    if (v !== undefined && v !== null) out[c.name] = v
  }
  const ran = new Set(results.map((r) => r.name))
  const before: string[] = existsSync(passedFile) ? JSON.parse(readFileSync(passedFile, 'utf8')) : []
  const passed = [...before.filter((n) => !ran.has(n)), ...results.filter((r) => r.ok).map((r) => r.name)]
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 1)}\n`)
  writeFileSync(passedFile, `${JSON.stringify([...new Set(passed)].sort(), null, 1)}\n`)
  console.log(`recorded ${Object.keys(out).length} ${kind} answers (${new Set(passed).size} pass) to ${dir}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
