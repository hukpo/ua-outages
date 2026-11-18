/**
 * Processors for this repo's own scripts (health check, site build, relay, live tests), from the
 * environment:
 *
 * - `OPENAI_API_KEY`: GPT-6.1 Terra reads posts and pictures (`OPENAI_MODEL` to change it; the
 *   eval measured it: posts 150/150, pictures 76/76).
 * - with `ANTHROPIC_API_KEY` too: the posts that change an emergency state are read again by
 *   Claude Haiku 5.5, and Claude Opus 5.5 judges when the two disagree (`verifyProcessor`,
 *   `judgeProcessor`); on the eval's 37 such posts that settled every disagreement right.
 * - `ANTHROPIC_API_KEY` alone: Claude reads everything (`UA_OUTAGES_MODEL`, default Haiku 5.5:
 *   weaker, especially on pictures).
 *
 * Neither set: no processors, and the regions that need one answer `config` / `unknown`, as for
 * any client without them. `UA_OUTAGES_PROCESSOR_CACHE=<file>` keeps the answers in a JSON file
 * between runs (the site is rebuilt every 15 minutes: without it every post would be parsed
 * again each time).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { OutageClientOptions, ProcessedEvent, ProcessorCache } from '../src/index.js'

const DEFAULT_OPENAI_MODEL = 'gpt-6.1-terra'

export async function processorsFromEnv(): Promise<
  Pick<OutageClientOptions, 'textProcessor' | 'imageProcessor' | 'verifyProcessor' | 'judgeProcessor'>
> {
  const env = process.env
  const anthropic = async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const adapters = await import('../src/adapters/anthropic.js')
    return { client: new Anthropic(), ...adapters }
  }
  if (env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import('openai')
    const { openaiImageProcessor, openaiTextProcessor } = await import('../src/adapters/openai.js')
    const o = { client: new OpenAI(), model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL }
    const out = { textProcessor: openaiTextProcessor(o), imageProcessor: openaiImageProcessor(o) }
    if (!env.ANTHROPIC_API_KEY) return out
    const a = await anthropic()
    return {
      ...out,
      verifyProcessor: a.anthropicTextProcessor({ client: a.client, model: 'claude-haiku-5-5' }),
      judgeProcessor: a.anthropicTextProcessor({ client: a.client, model: 'claude-opus-5-5' }),
    }
  }
  if (env.ANTHROPIC_API_KEY) {
    const a = await anthropic()
    const o = { client: a.client, model: env.UA_OUTAGES_MODEL || undefined }
    return { textProcessor: a.anthropicTextProcessor(o), imageProcessor: a.anthropicImageProcessor(o) }
  }
  console.warn(
    'no OPENAI_API_KEY or ANTHROPIC_API_KEY: regions that publish posts or pictures read as config / unknown',
  )
  return {}
}

/** A `ProcessorCache` in a JSON file: loaded now, written by `save()`. Entries older than 14 days are dropped */
export function fileProcessorCache(path: string): ProcessorCache & { save(): void } {
  const maxAge = 14 * 86_400_000
  let data: Record<string, { v: unknown; at: number; until?: number }> = {}
  if (existsSync(path))
    try {
      data = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      data = {}
    }
  return {
    get(key) {
      const e = data[key]
      if (!e || (e.until && Date.now() > e.until)) return undefined
      return e.v
    },
    set(key, value, ttlMs) {
      data[key] = { v: value, at: Date.now(), ...(ttlMs ? { until: Date.now() + ttlMs } : {}) }
    },
    save() {
      const now = Date.now()
      for (const [k, e] of Object.entries(data)) if (now - e.at > maxAge) delete data[k]
      writeFileSync(path, JSON.stringify(data))
    },
  }
}

/** Processors and, with `UA_OUTAGES_PROCESSOR_CACHE`, the file cache; `done()` saves it and logs the spend */
export async function processorOptions(): Promise<{ options: Partial<OutageClientOptions>; done(): void }> {
  const file = process.env.UA_OUTAGES_PROCESSOR_CACHE
  const cache = file ? fileProcessorCache(file) : undefined
  const spent = { calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0 }
  const onProcessed = (e: ProcessedEvent) => {
    if (e.cached) spent.cached++
    else spent.calls++
    if (!e.ok) spent.failed++
    spent.inputTokens += e.usage?.inputTokens ?? 0
    spent.outputTokens += e.usage?.outputTokens ?? 0
  }
  return {
    options: { ...(await processorsFromEnv()), ...(cache ? { processorCache: cache } : {}), onProcessed },
    done() {
      cache?.save()
      if (spent.calls || spent.cached)
        console.warn(
          `processors: ${spent.calls} calls (${spent.failed} failed), ${spent.cached} from cache, ${spent.inputTokens} in / ${spent.outputTokens} out tokens`,
        )
    },
  }
}
