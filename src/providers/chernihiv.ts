import { postRegion } from '../ai/regions.js'
import { SECTIGO_DV_R36 } from '../certs.js'
import { readChannelWindow } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, ProviderInfo } from '../types.js'
import { chernihivAddresses } from './chernihiv-addresses.js'
import { readingToDay } from './image-schedule.js'
import { readPicturePosts, type PostedPicture } from './picture-posts.js'
import { daysToSource } from './posts.js'
import { aiOf, type Provider, type ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Chernihivoblenergo. The schedule API needs a captcha token on every request, but the same
 * schedule is published openly as a poster of twelve orange cards, one per group, listing
 * "HH:MM - HH:MM" off times (or "відключень не прогнозується"), read by the client's image
 * processor.
 *
 * The poster comes out on two channels, read together (`mergeSources`):
 * - the operator's Telegram channel gets tomorrow's poster the evening before (20:22–23:18 on 16
 *   of 16 days in November 2026), a re-issued poster ("ОНОВЛЕНИЙ") when a day changes a lot,
 *   and short changes in words during the day (see `readPicturePosts`); the picture is a 471 px
 *   copy;
 * - the site's `schedule_groups.jpg` (1200 px) is overwritten with the day's poster only in the
 *   morning of that day (07:15–08:05) and not touched again. What is uploaded is the evening's
 *   poster as it was (16.11.2026: the cards of post 5718, after the channel had changed the day
 *   at 07:14), so the upload is no new publication: a file that shows a poster of the channel
 *   is as old as that post, and every change the channel made since stands over it.
 */
const IMAGE = 'https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg'
const CHANNEL = 'chernigivoblenergo'
const CHANNEL_URL = `https://t.me/s/${CHANNEL}`

const INFO: ProviderInfo = {
  id: 'chernihiv',
  name: 'Чернігівська область',
  operator: 'Чернігівобленерго',
  website: 'https://chernihivoblenergo.com.ua',
  capabilities: { schedule: true, addressSearch: true },
}

/** A re-issued poster lists only the rest of its day; changes in words add to it */
const POSTS = { groups: STANDARD_GROUPS, updates: 'layer' } as const

export function chernihivProvider(): Provider {
  return {
    info: INFO,
    ...chernihivAddresses(INFO.id, INFO.operator),
    getSchedules(ctx) {
      // read once: a source of its own, and what tells the site's file from a new publication
      let channel: Promise<ChannelRead> | undefined
      const telegram = () => (channel ??= readChannel(ctx))
      return mergeSources(
        ctx,
        INFO.id,
        [
          { id: 'site', url: IMAGE, read: (ctx) => readSite(ctx, telegram) },
          { id: `telegram:@${CHANNEL}`, url: CHANNEL_URL, read: telegram },
        ],
        { groups: STANDARD_GROUPS },
      )
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The site

const parseError = (message: string, url: string, cause?: unknown) =>
  new OutageError('parse', `Chernihiv poster: ${message}`, { region: INFO.id, url, cause })

async function readSite(ctx: ProviderContext, telegram: () => Promise<ChannelRead>): Promise<SourceRead> {
  const region = INFO.id
  // the server omits its intermediate certificate
  const { bytes, headers } = await ctx.http.file(IMAGE, { region, ca: [SECTIGO_DV_R36] })
  const modified = Date.parse(headers.get('last-modified') ?? '')
  const updatedAt = Number.isNaN(modified) ? null : toKyivIso(new Date(modified))
  const now = ctx.now()
  const today = kyivDate(now)
  const reading = await aiOf(ctx).readImage(
    region,
    {
      url: IMAGE,
      bytes,
      caption: null,
      publishedAt: updatedAt ?? toKyivIso(now),
      region: postRegion(region),
    },
    ctx.signal,
  )
  const date = reading.date
  // a misread date would put the schedule on the wrong day; posters are for yesterday … tomorrow
  if (!reading.isSchedule || !date || date < addDays(today, -2) || date > addDays(today, 2))
    throw parseError(
      reading.isSchedule
        ? `no current date in the header (read ${date ?? 'nothing'})`
        : 'the file is not a schedule poster',
      IMAGE,
    )
  const schedules = readingToDay(reading, date)
  const groups = [...STANDARD_GROUPS]
  // until the morning upload the file is still yesterday's poster: nothing for today here
  if (date < today) return { days: {}, groups }
  // the file is uploaded on the morning of its day, at the earliest the evening before
  const uploaded = updatedAt ? kyivDate(new Date(updatedAt)) : today
  if (date > addDays(uploaded, 1))
    throw parseError(`the header reads ${date}, the file is of ${updatedAt ?? today}`, IMAGE)
  // the channel being down is its own failure; the file then has only its upload time
  const known = await telegram().catch(() => {
    ctx.signal?.throwIfAborted()
    return null
  })
  // the same poster the channel posted (the newest such): published then, not at the upload,
  // so a change the channel made in between isn't overridden by the older picture
  const poster = known?.posters[date]?.filter((p) => sameTimes(p.schedules, schedules)).at(-1)
  return { days: { [date]: { schedules, publishedAt: poster ? poster.publishedAt : updatedAt } }, groups }
}

/** Two readings of a day list the same outages for every group */
const sameTimes = (a: Record<GroupId, DaySchedule>, b: Record<GroupId, DaySchedule>) =>
  STANDARD_GROUPS.every((g) => JSON.stringify(a[g]?.intervals) === JSON.stringify(b[g]?.intervals))

/** The channel's days, and every poster it posted per date (oldest first) as it was drawn */
export type ChannelRead = SourceRead & { posters: Record<string, PostedPicture[]> }

// ---------------------------------------------------------------------------------------------
// The Telegram channel

async function readChannel(ctx: ProviderContext): Promise<ChannelRead> {
  const region = INFO.id
  const today = kyivDate(ctx.now())
  // today's poster came yesterday evening
  const since = kyivInstant(addDays(today, -1), 12 * 60)
  const { posts, from } = await readChannelWindow(ctx, CHANNEL, { region, since, withPhotoOnly: true })
  if (Date.parse(from) > since.getTime())
    throw new OutageError(
      'parse',
      `Telegram @${CHANNEL}: the posts since ${toKyivIso(since)} couldn't all be read (only from ${from})`,
      { region, url: CHANNEL_URL },
    )
  const { days, pictures, url } = await readPicturePosts(ctx, region, posts, POSTS)
  for (const date of [...days.keys()]) if (date < today) days.delete(date)
  return { ...daysToSource(days, POSTS), ...(url ? { url } : {}), posters: pictures }
}
