import { toKyivIso } from '../time.js'
import type { EmergencyStatus, RegionId } from '../types.js'
import type { ProviderContext } from '../providers/provider.js'
import { abortable } from '../util.js'
import { classifyPost, classifyUkrenergo, districtArea, type Dialect } from './classify.js'
import { mykolaivFeed, mykolaivFeedStatus, yasnoEmergency } from './sources.js'
import { foldEvents, type EmergencyEvent } from './status.js'
import { readChannel, type TelegramPost } from './telegram.js'

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
  /** Oblast adjective stem in Ukrenergo posts ("Волинськ"), for the national fallback */
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
  dnipro: {
    own: /Дніпр/u,
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

function dtekChannel(region: keyof typeof DTEK_AREAS): ChannelConfig {
  const me = DTEK_AREAS[region]
  return {
    handle: 'dtek_ua',
    about: (text) => {
      const head = dtekHead(text)
      return !!head && me.own.test(head)
    },
    dialect: {
      dtek: true,
      area(text, sentence) {
        const head = dtekHead(text)
        if (!head) return null
        // "Київ, Київська та Дніпропетровська область" → the parts about this region
        const mine = head
          .split(/\s*,\s*|\s+та\s+/u)
          .filter((p) => me.own.test(p))
          .filter((p) => !me.whole.includes(p.toLowerCase().replace(/\s+/g, ' ').trim()))
        if (mine.length) return mine.join(', ')
        return districtArea(sentence.slice(sentence.indexOf(':') + 1))
      },
    },
  }
}

/** ЦЕК: "Шановні споживачі м. ДНІПРО‼️" → "м. Дніпро". Exported for tests. */
export function cekArea(text: string): string | null {
  const m = /споживачі\s+м\.\s*([\p{Lu}'ʼ’-]{2,})/u.exec(text)
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
  'dnipro-cek': {
    channels: [{ handle: 'cek_info', dialect: { area: (text) => cekArea(text) } }],
    yasno: { regionId: 3, dsoId: 303 },
  },
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
  chernivtsi: { channels: [oblenergo('oe_cv_ua', /Чернівець|Чернівц|Буковин/u)], ukrenergo: 'Чернівецьк' },
  zakarpattia: { ukrenergo: 'Закарпатськ' },
  volyn: { ukrenergo: 'Волинськ' },
  rivne: { ukrenergo: 'Рівненськ' },
}

/**
 * Shared work of one client: channel pages read once for every region that uses them
 * (@dtek_ua serves five, @Ukrenergo four), kept for a minute.
 */
export class EmergencyHub {
  private readonly channels = new Map<string, { at: number; value: Promise<TelegramPost[]> }>()

  constructor(private readonly cacheMs = 60_000) {}

  posts(ctx: ProviderContext, region: RegionId, handle: string, fresh: boolean): Promise<TelegramPost[]> {
    const hit = this.channels.get(handle)
    const now = ctx.now()
    if (!fresh && hit && Date.now() - hit.at < this.cacheMs) return abortable(hit.value, ctx.signal)
    const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000)
    const value = readChannel(ctx, handle, { region, since })
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
}

/** Telegram posts → events this region cares about, oldest first. Exported for tests. */
export function channelEvents(posts: readonly TelegramPost[], channel: ChannelConfig): EmergencyEvent[] {
  const events: EmergencyEvent[] = []
  for (const p of posts) {
    if (channel.about && !channel.about(p.text)) continue
    const a = classifyPost(p.text, new Date(p.at), channel.dialect)
    if (a) events.push({ announcement: a, text: p.text, url: p.url, posted: p.at })
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
}

/**
 * The region's emergency status from its sources. A source that fails is skipped when another
 * answers; only when all fail is the first error thrown. Silence is never an error: no
 * announcement in the lookback window is `inactive` with `kind: null`.
 */
export async function getEmergency(
  hub: EmergencyHub,
  cfg: EmergencyConfig,
  { ctx, region, fresh }: EmergencyRequest,
): Promise<EmergencyStatus> {
  const now = ctx.now()
  const ttlHours = cfg.ttlHours ?? DEFAULT_TTL_HOURS
  const errors: unknown[] = []
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
            cfg.channels!.map(async (c) => channelEvents(await hub.posts(ctx, region, c.handle, fresh), c)),
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
              new Date(now.getTime() - 24 * 3600_000),
              new Date(now.getTime() + 3600_000),
            ),
            region,
            now,
          ),
        )
      : undefined,
    cfg.ukrenergo
      ? attempt(async () => ukrenergoEvents(await hub.posts(ctx, region, UKRENERGO, fresh), cfg.ukrenergo!))
      : undefined,
  ])

  const sourcesAnswered = [telegram, yasno, feed, national].some((x) => x !== undefined)
  if (!sourcesAnswered) throw errors[0]

  const fetchedAt = toKyivIso(now)
  const fold = (events: EmergencyEvent[], source: EmergencyStatus['source']) =>
    foldEvents(events, { region, now, ttlHours, source })

  // Mykolaiv: the feed names queues and times; the channel is the fallback
  if (feed) return { ...feed, fetchedAt }

  let status: EmergencyStatus | null = telegram ? fold(telegram, 'telegram') : null
  // nothing from the operator itself: the national channel, when it names this oblast
  if ((!status || !status.message) && national?.length) status = fold(national, 'ukrenergo')

  if (yasno) status = withYasno(status, yasno, region, fetchedAt)
  return status ?? fold([], telegram ? 'telegram' : 'ukrenergo')
}

/**
 * YASNO's status combined with the posts: it is the machine-readable truth for "on now" and
 * DTEK's only cancel signal for Dnipro; the posts add the start, the area and the text.
 */
function withYasno(
  posts: EmergencyStatus | null,
  y: { active: boolean; changedAt: string | null },
  region: RegionId,
  fetchedAt: string,
): EmergencyStatus {
  const changed = y.changedAt ? Date.parse(y.changedAt) : NaN
  if (y.active) {
    if (posts?.state === 'active') return { ...posts, source: 'yasno' }
    return {
      region,
      state: 'active',
      kind: 'emergency',
      scheduleApplies: false,
      since: y.changedAt,
      endedAt: null,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: posts?.message ?? null,
      source: 'yasno',
      fetchedAt,
    }
  }
  if (posts?.state === 'active') {
    // YASNO not (yet) showing it, but updated after the post: that is the cancel DTEK doesn't
    // always post (never for Dnipro). Updated before the post: YASNO lags or shows only part of
    // the city, so the post stands.
    const since = posts.since ? Date.parse(posts.since) : NaN
    if (Number.isFinite(changed) && Number.isFinite(since) && changed > since)
      return {
        ...posts,
        state: 'inactive',
        endedAt: y.changedAt,
        queues: null,
        queueCount: null,
        scheduleApplies: true,
        source: 'yasno',
      }
    return posts
  }
  return (
    posts ?? {
      region,
      state: 'inactive',
      kind: null,
      scheduleApplies: null,
      since: null,
      endedAt: null,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: null,
      source: 'yasno',
      fetchedAt,
    }
  )
}
