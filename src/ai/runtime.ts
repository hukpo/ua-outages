import { createHash } from 'node:crypto'
import { OutageError } from '../errors.js'
import { areaKey } from '../emergency/status.js'
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
import { toAnnouncements } from './map.js'
import { validateImageCheck, validateImageReading, validatePostAnalysis } from './validate.js'

export interface AiOptions {
  textProcessor?: TextProcessor
  /** A second reader of the posts that change an emergency state; see `analyzeEmergencyPost` */
  verifyProcessor?: TextProcessor
  /** A third reader, asked when the first two disagree; the majority of the three decides */
  judgeProcessor?: TextProcessor
  /**
   * Which posts the second reader checks: `emergency` (default), those the first reads as an
   * emergency event (a ГАВ / СГАВ / emergency start, cancel or change); `all`, every post read
   * for an emergency state, which also catches one the first missed (more calls)
   */
  verifyPosts?: 'emergency' | 'all'
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
  readonly verify?: TextProcessor
  readonly judge?: TextProcessor
  private readonly verifyPosts: 'emergency' | 'all'
  readonly image?: ImageProcessor
  private readonly cache: ProcessorCache
  private readonly emit?: (e: ProcessedEvent) => void
  private readonly inflight = new Map<string, SharedTask<Entry>>()
  private running = 0
  private readonly queue: (() => void)[] = []
  private readonly limit: number

  constructor(opts: AiOptions = {}) {
    this.text = opts.textProcessor
    this.verify = opts.verifyProcessor
    this.judge = opts.judgeProcessor
    this.verifyPosts = opts.verifyPosts ?? 'emergency'
    this.image = opts.imageProcessor
    this.cache = opts.processorCache ?? new MemoryProcessorCache()
    this.emit = opts.onProcessed
    const limit = opts.processorConcurrency ?? 4
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 4
    // a reader with the first one's id would answer from its cache: one reading counted twice
    const ids = [this.text?.id, this.verify?.id, this.judge?.id].filter((id): id is string => !!id)
    if (new Set(ids).size !== ids.length)
      throw new OutageError(
        'config',
        'textProcessor, verifyProcessor and judgeProcessor need distinct ids (another model, or a `variant`): ' +
          "a reader with another's id is answered from its cache, and its vote is not a second reading",
      )
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
    return this.readPost(this.requireText(region), undefined, region, input, signal)
  }

  /**
   * One post read for an emergency state. With a `verifyProcessor`, a post the first reader takes
   * for an emergency event (or every post, `verifyPosts: 'all'`) is read again, and what the
   * state machine would get from the two (per region: kind, action, time, queues, whether ГПВ
   * applies, whether it is limited to an area) must agree. When it doesn't, the
   * `judgeProcessor` reads it too and two of the three decide; without a judge, or with three
   * different readings, the post is a `parse` error (an "unclear" event: the state stands).
   * The answer of a reader in the majority is returned, the first's when it is one of them.
   */
  async analyzeEmergencyPost(
    region: RegionId,
    input: PostInput,
    signal?: AbortSignal,
  ): Promise<PostAnalysis> {
    const first = await this.analyzePost(region, input, signal)
    // any region of the channel: a first reading that puts an Odesa cancel under Kyiv must still be
    // checked for Odesa
    if (!this.verify || (this.verifyPosts === 'emergency' && !touchesEmergency(first))) return first
    const key = (a: PostAnalysis) => emergencyKey(a, input, region)
    const firstKey = key(first)
    const second = await this.readOrNull(this.verify, 'verify', region, input, signal)
    if (second && key(second) === firstKey) return first
    const third = this.judge ? await this.readOrNull(this.judge, 'judge', region, input, signal) : null
    const votes = [first, second, third].filter((a): a is PostAnalysis => !!a)
    const keys = votes.map(key)
    const winner = votes.find((_, i) => keys.filter((k) => k === keys[i]).length >= 2)
    if (winner) return winner
    throw new OutageError(
      'parse',
      `${input.url}: the readings of its emergency events disagree (${this.judge ? 'three ways' : 'no judgeProcessor'})`,
      { region, url: input.url },
    )
  }

  /**
   * A second or third reading. One that fails validation is no vote; so is one its API can't
   * give now (overloaded, down): the post is then unclear rather than taken on one reading, and
   * the channel's other posts are still read
   */
  private async readOrNull(
    p: TextProcessor,
    role: 'verify' | 'judge',
    region: RegionId,
    input: PostInput,
    signal?: AbortSignal,
  ): Promise<PostAnalysis | null> {
    try {
      return await this.readPost(p, role, region, input, signal)
    } catch (e) {
      signal?.throwIfAborted()
      if (e instanceof OutageError && (e.code === 'parse' || e.code === 'http' || e.code === 'network'))
        return null
      throw e
    }
  }

  private readPost(
    p: TextProcessor,
    role: 'verify' | 'judge' | undefined,
    region: RegionId,
    input: PostInput,
    signal?: AbortSignal,
  ): Promise<PostAnalysis> {
    const key = sha('text', p.id, stable(input))
    return this.run(
      key,
      signal,
      { region, type: 'text', url: input.url, processor: p.id, ...(role ? { role } : {}) },
      async (sig, ev) => {
        const r = await p.analyzePost(input, { signal: sig })
        ev.usage = r.usage
        return r.value
      },
      (raw) => validatePostAnalysis(raw, input),
    )
  }

  /**
   * One picture → its checked reading. Keyed by the picture's bytes (a repost or an unchanged
   * edit is the same picture), its caption, region and the processor; compacted only on a miss.
   */
  async readImage(region: RegionId, src: ImageSource, signal?: AbortSignal): Promise<ImageReading> {
    const p = this.requireImage(region)
    const edge = p.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE
    const min = p.minShortEdge ?? 0
    // the picture and everything the processor is shown with it, not the post's address: a
    // repost the same day is read once, one a day later is read against its own date
    const key = sha(
      'image',
      p.id,
      String(edge),
      String(min),
      src.bytes,
      src.caption ?? '',
      src.region.id,
      src.publishedAt,
      `${src.index ?? 0}/${src.of ?? 1}`,
    )
    return this.run(
      key,
      signal,
      { region, type: 'image', url: src.url, processor: p.id },
      async (sig, ev) => {
        const input = this.imageInput(src, edge, ev, min)
        const r = await p.readImage(input, { signal: sig })
        ev.usage = r.usage
        return r.value
      },
      (raw) => validateImageReading(raw, this.checkInput(src)),
    )
  }

  /**
   * The cheap check on a small copy, when the processor has one; otherwise true (the full read
   * says `isSchedule: false` itself).
   */
  async isSchedule(region: RegionId, src: ImageSource, signal?: AbortSignal): Promise<boolean> {
    const p = this.requireImage(region)
    const check = p.isSchedule?.bind(p)
    if (!check) return true
    const key = sha('image-check', p.id, src.bytes, src.caption ?? '', src.region.id)
    return this.run(
      key,
      signal,
      { region, type: 'image-check', url: src.url, processor: p.id },
      async (sig, ev) => {
        const input = this.imageInput(src, CHECK_LONG_EDGE, ev)
        const r: ProcessorResult = await check(input, { signal: sig })
        ev.usage = r.usage
        return r.value
      },
      (raw) => validateImageCheck(raw, this.checkInput(src)),
    )
  }

  /** What validation reads of a picture's input (not its pixels): checked again from the cache */
  private checkInput(src: ImageSource): ImageInput {
    return {
      url: src.url,
      index: src.index ?? 0,
      of: src.of ?? 1,
      bytes: new Uint8Array(),
      mediaType: 'image/png',
      width: 0,
      height: 0,
      caption: src.caption,
      publishedAt: src.publishedAt,
      region: src.region,
    }
  }

  private imageInput(
    src: ImageSource,
    edge: number,
    ev: Partial<ProcessedEvent>,
    minShortEdge = 0,
  ): ImageInput {
    let c
    try {
      c = compactImage(src.bytes, { maxLongEdge: edge, minShortEdge })
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

  /**
   * One processor call behind the cache. What is kept is the processor's raw answer, checked
   * (`check`) on every use: a later, stricter validator reaches answers already cached. A misread
   * is remembered for a while; an outage of the AI API is not; a call whose callers all left
   * writes nothing (an abandoned call must not overwrite a newer answer).
   */
  private async run<T>(
    key: string,
    signal: AbortSignal | undefined,
    base: Omit<ProcessedEvent, 'cached' | 'ok'>,
    work: (signal: AbortSignal, ev: Partial<ProcessedEvent>) => Promise<unknown>,
    check: (raw: unknown) => T,
  ): Promise<T> {
    signal?.throwIfAborted()
    const hit = (await this.cache.get(key)) as Entry | undefined
    signal?.throwIfAborted()
    if (hit) {
      this.emit?.({ ...base, cached: true, ok: hit.ok, ...(hit.ok ? {} : { error: hit.message }) })
      if (hit.ok) return check(hit.value)
      if (hit.until > Date.now())
        throw new OutageError('parse', hit.message, { region: base.region, url: base.url })
    }
    let task = this.inflight.get(key)
    if (!task || task.aborted) {
      const t = new SharedTask<Entry>(async (sig) => {
        const ev: Partial<ProcessedEvent> = {}
        try {
          await this.slot(sig)
          let raw: unknown
          try {
            raw = await work(sig, ev)
          } finally {
            this.release()
          }
          check(raw)
          const entry: Entry = { ok: true, value: raw }
          if (!sig.aborted) await this.cache.set(key, entry)
          this.emit?.({ ...base, ...ev, cached: false, ok: true })
          return entry
        } catch (e) {
          if (e instanceof OutageError && e.code === 'parse' && !sig.aborted) {
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
    return check(entry.value)
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

/** The post's events say an emergency measure starts, ends or changes, in any region it reads for */
const touchesEmergency = (a: PostAnalysis) => a.events.some((e) => e.kind !== 'gpv' && e.kind !== 'other')

/**
 * What the state machine (`foldEvents`) gets from an analysis about `region`, in post order:
 * every field it reads. The area by its key ("м. Павлоград" and "м. Павлограді" agree, Павлоград
 * and Дніпро don't); the time as resolved, with its date
 */
function emergencyKey(a: PostAnalysis, input: PostInput, region: RegionId): string {
  const info = input.regions.find((r) => r.id === region)
  if (!info) return ''
  const sorted = (q: readonly string[] | null) => (q ? [...q].sort().join('+') : '-')
  return toAnnouncements(a.events, region, info, input.publishedAt)
    .map((x) =>
      [
        x.kind,
        x.action,
        x.at,
        x.timed,
        sorted(x.queues),
        x.count ?? '-',
        x.all,
        x.partial,
        sorted(x.restored),
        x.add,
        x.again,
        x.edited,
        x.scheduleApplies ?? '-',
        areaKey(x.area) ?? '-',
        x.until ?? '-',
      ].join('|'),
    )
    .join(';')
}
