/**
 * Processors for this repo's own scripts (health check, site build, relay, live tests), from the
 * environment: `ANTHROPIC_API_KEY` (model `UA_OUTAGES_MODEL`, default Claude Haiku 5.5), or
 * `OPENAI_API_KEY` with `OPENAI_MODEL`. Neither set: no processors, and the regions that need one
 * answer `config` / `unknown`, as for any client without them.
 *
 * `UA_OUTAGES_PROCESSOR_CACHE=<file>` keeps the answers in a JSON file between runs (the site is
 * rebuilt every 15 minutes: without it every post would be parsed again each time).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { OutageClientOptions, ProcessedEvent, ProcessorCache } from '../src/index.js'

export async function processorsFromEnv(): Promise<
  Pick<OutageClientOptions, 'textProcessor' | 'imageProcessor'>
> {
  const env = process.env
  if (env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const { anthropicImageProcessor, anthropicTextProcessor } = await import('../src/adapters/anthropic.js')
    const o = { client: new Anthropic(), model: env.UA_OUTAGES_MODEL || undefined }
    return { textProcessor: anthropicTextProcessor(o), imageProcessor: anthropicImageProcessor(o) }
  }
  if (env.OPENAI_API_KEY && env.OPENAI_MODEL) {
    const { default: OpenAI } = await import('openai')
    const { openaiImageProcessor, openaiTextProcessor } = await import('../src/adapters/openai.js')
    const o = { client: new OpenAI(), model: env.OPENAI_MODEL }
    return { textProcessor: openaiTextProcessor(o), imageProcessor: openaiImageProcessor(o) }
  }
  console.warn(
    'no ANTHROPIC_API_KEY or OPENAI_API_KEY + OPENAI_MODEL: regions that publish posts or pictures read as config / unknown',
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
