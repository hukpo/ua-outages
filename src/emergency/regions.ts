import { toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import { aiOf, type ProviderContext } from '../providers/provider.js'
import { abortable } from '../util.js'
import { toAnnouncements } from '../ai/map.js'
import { analyzeAll, channelInputs } from '../ai/posts.js'
import { postRegion } from '../ai/regions.js'
import { OutageError } from '../errors.js'
import { mykolaivFeed, mykolaivFeedStatus, yasnoEmergency, type YasnoEmergency } from './sources.js'
import { foldEvents, type Announcement, type EmergencyEvent } from './status.js'
import { readChannelWindow, type ChannelRead, type TelegramPost } from './telegram.js'

/**
 * Where each region's emergency (ГАВ / СГАВ) announcements come from. Chosen per operator from
 * what it actually publishes (see `research/<region>/GAV.md`):
 *
 * - the operator's Telegram channel, read from its public preview;
 * - YASNO's `EmergencyShutdowns` status for Kyiv and Dnipro (DTEK posts no Dnipro cancels);
 * - Mykolaivoblenergo's outage feed, whose rows name the ГАВ queue;
 * - the national @Ukrenergo channel, only for operators that announce nothing themselves.
 */
export interface EmergencyConfig {
  channels?: ChannelConfig[]
  yasno?: { regionId: number; dsoId: number }
  mykolaivFeed?: boolean
  /** Also read the national @Ukrenergo channel (for operators that announce nothing themselves) */
  ukrenergo?: boolean
  /** An apply without a later word ends after this long, default 12 h */
  ttlHours?: number
}

export interface ChannelConfig {
  handle: string
}

/** How far back announcements are read */
export const LOOKBACK_HOURS = 48
export const DEFAULT_TTL_HOURS = 12

const UKRENERGO = 'Ukrenergo'

const channel = (handle: string): ChannelConfig => ({ handle })

/**
 * Which posts are about which region is the text processor's answer (`PostEvent.regions`): a
 * channel's posts are analysed once for every region it serves (`CHANNEL_REGIONS`).
 */
export const EMERGENCY_REGIONS: Partial<Record<RegionId, EmergencyConfig>> = {
  kyiv: { channels: [channel('dtek_ua')], yasno: { regionId: 25, dsoId: 902 } },
  'kyiv-region': { channels: [channel('dtek_ua')] },
  dnipro: { channels: [channel('dtek_ua')], yasno: { regionId: 3, dsoId: 301 } },
  // YASNO 3/303 never showed EmergencyShutdowns, not even during ЦЕК's own (15.11 13:39–15:27)
  'dnipro-cek': { channels: [channel('cek_info')] },
  odesa: { channels: [channel('dtek_ua')] },
  donetsk: { channels: [channel('dtek_ua')] },
  zaporizhzhia: { channels: [channel('Zaporizhzhyaoblenergo_news')] },
  kharkiv: { channels: [channel('kharkivenergy')] },
  lviv: { channels: [channel('lvivoblenergo')] },
  'ivano-frankivsk': { channels: [channel('prykarpattyaoblenergo_official')] },
  ternopil: { channels: [channel('ternopiloblenerho')] },
  khmelnytskyi: { channels: [channel('khmelnytskoblenergo')] },
  chernihiv: { channels: [channel('chernigivoblenergo')] },
  zhytomyr: { channels: [channel('ztoe_ua')] },
  cherkasy: { channels: [channel('pat_cherkasyoblenergo')] },
  // no main channel: 21 district channels post the same text; the city one stands for all
  kirovohrad: { channels: [channel('SvitloKropyvnytskyiMisto')] },
  // never posts a cancel; the same Ukrenergo commands last minutes to ~4 h in Poltava next door
  sumy: { channels: [channel('SumyEnergo')], ttlHours: 6 },
  poltava: { channels: [channel('poltavaOE')] },
  mykolaiv: { mykolaivFeed: true, channels: [channel('mk_energy_ua')] },
  chernivtsi: { channels: [channel('oe_cv_ua')], ukrenergo: true },
  // the operator's channel announces ГАВ too; the national one stays as the fallback
  zakarpattia: { channels: [channel('zakarpatenergyofficial')], ukrenergo: true },
  volyn: { ukrenergo: true },
  rivne: { ukrenergo: true },
}

/**
 * Shared work of one client: channel pages read once for every region that uses them
 * (@dtek_ua serves five, @Ukrenergo four), kept for a minute.
 */
export class EmergencyHub {
  private readonly channels = new Map<string, { at: number; value: Promise<ChannelRead> }>()
  /** Regions whose YASNO status was EmergencyShutdowns at the last look, and since when */
  private readonly yasnoActive = new Map<RegionId, string>()
  /** …and the YASNO episodes that ended since: posts from before the end don't revive them */
  private readonly yasnoEnded = new Map<RegionId, { since: string | null; endedAt: string }>()

  constructor(private readonly cacheMs = 60_000) {}

  posts(ctx: ProviderContext, region: RegionId, handle: string, fresh: boolean): Promise<ChannelRead> {
    const hit = this.channels.get(handle)
    const now = ctx.now()
    if (!fresh && hit && Date.now() - hit.at < this.cacheMs) return abortable(hit.value, ctx.signal)
    const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000)
    const value = readChannelWindow(ctx, handle, { region, since })
    const entry = { at: Date.now(), value }
    // a cancellable read isn't shared while it runs, so no other caller inherits its cancellation
    if (ctx.signal)
      value.then(
        () => this.channels.set(handle, entry),
        () => {},
      )
    else {
      this.channels.set(handle, entry)
      value.catch(() => {
        if (this.channels.get(handle) === entry) this.channels.delete(handle)
      })
    }
    return value
  }

  /**
   * YASNO's status combined with the posts. EmergencyShutdowns is the machine-readable "on now".
   * YASNO not showing it says nothing by itself: it never flags some emergencies (partial
   * areas; ЦЕК never), and `updatedOn` moves with every schedule. Only an episode YASNO itself
   * showed, and has stopped showing, is ended by it (DTEK posts no Dnipro cancels).
   */
  withYasno(
    posts: EmergencyStatus | null,
    y: YasnoEmergency,
    region: RegionId,
    fetchedAt: string,
    previous?: EmergencyStatus,
  ): EmergencyStatus | null {
    // after a restart the caller's last status stands in for what this client saw; an `unknown`
    // one too (YASNO's end, made unknown because another source failed then)
    if (previous?.source === 'yasno' && !this.yasnoActive.has(region) && !this.yasnoEnded.has(region)) {
      if (previous.state === 'active') this.yasnoActive.set(region, previous.since ?? previous.fetchedAt)
      else if (previous.endedAt)
        this.yasnoEnded.set(region, { since: previous.since, endedAt: previous.endedAt })
    }
    if (y.active) {
      this.yasnoEnded.delete(region)
      const since = this.yasnoActive.get(region) ?? y.changedAt ?? fetchedAt
      this.yasnoActive.set(region, since)
      if (posts?.state === 'active') return { ...posts, source: 'yasno' }
      return {
        region,
        state: 'active',
        kind: 'emergency',
        scheduleApplies: false,
        since,
        endedAt: null,
        queues: null,
        queueCount: null,
        area: null,
        inferred: false,
        message: { text: `YASNO: ${y.status}`, url: null, at: y.changedAt ?? fetchedAt },
        source: 'yasno',
        fetchedAt,
      }
    }
    const seen = this.yasnoActive.get(region)
    if (seen) {
      this.yasnoActive.delete(region)
      const endedAt = y.changedAt && Date.parse(y.changedAt) >= Date.parse(seen) ? y.changedAt : fetchedAt
      this.yasnoEnded.set(region, { since: posts?.since ?? seen, endedAt })
    }
    const ended = this.yasnoEnded.get(region)
    if (!ended) return posts
    // a post newer than YASNO's switch back (a new apply, or a cancel) is the newer word; the
    // apply posts from before it are what YASNO ended
    if (posts?.message && Date.parse(posts.message.at) > Date.parse(ended.endedAt)) {
      if (posts.state === 'active') this.yasnoEnded.delete(region)
      return posts
    }
    return {
      region,
      state: 'inactive',
      kind: posts?.kind ?? 'emergency',
      scheduleApplies: true,
      since: ended.since,
      endedAt: ended.endedAt,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: { text: `YASNO: EmergencyShutdowns → ${y.status}`, url: null, at: ended.endedAt },
      source: 'yasno',
      fetchedAt,
    }
  }
}

/**
 * Telegram posts → the events about `region`, oldest first. A post whose answer failed
 * validation is an "unclear" event: while it is the newest word the status is `unknown`, never a
 * guess. Exported for tests.
 */
export async function channelEvents(
  ctx: ProviderContext,
  region: RegionId,
  posts: readonly TelegramPost[],
): Promise<EmergencyEvent[]> {
  const info = postRegion(region)
  const events: EmergencyEvent[] = []
  for (const { input, analysis } of await analyzeAll(ctx, region, channelInputs(posts, region), {
    emergency: true,
  })) {
    const post = { text: input.text, url: input.url, posted: input.publishedAt }
    if (!analysis) {
      events.push({ ...post, announcement: unclear(input.publishedAt) })
      continue
    }
    for (const a of toAnnouncements(analysis.events, region, info, input.publishedAt))
      events.push({ ...post, announcement: a })
  }
  return events
}

const unclear = (at: string): Announcement => ({
  action: 'unclear',
  kind: 'emergency',
  at,
  timed: false,
  queues: null,
  restored: null,
  count: null,
  all: false,
  add: false,
  again: false,
  partial: false,
  scheduleApplies: null,
  area: null,
  edited: false,
})

export interface EmergencyRequest {
  ctx: ProviderContext
  region: RegionId
  fresh: boolean
  /** The status the caller got last time (kept across restarts): see `EmergencyOptions.previous` */
  previous?: EmergencyStatus
}

/**
 * The region's emergency status from its sources. A source that fails is skipped when another
 * answers; only when all fail is the first error thrown. Silence is never an error: no
 * announcement in the lookback window is `inactive` with `kind: null`.
 *
 * A failed source, or a channel read that ran out of pages before the TTL window, makes the
 * answer partial: "nothing in force" from the rest is `unknown`, and an episode the caller saw
 * (`previous`) keeps its details while what is left says only that it is on.
 */
export async function getEmergency(
  hub: EmergencyHub,
  cfg: EmergencyConfig,
  { ctx, region, fresh, previous: given }: EmergencyRequest,
): Promise<EmergencyStatus> {
  const now = ctx.now()
  const previous = given?.region === region ? given : undefined
  const ttlHours = cfg.ttlHours ?? DEFAULT_TTL_HOURS
  const errors: unknown[] = []
  /** A channel read that didn't reach back the TTL: an apply it missed may still be in force */
  let short = false
  const channelPosts = async (handle: string) => {
    // nothing to read the posts with: not worth fetching them
    aiOf(ctx).requireText(region)
    const read = await hub.posts(ctx, region, handle, fresh)
    if (Date.parse(read.from) > now.getTime() - ttlHours * 3600_000) short = true
    return read.posts
  }
  const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (e) {
      ctx.signal?.throwIfAborted()
      errors.push(e)
      return undefined
    }
  }

  const [telegram, yasno, feed, national] = await Promise.all([
    cfg.channels?.length
      ? attempt(async () => {
          const lists = await Promise.all(
            cfg.channels!.map(async (c) => channelEvents(ctx, region, await channelPosts(c.handle))),
          )
          return lists.flat().sort((a, b) => Date.parse(a.posted) - Date.parse(b.posted))
        })
      : undefined,
    cfg.yasno ? attempt(() => yasnoEmergency(ctx, region, cfg.yasno!.regionId, cfg.yasno!.dsoId)) : undefined,
    cfg.mykolaivFeed
      ? attempt(async () =>
          mykolaivFeedStatus(
            await mykolaivFeed(
              ctx,
              region,
              new Date(now.getTime() - 12 * 3600_000),
              new Date(now.getTime() + 3600_000),
            ),
            region,
            now,
          ),
        )
      : undefined,
    cfg.ukrenergo
      ? attempt(async () => channelEvents(ctx, region, await channelPosts(UKRENERGO)))
      : undefined,
  ])

  const sourcesAnswered = [telegram, yasno, feed, national].some((x) => x !== undefined)
  if (!sourcesAnswered) {
    // the posts can't be read without a text processor: not known, rather than an error
    const config = errors.find((e) => e instanceof OutageError && e.code === 'config') as
      OutageError | undefined
    if (config && errors.every((e) => e instanceof OutageError && e.code === 'config'))
      return {
        ...foldEvents([], { region, now, ttlHours, source: 'telegram' }),
        state: 'unknown',
        message: { text: config.message, url: null, at: toKyivIso(now) },
      }
    throw errors[0]
  }

  const fetchedAt = toKyivIso(now)
  const fold = (events: EmergencyEvent[], source: EmergencyStatus['source']) =>
    foldEvents(events, { region, now, ttlHours, source, previous })

  // the operator's channel and the national one (Chernivtsi), merged by time: a newer
  // @Ukrenergo apply naming the oblast is newer news than the channel's cancel of yesterday
  let status: EmergencyStatus | null = null
  if (telegram || national) {
    const events = [...(telegram ?? []), ...(national ?? [])].sort(
      (a, b) => Date.parse(a.posted) - Date.parse(b.posted),
    )
    status = fold(events, telegram ? 'telegram' : 'ukrenergo')
    if (status.message?.url?.startsWith(`https://t.me/${UKRENERGO}/`))
      status = { ...status, source: 'ukrenergo' }
  }

  // Mykolaiv: running feed rows name queues and times, and win. Finished rows are an end
  // inferred from the feed; the channel wins over them only when it says it is on, or with a
  // cancel newer than the feed's episode (not yesterday's 19:09 cancel before tonight's rows),
  // or with an episode of its own after the feed's
  if (feed) {
    const posted = status?.message ? Date.parse(status.message.at) : NaN
    const channelNewer =
      status?.state === 'active' ||
      (status?.state === 'inactive' &&
        posted > Date.parse((status.inferred ? feed.endedAt : null) ?? feed.since ?? ''))
    if (feed.state === 'active' || !channelNewer) status = { ...feed, fetchedAt }
  }

  if (yasno) status = hub.withYasno(status, yasno, region, fetchedAt, previous)
  status ??= fold([], telegram ? 'telegram' : 'ukrenergo')

  if (!errors.length && !short) return status
  // a source failed: "nothing in force" from the others alone isn't known
  if (status.state === 'inactive') return { ...status, state: 'unknown' }
  if (status.state === 'active') return carryOver(status, previous, now, ttlHours)
  return status
}

/**
 * A source down mid-episode (t.me while YASNO still shows EmergencyShutdowns; the Mykolaiv feed
 * while the channel's apply stands): what is left says it is on, but knows less. The episode the
 * caller saw (`previous`, active within the TTL) keeps its kind, queues, area, start and message,
 * so nothing seems to change; a newer word from the source that works is news and is taken.
 */
function carryOver(
  s: EmergencyStatus,
  previous: EmergencyStatus | undefined,
  now: Date,
  ttlHours: number,
): EmergencyStatus {
  if (previous?.state !== 'active') return s
  if (now.getTime() - Date.parse(previous.fetchedAt) > ttlHours * 3600_000) return s
  const since =
    [s.since, previous.since]
      .filter((x): x is string => !!x)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
  // YASNO's own "EmergencyShutdowns" says nothing but "on"
  const bare = s.source === 'yasno' && s.message?.url === null && s.message.text.startsWith('YASNO:')
  const newer =
    !bare && !!s.message && (!previous.message || Date.parse(s.message.at) > Date.parse(previous.message.at))
  if (newer) return { ...s, since }
  return {
    ...s,
    kind: previous.kind,
    scheduleApplies: previous.scheduleApplies,
    since,
    queues: previous.queues,
    queueCount: previous.queueCount,
    area: previous.area,
    message: previous.message,
  }
}
