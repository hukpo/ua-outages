import { createHash } from 'node:crypto'
import { OutageError } from '../errors.js'
import { compactImage } from '../image/compact.js'
import type { RegionId } from '../types.js'
import { SharedTask } from '../util.js'
import type {
  ImageInput,
  ImageProcessor,
  ImageReading,
  PostAnalysis,
  PostInput,
  PostRegion,
  ProcessedEvent,
  ProcessorCache,
  ProcessorResult,
  TextProcessor,
} from './types.js'
import { validateImageCheck, validateImageReading, validatePostAnalysis } from './validate.js'

export interface AiOptions {
  textProcessor?: TextProcessor
  imageProcessor?: ImageProcessor
  processorCache?: ProcessorCache
  onProcessed?: (e: ProcessedEvent) => void
  /** Processor calls in flight at once, default 4 */
  processorConcurrency?: number
}

/** The default long edge pictures are scaled to before a full read */
export const DEFAULT_MAX_LONG_EDGE = 800
/** …and before the cheap "is it a schedule?" check */
export const CHECK_LONG_EDGE = 256
/** An answer that failed validation is not asked again for this long (each poll would pay) */
const FAILED_TTL_MS = 30 * 60_000

type Entry = { ok: true; value: unknown } | { ok: false; code: 'parse'; message: string; until: number }

/** In-memory LRU: the default `ProcessorCache` */
export class MemoryProcessorCache implements ProcessorCache {
  private readonly map = new Map<string, { value: unknown; until: number }>()
  constructor(private readonly max = 5000) {}
  get(key: string): unknown {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.until && Date.now() > hit.until) {
      this.map.delete(key)
      return undefined
    }
    // most recently used last
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }
  set(key: string, value: unknown, ttlMs?: number): void {
    this.map.delete(key)
    this.map.set(key, { value, until: ttlMs ? Date.now() + ttlMs : 0 })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
}

const sha = (...parts: (string | Uint8Array)[]) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p).update('\u0000')
  return h.digest('hex')
}

/** JSON with sorted keys: the same input always hashes the same */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/** A picture to read, as found */
export interface ImageSource {
  url: string
  bytes: Uint8Array
  caption: string | null
  publishedAt: string
  index?: number
  of?: number
  region: PostRegion
}

/**
 * What providers use to read posts and pictures: the configured processors behind a cache keyed
 * by content, so each post and each distinct picture is parsed once (an edit is new content),
 * with concurrent askers sharing one call. One per client.
 */
export class AiRuntime {
  readonly text?: TextProcessor
  readonly image?: ImageProcessor
  private readonly cache: ProcessorCache
  private readonly emit?: (e: ProcessedEvent) => void
  private readonly inflight = new Map<string, SharedTask<Entry>>()
  private running = 0
  private readonly queue: (() => void)[] = []
  private readonly limit: number

  constructor(opts: AiOptions = {}) {
    this.text = opts.textProcessor
    this.image = opts.imageProcessor
    this.cache = opts.processorCache ?? new MemoryProcessorCache()
    this.emit = opts.onProcessed
    this.limit = Math.max(1, opts.processorConcurrency ?? 4)
  }

  /** Throws `config` when the region needs posts read and no text processor is set */
  requireText(region: RegionId, what = 'its posts'): TextProcessor {
    if (this.text) return this.text
    throw new OutageError(
      'config',
      `${region}: reading ${what} needs a textProcessor (OutageClient option; see ua-outages/anthropic or ua-outages/openai)`,
      { region },
    )
  }

  requireImage(region: RegionId, what = 'its schedule pictures'): ImageProcessor {
    if (this.image) return this.image
    throw new OutageError(
      'config',
      `${region}: reading ${what} needs an imageProcessor (OutageClient option; see ua-outages/anthropic or ua-outages/openai)`,
      { region },
    )
  }

  /** One post → its checked analysis (cached by the whole input) */
  async analyzePost(region: RegionId, input: PostInput, signal?: AbortSignal): Promise<PostAnalysis> {
    const p = this.requireText(region)
    const key = sha('text', p.id, stable(input))
    return this.run(
      key,
      signal,
      { region, type: 'text', url: input.url, processor: p.id },
      async (sig, ev) => {
        const r = await p.analyzePost(input, { signal: sig })
        ev.usage = r.usage
        return validatePostAnalysis(r.value, input)
      },
    ) as Promise<PostAnalysis>
  }

  /**
   * One picture → its checked reading. Keyed by the picture's bytes (a repost or an unchanged
   * edit is the same picture), its caption, region and the processor; compacted only on a miss.
   */
  async readImage(region: RegionId, src: ImageSource, signal?: AbortSignal): Promise<ImageReading> {
    const p = this.requireImage(region)
    const edge = p.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE
    // the picture itself, not where it was found: a repost or an unchanged edit is read once. The
    // caption can date it; an album lets a picture give some of the queues
    const key = sha(
      'image',
      p.id,
      String(edge),
      src.bytes,
      src.caption ?? '',
      src.region.id,
      (src.of ?? 1) > 1 ? 'album' : '',
    )
    return this.run(
      key,
      signal,
      { region, type: 'image', url: src.url, processor: p.id },
      async (sig, ev) => {
        const input = this.imageInput(src, edge, ev)
        const r = await p.readImage(input, { signal: sig })
        ev.usage = r.usage
        return validateImageReading(r.value, input)
      },
    ) as Promise<ImageReading>
  }

  /**
   * The cheap check on a small copy, when the processor has one; otherwise true (the full read
   * says `isSchedule: false` itself).
   */
  async isSchedule(region: RegionId, src: ImageSource, signal?: AbortSignal): Promise<boolean> {
    const p = this.requireImage(region)
    const check = p.isSchedule?.bind(p)
    if (!check) return true
    const key = sha('image-check', p.id, src.bytes, src.caption ?? '')
    return this.run(
      key,
      signal,
      { region, type: 'image-check', url: src.url, processor: p.id },
      async (sig, ev) => {
        const input = this.imageInput(src, CHECK_LONG_EDGE, ev)
        const r: ProcessorResult = await check(input, { signal: sig })
        ev.usage = r.usage
        return validateImageCheck(r.value, input)
      },
    ) as Promise<boolean>
  }

  private imageInput(src: ImageSource, edge: number, ev: Partial<ProcessedEvent>): ImageInput {
    let c
    try {
      c = compactImage(src.bytes, { maxLongEdge: edge })
    } catch (e) {
      throw new OutageError('parse', `${src.url}: ${e instanceof Error ? e.message : String(e)}`, {
        region: src.region.id,
        url: src.url,
        cause: e,
      })
    }
    ev.image = {
      original: { width: c.original.width, height: c.original.height },
      sent: { width: c.width, height: c.height },
      bytes: c.bytes.length,
    }
    return {
      url: src.url,
      index: src.index ?? 0,
      of: src.of ?? 1,
      bytes: c.bytes,
      mediaType: c.mediaType,
      width: c.width,
      height: c.height,
      caption: src.caption,
      publishedAt: src.publishedAt,
      region: src.region,
    }
  }

  private async run(
    key: string,
    signal: AbortSignal | undefined,
    base: Omit<ProcessedEvent, 'cached' | 'ok'>,
    work: (signal: AbortSignal, ev: Partial<ProcessedEvent>) => Promise<unknown>,
  ): Promise<unknown> {
    const hit = (await this.cache.get(key)) as Entry | undefined
    if (hit) {
      this.emit?.({ ...base, cached: true, ok: hit.ok, ...(hit.ok ? {} : { error: hit.message }) })
      if (hit.ok) return hit.value
      if (hit.until > Date.now())
        throw new OutageError('parse', hit.message, { region: base.region, url: base.url })
    }
    let task = this.inflight.get(key)
    if (!task || task.aborted) {
      const t = new SharedTask<Entry>(async (sig) => {
        const ev: Partial<ProcessedEvent> = {}
        try {
          await this.slot(sig)
          let entry: Entry
          try {
            entry = { ok: true, value: await work(sig, ev) }
          } finally {
            this.release()
          }
          await this.cache.set(key, entry)
          this.emit?.({ ...base, ...ev, cached: false, ok: true })
          return entry
        } catch (e) {
          // a misread is remembered for a while; an outage of the AI API is not
          if (e instanceof OutageError && e.code === 'parse') {
            const entry: Entry = {
              ok: false,
              code: 'parse',
              message: e.message,
              until: Date.now() + FAILED_TTL_MS,
            }
            await this.cache.set(key, entry, FAILED_TTL_MS)
          }
          if (!sig.aborted)
            this.emit?.({
              ...base,
              ...ev,
              cached: false,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })
          throw e
        } finally {
          if (this.inflight.get(key) === t) this.inflight.delete(key)
        }
      })
      task = t
      this.inflight.set(key, t)
      t.promise.catch(() => {})
    }
    const entry = await task.join(signal)
    if (!entry.ok) throw new OutageError('parse', entry.message, { region: base.region, url: base.url })
    return entry.value
  }

  private slot(signal: AbortSignal): Promise<void> {
    if (this.running < this.limit) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', onAbort)
        this.running++
        resolve()
      }
      const onAbort = () => {
        const i = this.queue.indexOf(go)
        if (i >= 0) this.queue.splice(i, 1)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(go)
    })
  }

  private release() {
    this.running--
    this.queue.shift()?.()
  }
}
