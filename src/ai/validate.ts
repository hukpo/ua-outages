import { OutageError } from '../errors.js'
import { queueNames } from '../emergency/queues.js'
import { normalizeGroup } from '../schedule.js'
import { addDays, kyivDate } from '../time.js'
import type { RegionId } from '../types.js'
import type {
  ClockInterval,
  EventAction,
  EventKind,
  ImageInput,
  ImageReading,
  PostAnalysis,
  PostEvent,
  PostInput,
  PostRegion,
} from './types.js'

/**
 * Checks a processor's answer and normalizes it. Anything not real (a time like "25:10", a date
 * that doesn't exist or is far from the post, a queue the region doesn't have, a field of the
 * wrong type) fails the whole answer: a misread is an error, never a guess.
 */

class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg)
}

/** "HH:MM" → minutes; "24:00" only where `end` allows it */
export function clockMinutes(s: unknown, end = false): number {
  if (typeof s !== 'string') return fail(`time ${JSON.stringify(s)} is not a string`)
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return fail(`time "${s}" is not HH:MM`)
  let h = Number(m[1])
  let min = Number(m[2])
  // "23:59" as an end is the end of the day
  if (end && h === 23 && min === 59) [h, min] = [24, 0]
  if (min > 59 || h > 24 || (h === 24 && (min !== 0 || !end))) fail(`time "${s}" doesn't exist`)
  return h * 60 + min
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

function realDate(s: unknown, around: string, back: number, ahead: number): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s))
    return fail(`date ${JSON.stringify(s)} is not YYYY-MM-DD`)
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail(`date "${s}" doesn't exist`)
  if (s < addDays(around, -back) || s > addDays(around, ahead))
    fail(`date "${s}" is too far from the publication (${around})`)
  return s
}

const obj = (v: unknown, what: string): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail(`${what} is not an object`)
const bool = (v: unknown, what: string): boolean =>
  typeof v === 'boolean' ? v : fail(`${what} is not a boolean`)
const nullableBool = (v: unknown, what: string): boolean | null =>
  v === null || v === undefined ? null : bool(v, what)
const str = (v: unknown, what: string): string =>
  typeof v === 'string' ? v : fail(`${what} is not a string`)
const nullableStr = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null
  const s = str(v, what).trim()
  return s || null
}
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(`${what} is not a list`))
const strings = (v: unknown, what: string): string[] =>
  arr(v ?? [], what).map((x, i) => str(x, `${what}[${i}]`))

const KINDS: readonly EventKind[] = ['gpv', 'gav', 'sgav', 'emergency', 'other']
const ACTIONS: readonly EventAction[] = ['start', 'cancel', 'change']

/** A ГПВ queue name → the region's own spelling ("1-1", "черга 1.1" → "1.1"; Chernivtsi "3") */
function scheduleQueue(raw: string, regions: readonly PostRegion[]): string {
  const all = new Set(regions.flatMap((r) => r.queues))
  const trimmed = raw.trim().replace(/^(?:черга|підчерга|група|queue)\s*/iu, '')
  if (all.has(trimmed)) return trimmed
  const g = normalizeGroup(trimmed)
  if (g && all.has(g)) return g
  return fail(`queue "${raw}" doesn't exist in ${regions.map((r) => r.id).join(', ')}`)
}

/** Emergency queue names, checked against the fixed set when the operator has one */
function emergencyQueueList(raw: string[], regions: readonly PostRegion[], what: string): string[] {
  const out: string[] = []
  for (const q of raw) {
    const names = queueNames(q.replace(/^(?:черга|queue)\s*/iu, ''))
    if (names.length !== 1) fail(`${what}: "${q}" is not a queue`)
    out.push(names[0]!)
  }
  for (const r of regions) {
    if (!r.emergencyQueues.length) continue
    const bad = out.find((q) => !r.emergencyQueues.includes(q.replace('(Р)', '')))
    if (bad) fail(`${what}: queue "${bad}" doesn't exist in ${r.id}`)
  }
  return [...new Set(out)]
}

const SPAN = /^(\?)?\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/

/**
 * Intervals of one queue: real times, `from < to`. Each is "HH:MM-HH:MM" ("?…" for a possible
 * outage), as the schema asks, or {from, to, kind}, as prompts before p9 did
 */
function intervals(v: unknown, what: string): ClockInterval[] {
  return arr(v, what).map((x, i) => {
    let o: Record<string, unknown>
    if (typeof x === 'string') {
      const m = SPAN.exec(x.trim())
      if (!m) return fail(`${what}[${i}]: "${x}" is not HH:MM-HH:MM`)
      o = { from: m[2], to: m[3], kind: m[1] ? 'maybe' : 'off' }
    } else o = obj(x, `${what}[${i}]`)
    const from = clockMinutes(o.from)
    const to = clockMinutes(o.to, true)
    if (from >= to) fail(`${what}[${i}]: ${o.from}–${o.to} doesn't go forward`)
    const kind = o.kind ?? 'off'
    if (kind !== 'off' && kind !== 'maybe') return fail(`${what}[${i}]: kind "${String(kind)}"`)
    return { from: clock(from), to: clock(to), kind }
  })
}

function event(v: unknown, i: number, input: PostInput, postDay: string): PostEvent | null {
  const w = `events[${i}]`
  const o = obj(v, w)
  const kind = str(o.kind, `${w}.kind`) as EventKind
  if (!KINDS.includes(kind)) fail(`${w}.kind "${kind}"`)
  // anything else isn't used: no need to check it
  if (kind === 'other') return null
  const action = o.action as EventAction
  if (!ACTIONS.includes(action)) fail(`${w}.action ${JSON.stringify(o.action)} for ${kind}`)

  const ids = input.regions.map((r) => r.id as string)
  let regions = strings(o.regions, `${w}.regions`)
  // a single-region source: an empty list can only mean that region
  if (!regions.length && ids.length === 1) regions = [...ids]
  // a shared channel's post about none of its regions (a national post naming other oblasts)
  if (!regions.length) return null
  const unknown = regions.find((r) => !ids.includes(r))
  if (unknown) fail(`${w}.regions: "${unknown}" isn't one of ${ids.join(', ')}`)
  regions = [...new Set(regions)]
  const scope = input.regions.filter((r) => regions.includes(r.id))

  const at = o.at === null || o.at === undefined ? null : clock(clockMinutes(o.at))
  const until = o.until === null || o.until === undefined ? null : clock(clockMinutes(o.until, true))
  // a site page read against today may still show the last days' articles: up to a week back
  const named = o.date === null || o.date === undefined ? null : realDate(o.date, postDay, 7, 3)
  // the post's own day is no date of its own
  const date = named === postDay ? null : named
  const queueCount =
    o.queueCount === null || o.queueCount === undefined
      ? null
      : Number.isInteger(o.queueCount) && (o.queueCount as number) > 0 && (o.queueCount as number) <= 60
        ? (o.queueCount as number)
        : fail(`${w}.queueCount ${JSON.stringify(o.queueCount)}`)

  const emergency = kind !== 'gpv'
  const queues = emergency ? emergencyQueueList(strings(o.queues, `${w}.queues`), scope, `${w}.queues`) : []
  const queuesRestored = emergency
    ? emergencyQueueList(strings(o.queuesRestored, `${w}.queuesRestored`), scope, `${w}.queuesRestored`)
    : []

  const area = nullableStr(o.area, `${w}.area`)
  const schedule: PostEvent['schedule'] = []
  if (!emergency && action !== 'cancel') {
    const seen = new Set<string>()
    for (const [j, x] of arr(o.schedule ?? [], `${w}.schedule`).entries()) {
      const e = obj(x, `${w}.schedule[${j}]`)
      const raw = str(e.queue, `${w}.schedule[${j}].queue`).trim()
      // a town's own numbering (ЦЕК's Pavlohrad): not the region's queues, and never used as them
      const queue = area ? raw : scheduleQueue(raw, scope)
      if (seen.has(queue)) fail(`${w}.schedule: queue ${queue} twice`)
      seen.add(queue)
      schedule.push({
        queue,
        intervals:
          e.intervals === null || e.intervals === undefined
            ? null
            : intervals(e.intervals, `${w}.schedule[${j}].intervals`),
      })
    }
    // the hours may be in the post's picture
  }

  // "9,10,1,2 знеструмлюємо; 3-6 будуть заживлені" read as a change or as a start with those
  // queues: the state machine adds the queues and drops the restored ones either way
  const effective: EventAction = emergency && action === 'change' && queues.length ? 'start' : action
  const allQueues = emergency ? bool(o.allQueues ?? false, `${w}.allQueues`) : false
  const additive = bool(o.additive ?? false, `${w}.additive`)
  const again = bool(o.again ?? false, `${w}.again`)
  const gpvApplies = nullableBool(o.gpvApplies, `${w}.gpvApplies`)
  // what the SDK doesn't use for this kind of event is left at its default, so equal readings
  // compare equal: the emergency fields of a ГПВ event, "all queues" on a cancel naming none
  return {
    kind,
    action: effective,
    regions,
    area,
    date,
    at,
    // a ГПВ window's end; to the end of the day, or with no start, is no window
    until: emergency || (at && until !== '24:00') ? until : null,
    allQueues: action === 'cancel' && !queues.length && queueCount === null ? false : allQueues,
    queues,
    queuesRestored,
    queueCount: emergency ? queueCount : null,
    additive: emergency && additive,
    again: emergency && again,
    gpvApplies: emergency ? gpvApplies : null,
    addedInEdit: bool(o.addedInEdit ?? false, `${w}.addedInEdit`) && input.edited,
    untilFurtherNotice: action === 'cancel' && bool(o.untilFurtherNotice ?? false, `${w}.untilFurtherNotice`),
    schedule,
  }
}

/** A text processor's answer → a checked `PostAnalysis` without `other` events */
export function validatePostAnalysis(raw: unknown, input: PostInput): PostAnalysis {
  return guard(input.url, input.regions[0]?.id, () => {
    const o = obj(raw, 'answer')
    const postDay = kyivDate(new Date(input.publishedAt))
    const events = arr(o.events, 'events')
      .map((e, i) => event(e, i, input, postDay))
      .filter((e): e is PostEvent => e !== null)
    return {
      events,
      photosAreSchedules: bool(o.photosAreSchedules ?? false, 'photosAreSchedules') && input.photoCount > 0,
      statedAt: o.statedAt === null || o.statedAt === undefined ? null : clock(clockMinutes(o.statedAt)),
    }
  })
}

/**
 * An image processor's answer → a checked `ImageReading`. A schedule must give every queue of
 * the region exactly once; a picture of an album may give some of them (the album splits them).
 */
export function validateImageReading(raw: unknown, input: ImageInput): ImageReading {
  return guard(input.url, input.region.id, () => {
    const o = obj(raw, 'answer')
    if (!bool(o.isSchedule, 'isSchedule'))
      return { isSchedule: false, kind: null, date: null, statedAt: null, schedule: [] }
    const kind = o.kind ?? null
    if (kind !== null && kind !== 'gpv' && kind !== 'gav' && kind !== 'sgav') fail(`kind "${String(kind)}"`)
    const postDay = kyivDate(new Date(input.publishedAt))
    const date = o.date === null || o.date === undefined ? null : realDate(o.date, postDay, 2, 3)
    const seen = new Map<string, ClockInterval[]>()
    for (const [j, x] of arr(o.schedule, 'schedule').entries()) {
      const e = obj(x, `schedule[${j}]`)
      const queue = scheduleQueue(str(e.queue, `schedule[${j}].queue`), [input.region])
      if (seen.has(queue)) fail(`schedule: queue ${queue} twice`)
      seen.set(queue, intervals(e.intervals, `schedule[${j}].intervals`))
    }
    const missing = input.region.queues.filter((q) => !seen.has(q))
    if (missing.length && (input.of <= 1 || !seen.size))
      fail(`schedule: queues ${missing.join(', ')} missing`)
    return {
      isSchedule: true,
      kind: kind as ImageReading['kind'],
      date,
      statedAt: o.statedAt === null || o.statedAt === undefined ? null : clock(clockMinutes(o.statedAt)),
      schedule: input.region.queues
        .filter((q) => seen.has(q))
        .map((queue) => ({ queue, intervals: seen.get(queue)! })),
    }
  })
}

/** The cheap check's answer */
export function validateImageCheck(raw: unknown, input: ImageInput): boolean {
  return guard(input.url, input.region.id, () => bool(obj(raw, 'answer').isSchedule, 'isSchedule'))
}

function guard<T>(url: string, region: RegionId | undefined, work: () => T): T {
  try {
    return work()
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    throw new OutageError('parse', `AI answer failed validation (${url}): ${e.message}`, {
      ...(region ? { region } : {}),
      url,
      cause: e,
    })
  }
}
