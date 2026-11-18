import { analyzeAll, channelInputs } from '../ai/posts.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId } from '../types.js'
import { daysOf, textPublications } from './posts.js'
import type { ProviderContext } from './provider.js'
import type { SourceRead, SourceSpec } from './sources.js'

/**
 * ЦЕК's own channel, @cek_info. It posts each day's ГПВ as text the evening before (21:00–23:10)
 * and every change during the day, well ahead of YASNO's feed for the same operator (3/303),
 * which on 16–17.11.2026 still said "emergency, no schedule" 90 minutes after ЦЕК had cancelled
 * the emergency and published the list.
 *
 * Kinds of post, all without a year ("16 ЛИСТОПАДА", once "11.11"):
 *
 * ```
 * … 16 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:   the whole day
 * 🔹 Черга 1.1
 * 00:30-04:00
 * 11:00-14:30
 * ```
 * (also "діятимуть наступні черги:" with bare "1.1" lines, and "✅ 01:30-04:00")
 *
 * - `зміни у ГПВ на 16 ЛИСТОПАДА за розпорядженням …:` + the same blocks: the whole day again;
 * - `зміни у ГПВ на 12 ЛИСТОПАДА з 16:00 до 24:00, …:` (or `з 04:00`) + blocks: that part of the
 *   day again; a group it leaves out has no outage in it, the hours before stay as they were;
 * - prose: `зміни в ГПВ 13 ЛИСТОПАДА, … з 00:00 до 06:00 додатково застосовуються відлючення
 *   черги 3.1, 3.2`. One window and the groups it names can be applied exactly (they are off
 *   then). Anything else ("з 02:30 додатково … 6.1, 6.2" with no end, two windows in a sentence,
 *   a negation: "… не застосовуються відключення …", "скасовуються …")
 *   can't: the groups it names become `unknown` for that day until the next list, the others stay;
 * - `скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ`: the list
 *   of that day stands again, as of this post. That is what lets it win over a YASNO feed still
 *   showing the emergency;
 * - lists for one town with their own numbering (`м. ПАВЛОГРАД … 📌 2.2 черга:`), notices to
 *   other towns, planned works and the emergency notices themselves aren't the regional
 *   schedule and are skipped (`getEmergency` reads the emergencies).
 */
export const CEK_CHANNEL = 'cek_info'

export const CEK_GROUPS: readonly GroupId[] = [1, 2, 3, 4, 5, 6].flatMap((q) => [`${q}.1`, `${q}.2`])

/** One day as the channel's posts leave it */
export interface CekDay {
  /** Time of the newest post that says something about the day's ГПВ, ms */
  at: number
  /** That post */
  url: string
  /** Off slots per group; null when a change that can't be applied exactly made them unknown */
  groups: Record<GroupId, MinuteSlot[] | null>
}

/**
 * The channel's posts → each day's ГПВ as it stands, by date, read by the client's text
 * processor. Lists for one town with its own numbering (an event with an `area`) aren't the
 * regional schedule and are skipped. A change for part of the day ("з 16:00 до 24:00") replaces
 * that part, and a group it leaves out has no outage in it; a correction in words adds its
 * window, or makes the groups it names `unknown` when it doesn't give both ends. "Скасування
 * екстрених відключень, повертаємося до ГПВ" makes the day's list stand again as of that post.
 * A post that can't be read is a `parse` error when it is recent enough to matter (posted since
 * yesterday). Exported for tests.
 */
export async function cekDays(
  ctx: ProviderContext,
  posts: readonly TelegramPost[],
): Promise<Map<string, CekDay>> {
  const region = 'dnipro-cek'
  const now = ctx.now()
  const recent = kyivInstant(addDays(kyivDate(now), -1), 0).getTime()
  const sorted = [...posts].sort((a, b) => a.id - b.id)
  const all = await analyzeAll(ctx, region, channelInputs(sorted, region))
  const bad = all.find((a) => a.error && Date.parse(a.input.publishedAt) >= recent)
  if (bad) throw bad.error
  // town lists aren't the region's
  const analyzed = all.map((a) =>
    a.analysis ? { ...a, analysis: { ...a.analysis, events: a.analysis.events.filter((e) => !e.area) } } : a,
  )
  const opts = { omitted: 'none', groups: CEK_GROUPS, updates: 'layer' } as const
  const days = daysOf(textPublications(analyzed, region, now, opts), opts)
  const out = new Map<string, CekDay>()
  for (const [date, day] of days) {
    const groups: Record<GroupId, MinuteSlot[] | null> = {}
    for (const g of CEK_GROUPS)
      groups[g] = day.cancelled ? null : (day.groups[g] ?? (day.groups[g] === null ? null : []))
    out.set(date, { at: day.at, url: analyzed[day.post]!.input.url, groups })
  }
  // back to the hourly schedule after an emergency: the list stands again as of that post
  for (const { input, analysis } of analyzed) {
    if (!analysis) continue
    const at = Date.parse(input.publishedAt)
    for (const e of analysis.events) {
      if (e.kind === 'gpv' || e.action !== 'cancel' || e.gpvApplies !== true) continue
      const day = out.get(e.date ?? kyivDate(new Date(at)))
      if (day && at > day.at) Object.assign(day, { at, url: input.url })
    }
  }
  return out
}

/** The channel as a schedule source: today and later. Exported for tests. */
export function cekDaysToSource(days: ReadonlyMap<string, CekDay>, now: Date): SourceRead {
  const today = kyivDate(now)
  const out: SourceRead['days'] = {}
  let newest: CekDay | undefined
  for (const [date, day] of days) {
    if (date < today) continue
    const schedules: Record<GroupId, DaySchedule> = {}
    for (const g of CEK_GROUPS) {
      const slots = day.groups[g]
      schedules[g] = slots ? makeDay(date, slots) : { date, status: 'unknown', intervals: [] }
    }
    out[date] = { schedules, publishedAt: toKyivIso(new Date(day.at)) }
    if (!newest || day.at > newest.at) newest = day
  }
  return { days: out, groups: [...CEK_GROUPS], ...(newest ? { url: newest.url } : {}) }
}

/** @cek_info as a `mergeSources` channel. */
export function cekTelegramSource(): SourceSpec {
  return {
    id: `telegram:@${CEK_CHANNEL}`,
    url: `https://t.me/s/${CEK_CHANNEL}`,
    read: async (ctx) => {
      const now = ctx.now()
      // back to the list posted the evening before yesterday, which later changes build on
      const since = kyivInstant(addDays(kyivDate(now), -2), 12 * 60)
      const { posts } = await readChannelWindow(ctx, CEK_CHANNEL, {
        region: 'dnipro-cek',
        since,
        maxPages: 6,
      })
      return cekDaysToSource(await cekDays(ctx, posts), now)
    },
  }
}
