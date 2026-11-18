import { STANDARD_GROUPS } from '../schedule.js'
import { OutageError } from '../errors.js'
import { toKyivIso } from '../time.js'
import type { ProviderInfo } from '../types.js'
import { asSource } from './as-source.js'
import { gpvRegionSchedule, type GpvDays } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Vinnytsiaoblenergo (voe.com.ua). The operator gives the hours per queue only where a plain
 * request can't read them: its address tool (disconnection.voe.com.ua) answers every route with
 * a Cloudflare challenge, its cabinet (vn.e-svitlo.com.ua) wants a login and a consumer's EIC,
 * and the rest are a Telegram bot, a Viber bot and posts on its Facebook page. What its site
 * does publish openly (which date and hours ГПВ applies, a table of possible hours per queue)
 * is not the schedule: on 16.11.2026 queue 3.1 was off in hours that table leaves white.
 *
 * So this region has no official source, and by default it reads nothing: `getSchedules` throws
 * `unsupported` and `capabilities.schedule` is false. With `unofficialSources: true` on the
 * client it reads a community mirror instead, and says so: the one entry in `sources` has
 * `official: false`.
 *
 * The mirror is github.com/vn-progr/gpv-voe-vinnytsia, a JSON file a GitHub workflow rebuilds
 * every few minutes from bezsvitla.com.ua, a third-party site that says its data comes from the
 * operator's site. Two parties between the operator and this SDK, neither answerable for the
 * data. It is the same hourly format the DTEK sites use (`fact.data`). It can't tell "no
 * outages" from "not published", so a day with no outage in any queue is read as unknown, and
 * it has no change time: `updatedAt` is null.
 */
const MIRROR =
  'https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json'
const MIRROR_PAGE = 'https://github.com/vn-progr/gpv-voe-vinnytsia'
/** Stable id of the mirror in `sources` */
export const VINNYTSIA_MIRROR_ID = 'unofficial:github.com/vn-progr/gpv-voe-vinnytsia'

/**
 * The workflow runs every few minutes; a file older than this has stopped being rebuilt (its
 * predecessor, olnet93/gpv-voe-vinnytsia, froze on 14.12.2025 and is still served)
 */
const MIRROR_MAX_AGE_MS = 3 * 3600_000

interface MirrorFile {
  /** when the mirror last ran, unix seconds */
  lastUpdated?: unknown
  lastUpdateStatus?: { ok?: unknown; message?: unknown } | null
  fact?: { data?: GpvDays; update?: string } | null
}

export interface VinnytsiaOptions {
  /** Read the community mirror. Without it the region has no source */
  unofficial?: boolean
}

export function vinnytsiaProvider(o: VinnytsiaOptions = {}): Provider {
  const info: ProviderInfo = {
    id: 'vinnytsia',
    name: 'Вінницька область',
    operator: 'Вінницяобленерго',
    website: 'https://www.voe.com.ua/informatsiya-pro-cherhy-hrafika-pohodynnykh-vidklyuchen-hpv-1',
    capabilities: { schedule: !!o.unofficial, addressSearch: false },
  }
  const region = info.id

  return {
    info,
    getSchedules(ctx) {
      if (!o.unofficial)
        return Promise.reject(
          new OutageError(
            'unsupported',
            `${info.operator} gives the hours per queue only behind a bot check, a login or in its bots. ` +
              'A community mirror can be read instead: create the client with `unofficialSources: true`',
            { region },
          ),
        )
      return mergeSources(
        ctx,
        region,
        [
          {
            id: VINNYTSIA_MIRROR_ID,
            url: MIRROR_PAGE,
            official: false,
            read: () => readMirror(ctx),
          },
        ],
        { groups: STANDARD_GROUPS },
      )
    },
  }

  async function readMirror(ctx: ProviderContext): Promise<SourceRead> {
    const file = await ctx.http.json<MirrorFile>(MIRROR, { region })
    return parseVinnytsiaMirror(file, ctx.now())
  }
}

/** The mirror's file as one channel. Exported for tests. */
export function parseVinnytsiaMirror(file: MirrorFile | null, now: Date): SourceRead {
  const region = 'vinnytsia'
  const fail = (message: string) =>
    new OutageError('parse', `Vinnytsia mirror: ${message}`, { region, url: MIRROR })
  if (!file || typeof file !== 'object' || !file.fact || typeof file.fact !== 'object')
    throw fail('no schedule in the file (format changed?)')
  // its own account of the last run: a run that couldn't read the site keeps the old hours
  if (file.lastUpdateStatus && file.lastUpdateStatus.ok === false)
    throw fail(`its last run failed (${String(file.lastUpdateStatus.message ?? 'no reason given')})`)
  const ranAt = typeof file.lastUpdated === 'number' ? file.lastUpdated * 1000 : NaN
  if (!Number.isFinite(ranAt)) throw fail('no time of its last run')
  if (now.getTime() - ranAt > MIRROR_MAX_AGE_MS) throw fail(`not rebuilt since ${toKyivIso(new Date(ranAt))}`)
  // `fact.update` is the time of the mirror's run, not of the operator's change: the hours carry
  // no change time, and the run time must not pass for one
  const read = asSource(gpvRegionSchedule(region, file.fact.data, null, now))
  // A day without an outage in any queue is what the mirror shows before the operator has
  // published the day (tomorrow, every evening): silence, not "no outages". Such a day is left
  // out, so its queues stay `unknown`.
  for (const [date, day] of Object.entries(read.days))
    if (!Object.values(day.schedules).some((d) => d.status === 'emergency' || d.intervals.length))
      delete read.days[date]
  return { ...read, groups: [...STANDARD_GROUPS] }
}
