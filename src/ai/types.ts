import type { RegionId } from '../types.js'

/**
 * Pluggable readers of what operators write for people: posts (Telegram, site news) and
 * schedule pictures. The SDK holds no API key and depends on no AI vendor; a processor is
 * anything that answers with JSON in the shape below. Ready-made ones for Anthropic and OpenAI
 * are in `ua-outages/anthropic` and `ua-outages/openai`.
 *
 * Processors answer `unknown`: the SDK validates every answer (real times and dates, queues the
 * region has) and treats one that fails as a `parse` error. It never guesses.
 */

/** A region a post may be about, with the queue names the answer may use */
export interface PostRegion {
  id: RegionId
  name: string
  /** Hourly-schedule (ГПВ) queues, normalized "1.1", "1.2"… */
  queues: readonly string[]
  /** Emergency (ГАВ/СГАВ) queues when the operator has a fixed set ("1"…"10"); empty when not */
  emergencyQueues: readonly string[]
}

/**
 * One post, as one unit: its own text, the post it replies to, how many photos it carries. The
 * same input always gives the same answer, so it is what the answer is cached by.
 */
export interface PostInput {
  /** The post's link (t.me/<channel>/<id>, or the article's) */
  url: string
  source: { kind: 'telegram'; channel: string } | { kind: 'site'; site: string }
  /** When it was posted (an edit keeps it), ISO with the Kyiv offset */
  publishedAt: string
  /** Telegram marks it edited (the edit time isn't shown) */
  edited: boolean
  /** Site articles have titles; Telegram posts don't */
  title: string | null
  text: string
  /** The post this one replies to, as quoted above it */
  replyTo: { url: string | null; text: string } | null
  /** Photos attached (an album has several) */
  photoCount: number
  /** The regions this source covers: a shared channel (@dtek_ua, @Ukrenergo) names several */
  regions: readonly PostRegion[]
}

export type EventKind = 'gpv' | 'gav' | 'sgav' | 'emergency' | 'other'
export type EventAction = 'start' | 'cancel' | 'change'

/** "HH:MM" Kyiv time; `to` may be "24:00" */
export interface ClockInterval {
  from: string
  to: string
  kind: 'off' | 'maybe'
}

/**
 * One thing a post announces.
 *
 * - `gpv`: the hourly schedule. `start`: the schedule for `date` (in `schedule`); `change`: a
 *   correction from `at` on; `cancel`: the day's schedule is called off or won't apply.
 * - `gav`, `sgav`: the emergency schedules (ГАВ, СГАВ); `emergency`: emergency shutdowns that
 *   name neither ("екстрені / аварійні відключення"). `start`: in force (new, more queues, or
 *   still on); `cancel`: lifted (all, or the queues in `queues`); `change`: the set of queues off
 *   changed.
 * - `other`: anything else (repairs, damage, explainers, appeals, a general note on how ГАВ
 *   works). `action` is null.
 */
export interface PostEvent {
  kind: EventKind
  action: EventAction | null
  /** Ids from the input's `regions` this is about */
  regions: string[]
  /** The part of the region ("м. Павлоград", "Бучанський район"); null = the whole region */
  area: string | null
  /** The day it is about, "YYYY-MM-DD"; null = the day of the post */
  date: string | null
  /** "HH:MM" when it takes effect, if the text says; null = at the post time */
  at: string | null
  /**
   * gav/sgav/emergency start: "HH:MM" it is said to last at least until ("до кінця доби":
   * "24:00"); gpv start for a window of the day ("з 10:00 до 16:00"): the window's end
   */
  until: string | null
  /** gav/sgav/emergency: "в повному обсязі", every queue */
  allQueues: boolean
  /** gav/sgav/emergency: queues off (start, change) or switched back on (cancel) */
  queues: string[]
  /** gav/sgav/emergency start/change: queues switched back on ("1-5 ввімкнені") */
  queuesRestored: string[]
  /** gav/sgav/emergency: "N черг" when the queues aren't named */
  queueCount: number | null
  /** start: adds to what is in force ("додатково") rather than replacing it */
  additive: boolean
  /** start: "знову введені" — in force again after being lifted */
  again: boolean
  /** The hourly schedule applies alongside (true), is suspended (false), not said (null) */
  gpvApplies: boolean | null
  /** A line added to an earlier post by an edit ("UPD: скасовано") */
  addedInEdit: boolean
  /** cancel: "до окремого розпорядження" — also void for the days after, until a new order */
  untilFurtherNotice: boolean
  /** gpv start/change: per queue the hours; `intervals: null` = named without hours */
  schedule: { queue: string; intervals: ClockInterval[] | null }[]
}

export interface PostAnalysis {
  events: PostEvent[]
  /** The post's photos show an outage schedule (ГПВ, ГАВ or СГАВ table or poster) */
  photosAreSchedules: boolean
  /** "станом на 21:25", "(оновлено 21:25)": the time the post says it was stated, "HH:MM" */
  statedAt: string | null
}

/** One picture: after `compactImage`, a PNG at most `maxLongEdge` on its long side */
export interface ImageInput {
  /** Where it was found (the post, or the image's own URL) */
  url: string
  /** Its place in an album, 0-based, of `of` */
  index: number
  of: number
  bytes: Uint8Array
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** The post's text, or null for a bare picture */
  caption: string | null
  /** ISO, Kyiv offset */
  publishedAt: string
  region: PostRegion
}

export interface ImageReading {
  /** A table or poster of outage hours per queue */
  isSchedule: boolean
  kind: 'gpv' | 'gav' | 'sgav' | null
  /** The day it is for, "YYYY-MM-DD" */
  date: string | null
  /** "станом на 18:00", "оновлено 21:25" on the picture, "HH:MM" */
  statedAt: string | null
  /** Every queue of the region, each with its hours (none = no outages) */
  schedule: { queue: string; intervals: ClockInterval[] }[]
}

export interface ProcessorUsage {
  inputTokens: number
  outputTokens: number
}

export interface ProcessorResult<T = unknown> {
  value: T
  usage?: ProcessorUsage
}

export interface CallOptions {
  signal?: AbortSignal
}

/** Reads posts. Answers a `PostAnalysis`-shaped value; the SDK validates it. */
export interface TextProcessor {
  /** Vendor, model and prompt version ("anthropic:claude-haiku-5-5:p1"): part of the cache key */
  readonly id: string
  analyzePost(input: PostInput, opts: CallOptions): Promise<ProcessorResult>
}

/** Reads schedule pictures. Answers an `ImageReading`-shaped value; the SDK validates it. */
export interface ImageProcessor {
  readonly id: string
  readImage(input: ImageInput, opts: CallOptions): Promise<ProcessorResult>
  /**
   * Optional cheap check on a small copy (about 256 px): is this a schedule at all? Used for
   * bare photos whose post says nothing, so photos of repair crews aren't read in full.
   */
  isSchedule?(input: ImageInput, opts: CallOptions): Promise<ProcessorResult>
  /** Long edge, px, the picture is scaled down to before `readImage`; default 800 */
  readonly maxLongEdge?: number
  /**
   * A smaller picture is scaled up by a whole factor, pixel for pixel, while its long edge stays
   * within this; default none. Helps a model read a dense grid posted small (Zakarpattia's 800×210)
   */
  readonly minLongEdge?: number
}

/**
 * Where answers are kept, so each post and picture is parsed once. Keys are hashes of the
 * processor id and the whole input; values are plain JSON. The default keeps ~5000 in memory;
 * pass a persistent one so a restart doesn't parse again.
 */
export interface ProcessorCache {
  get(key: string): unknown | Promise<unknown>
  set(key: string, value: unknown, ttlMs?: number): void | Promise<void>
}

/** Reported after every post or picture handled, cached or not: for logging and cost tracking */
export interface ProcessedEvent {
  region: RegionId
  type: 'text' | 'image' | 'image-check'
  url: string
  processor: string
  cached: boolean
  ok: boolean
  error?: string
  usage?: ProcessorUsage
  image?: {
    original: { width: number; height: number }
    sent: { width: number; height: number }
    bytes: number
  }
}
