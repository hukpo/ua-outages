import { toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import type { ProviderContext } from '../providers/provider.js'
import { abortable } from '../util.js'
import { classifyPostAll, classifyUkrenergo, districtArea, type Dialect } from './classify.js'
import { mykolaivFeed, mykolaivFeedStatus, yasnoEmergency, type YasnoEmergency } from './sources.js'
import { foldEvents, type EmergencyEvent } from './status.js'
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
  /**
   * The oblast's names in Ukrenergo posts, as pattern stems ("Волинськ|Волин": "Волинській
   * області", "на Волині"), for the national fallback. Case-sensitive: "Рівн" alone is "рівня"
   */
  ukrenergo?: string
  /** An apply without a later word ends after this long, default 12 h */
  ttlHours?: number
}

export interface ChannelConfig {
  handle: string
  dialect?: Dialect
  /** Shared channels: is a post about this region? */
  about?: (text: string) => boolean
}

/** How far back announcements are read */
export const LOOKBACK_HOURS = 48
export const DEFAULT_TTL_HOURS = 12

const UKRENERGO = 'Ukrenergo'

// --- DTEK's group-wide channel: "Київ: …", "Київщина, Бучанський район: …", "Дніпро: …" ---

interface DtekArea {
  /** The prefix names this region */
  own: RegExp
  /** Prefix parts that mean the whole region */
  whole: string[]
}

const DTEK_AREAS: Record<'kyiv' | 'kyiv-region' | 'dnipro' | 'odesa' | 'donetsk', DtekArea> = {
  kyiv: { own: /Київ(?![\p{L}])|Києв|Києві|столиц/u, whole: ['київ', 'місто київ', 'столиця'] },
  'kyiv-region': {
    own: /Київщин|Київськ/u,
    whole: ['київщина', 'київська область', 'київська', 'київської області'],
  },
  // the city and the oblast, not Kyiv's "Дніпровський район" or "Дніпровська набережна"
  dnipro: {
    own: /Дніпро(?![\p{L}])|Дніпр[аіу](?![\p{L}])|Дніпропетров|Дніпровщин/u,
    whole: ['дніпропетровщина', 'дніпропетровська область', 'дніпропетровська'],
  },
  odesa: { own: /Одес|Одещин/u, whole: ['одещина', 'одеська область', 'одеська'] },
  donetsk: { own: /Донеч|Донецьк/u, whole: ['донеччина', 'донецька область', 'донецька'] },
}

/** "‼️Київ та Київська область: …" → "Київ та Київська область"; null without a prefix. Exported for tests. */
export function dtekHead(text: string): string | null {
  const line = text.trim().split('\n')[0] ?? ''
  const m = /^[^\p{L}]*([^:]{2,160}):/u.exec(line)
  return m ? m[1]!.trim() : null
}

/** "Київ, Київська та Дніпропетровська область" → its parts; commas in parentheses stay. Exported for tests. */
export function headParts(head: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < head.length; i++) {
    const ch = head[i]!
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    const sep = depth === 0 && (ch === ',' || head.startsWith(' та ', i))
    if (sep) {
      out.push(cur)
      cur = ''
      if (ch === ' ') i += 3
    } else cur += ch
  }
  out.push(cur)
  return out.map((p) => p.trim()).filter(Boolean)
}

const normal = (p: string) => p.toLowerCase().replace(/\s+/g, ' ').trim()

function dtekChannel(region: keyof typeof DTEK_AREAS): ChannelConfig {
  const me = DTEK_AREAS[region]
  const others = Object.entries(DTEK_AREAS)
    .filter(([id]) => id !== region)
    .map(([, a]) => a.own)
  /** A part of the prefix is about this region: it names it and no other DTEK region */
  const ownPart = (p: string) => me.own.test(p) && !others.some((o) => o.test(p))
  return {
    handle: 'dtek_ua',
    about: (text) => {
      const head = dtekHead(text)
      return !!head && headParts(head).some(ownPart)
    },
    dialect: {
      dtek: true,
      area(text, sentence) {
        const head = dtekHead(text)
        if (!head) return null
        // "Київщина, Бучанський район" → "Бучанський район"; "Київ, Київська та Дніпропетровська
        // область" → nothing narrower than Kyiv
        const parts = headParts(head)
        const mine = parts
          .filter((p) => ownPart(p) || !others.concat(me.own).some((o) => o.test(p)))
          .filter((p) => !me.whole.includes(normal(p)))
        if (mine.length) return mine.join(', ')
        // the place after the verb: "застосовані екстрені відключення в місті Дніпрі, прилеглих
        // до обласного центру районах та в частині Павлоградського району"
        const rest = sentence.slice(sentence.indexOf(':') + 1)
        const after = new RegExp(
          `екстрен\\S*\\s+відключ\\S*\\s+(?:у|в)\\s+(?!зв'язку|разі|результаті)(.+?)\\s*$`,
          'iu',
        ).exec(rest)
        if (after) return after[1]!.replace(/[.!‼️\s]+$/u, '')
        return districtArea(rest)
      },
    },
  }
}

/** ЦЕК: "Шановні споживачі м. ДНІПРО‼️", "Шановні мешканці м. ПАВЛОГРАД" → "м. Дніпро". Exported for tests. */
export function cekArea(text: string): string | null {
  const m = /(?:споживачі|мешканці|жителі)\s+м\.\s*([\p{Lu}'ʼ’-]{2,})/u.exec(text)
  if (!m) return null
  const name = m[1]!.toLowerCase().replace(/(^|[-'ʼ’])\p{Ll}/gu, (c) => c.toUpperCase())
  return `м. ${name}`
}

/** Generic area: districts, or "industry only" when households aren't affected. */
function operatorArea(text: string, sentence: string): string | null {
  if (/для\s+промислових\s+споживачів|не\s+стосуються\s+побутових/iu.test(text)) return 'промислові споживачі'
  return districtArea(sentence)
}

/** Oblenergo channels: ГАВ has ten queues, "в повному обсязі" is all ten */
const oblenergo = (handle: string, home: RegExp): ChannelConfig => ({
  handle,
  dialect: { fullVolume: 10, area: operatorArea, home },
})

export const EMERGENCY_REGIONS: Partial<Record<RegionId, EmergencyConfig>> = {
  kyiv: { channels: [dtekChannel('kyiv')], yasno: { regionId: 25, dsoId: 902 } },
  'kyiv-region': { channels: [dtekChannel('kyiv-region')] },
  dnipro: { channels: [dtekChannel('dnipro')], yasno: { regionId: 3, dsoId: 301 } },
  // YASNO 3/303 never showed EmergencyShutdowns, not even during ЦЕК's own (15.11 13:39–15:27)
  'dnipro-cek': { channels: [{ handle: 'cek_info', dialect: { area: (text) => cekArea(text) } }] },
  odesa: { channels: [dtekChannel('odesa')] },
  donetsk: { channels: [dtekChannel('donetsk')] },
  zaporizhzhia: { channels: [oblenergo('Zaporizhzhyaoblenergo_news', /Запорі/u)] },
  kharkiv: { channels: [oblenergo('kharkivenergy', /Харків/u)] },
  lviv: { channels: [oblenergo('lvivoblenergo', /Льв/u)] },
  'ivano-frankivsk': { channels: [oblenergo('prykarpattyaoblenergo_official', /Івано-Франків|Прикарпат/u)] },
  ternopil: { channels: [oblenergo('ternopiloblenerho', /Тернопіл/u)] },
  khmelnytskyi: { channels: [oblenergo('khmelnytskoblenergo', /Хмельни/u)] },
  chernihiv: { channels: [oblenergo('chernigivoblenergo', /Черніг|Чернг/u)] },
  zhytomyr: { channels: [oblenergo('ztoe_ua', /Житомир/u)] },
  cherkasy: { channels: [oblenergo('pat_cherkasyoblenergo', /Черкас/u)] },
  // no main channel: 21 district channels post the same text; the city one stands for all
  kirovohrad: { channels: [oblenergo('SvitloKropyvnytskyiMisto', /Кіровоград|Кропивни/u)] },
  // never posts a cancel; the same Ukrenergo commands last minutes to ~4 h in Poltava next door
  sumy: { channels: [oblenergo('SumyEnergo', /Сум/u)], ttlHours: 6 },
  poltava: { channels: [oblenergo('poltavaOE', /Полтав/u)] },
  mykolaiv: { mykolaivFeed: true, channels: [oblenergo('mk_energy_ua', /Миколаїв/u)] },
  chernivtsi: {
    channels: [oblenergo('oe_cv_ua', /Чернівець|Чернівц|Буковин/u)],
    ukrenergo: 'Чернівецьк|Чернівеччин|Буковин',
  },
  zakarpattia: { ukrenergo: 'Закарпат' },
  volyn: { ukrenergo: 'Волинськ|Волин(?:і|ь|щин)' },
  rivne: { ukrenergo: 'Рівненськ|Рівненщин' },
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

/** Telegram posts → events this region cares about, oldest first. Exported for tests. */
export function channelEvents(posts: readonly TelegramPost[], channel: ChannelConfig): EmergencyEvent[] {
  const events: EmergencyEvent[] = []
  for (const p of posts) {
    if (channel.about && !channel.about(p.text)) continue
    for (const a of classifyPostAll(p.text, new Date(p.at), channel.dialect))
      events.push({ announcement: a, text: p.text, url: p.url, posted: p.at })
  }
  return events
}

/** National posts → events about one oblast. Exported for tests. */
export function ukrenergoEvents(posts: readonly TelegramPost[], stem: string): EmergencyEvent[] {
  const events: EmergencyEvent[] = []
  for (const p of posts) {
    const a = classifyUkrenergo(p.text, new Date(p.at), stem)
    if (a) events.push({ announcement: a, text: p.text, url: p.url, posted: p.at })
  }
  return events
}

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
            cfg.channels!.map(async (c) => channelEvents(await channelPosts(c.handle), c)),
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
      ? attempt(async () => ukrenergoEvents(await channelPosts(UKRENERGO), cfg.ukrenergo!))
      : undefined,
  ])

  const sourcesAnswered = [telegram, yasno, feed, national].some((x) => x !== undefined)
  if (!sourcesAnswered) throw errors[0]

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
