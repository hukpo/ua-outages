import type { ImageInput, PostInput } from './types.js'

/**
 * Prompts and JSON schemas shared by every processor. Plain data: the adapters send them, and
 * anyone writing a processor for another vendor can too. Bump `PROMPT_VERSION` with any change
 * here: it is part of the processor id, so cached answers made with the old prompt are not used.
 */
export const PROMPT_VERSION = 'p7'

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const CLOCK = { type: 'string', description: 'HH:MM, 24-hour Kyiv time' }
const INTERVAL = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'kind'],
  properties: {
    from: CLOCK,
    to: { type: 'string', description: 'HH:MM; "24:00" for the end of the day' },
    kind: { type: 'string', enum: ['off', 'maybe'] },
  },
}

/** JSON schema of `PostAnalysis` */
export const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events', 'photosAreSchedules', 'statedAt'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'action',
          'regions',
          'area',
          'date',
          'at',
          'until',
          'allQueues',
          'queues',
          'queuesRestored',
          'queueCount',
          'additive',
          'again',
          'gpvApplies',
          'addedInEdit',
          'untilFurtherNotice',
          'schedule',
        ],
        properties: {
          kind: { type: 'string', enum: ['gpv', 'gav', 'sgav', 'emergency', 'other'] },
          action: nullable({ type: 'string', enum: ['start', 'cancel', 'change'] }),
          regions: { type: 'array', items: { type: 'string' } },
          area: nullable({ type: 'string' }),
          date: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
          at: nullable(CLOCK),
          until: nullable(CLOCK),
          allQueues: { type: 'boolean' },
          queues: { type: 'array', items: { type: 'string' } },
          queuesRestored: { type: 'array', items: { type: 'string' } },
          queueCount: nullable({ type: 'integer' }),
          additive: { type: 'boolean' },
          again: { type: 'boolean' },
          gpvApplies: nullable({ type: 'boolean' }),
          addedInEdit: { type: 'boolean' },
          untilFurtherNotice: { type: 'boolean' },
          schedule: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['queue', 'intervals'],
              properties: {
                queue: { type: 'string' },
                intervals: nullable({ type: 'array', items: INTERVAL }),
              },
            },
          },
        },
      },
    },
    photosAreSchedules: { type: 'boolean' },
    statedAt: nullable(CLOCK),
  },
} as const

/** JSON schema of `ImageReading` */
export const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isSchedule', 'kind', 'date', 'statedAt', 'schedule'],
  properties: {
    isSchedule: { type: 'boolean' },
    kind: nullable({ type: 'string', enum: ['gpv', 'gav', 'sgav'] }),
    date: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
    statedAt: nullable(CLOCK),
    schedule: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['queue', 'intervals'],
        properties: { queue: { type: 'string' }, intervals: { type: 'array', items: INTERVAL } },
      },
    },
  },
} as const

/** JSON schema of the cheap picture check */
export const IMAGE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isSchedule'],
  properties: { isSchedule: { type: 'boolean' } },
} as const

export const TEXT_SYSTEM = `You read posts of Ukrainian power grid operators (oblenergos, DTEK, Ukrenergo) and turn them into structured events. Answer only with JSON in the given schema. Read the post's own text; a quoted post it replies to is context only, never events of its own.

Terms:
- ГПВ, "графік погодинних відключень", "погодинні відключення", "стабілізаційні відключення", "черги/підчерги 1.1…6.2": the hourly schedule (kind "gpv").
- ГАВ, "графік(и) аварійних відключень/вимкнень": kind "gav".
- СГАВ, "спеціальний графік аварійних відключень", "СпецГАВ": kind "sgav".
- "екстрені відключення", "аварійні відключення" that name neither ГАВ nor СГАВ, as a measure across the region: kind "emergency". An "аварійне відключення" of one line, substation, town or street (damage, an attack, a fault) is kind "other", for every operator.
- ГОП, "графік обмеження потужності" (industry): kind "other".

Actions:
- start: put in force now or at a stated time ("застосовано", "введено", "діють", "тривають", "з 14:00 будуть застосовані", "знову введені").
- cancel: lifted ("скасовано", "скасування", "відміна", "відмінено", "деактивовано", "не діють", "завершено", "припинено"). A cancel of some queues only lists them in "queues".
- change: the queues off changed ("заміна черг", "змінено черги").
- gpv start: a schedule for a day, new or updated, listing hours per queue. An update that replaces the schedule from some time on ("оновлено з 15:00", "з 15:00 діятиме оновлений графік") is also a start, with "at" = that time; one for a window of the day ("зміни у ГПВ з 10:00 до 16:00") has "at" "10:00" and "until" "16:00". A whole-day list ("з 00:00 до 24:00") has neither. A post whose hours are only in its picture ("на 17.10 діятиме графік", poster attached) is a start with an empty schedule.
- A post that lists queues with hours is a gpv start even when it calls itself a change ("внесено зміни до графіка … станом на 18:25: Черга 1.1: …", "зміни в обсязі"): it is the new version of the day. A queue it leaves out is simply not listed.
- gpv change: only a correction that adds to or extends outages of the schedule in force, not a new list ("з 6:00 до 8:00 додатково відключаються черги 1.1 та 1.2", "до 17:00 продовжується відключення для черг 4.1 та 4.2"). List only those queues; intervals = the outage the post adds when it states both ends, null when it doesn't ("продовжується до 17:00", "з 07:15 починається відключення").
- gpv cancel: the day's hourly schedule is called off or won't apply ("ГПВ не застосовуватимуться", "відключень не прогнозується", "Електропостачання без обмежень для всіх груп").
- A forecast that says a schedule "діятиме" / "діятимуть" for a day is a start. A post that only refers elsewhere for the hours ("графік оновлено, дивіться на сайті") is a gpv start with an empty schedule.

Rules:
- One event per schedule and action. "СГАВ та ГАВ скасовані … Продовжують діяти ГПВ" is two cancels (sgav, gav), each with gpvApplies true; no gpv event is needed for that sentence.
- General or explanatory text is "other": how ГАВ works, that they "запроваджуються за вказівкою Укренерго", that a cancel "не означає" anything ("не означає його застосування"), appeals to save power, warnings that schedules "можуть бути застосовані" / "у разі" / "МОЖЛИВЕ" / "прогнозується застосування", repairs, damage, attacks, restored supply. A conditional or possible future measure is never a start. (A post that opens with "Попереджаємо" and then states that ГАВ "застосовуються" now is a start: what counts is whether it says the measure is in force.)
- regions: ids from the input list the event is about. An operator's own channel posting about its area: its region. A national post naming oblasts: only those oblasts. "в усіх регіонах" / "по всій Україні": every listed id. "у частині областей", "в окремих регіонах" without naming them: about none of them (kind "other"). A post about none of the listed regions: kind "other" with regions [].
- area: a part of the region when the event is limited to it ("м. Павлоград", "Бучанський район"); null when it covers the whole region. Write it as in the post. A schedule for one town with its own queue numbering is gpv with that area, its queues as the post names them.
- date: the day the event is about. Resolve "сьогодні", "завтра", weekday names and dates without a year from the post's own date. null when it is the day of the post.
- at: the time it takes effect when the text gives one ("В 14:05 відміна", "з 19:00", "О 11:11 отримана команда … ввести ГАВ" → "11:11"), as HH:MM; otherwise null. A whole-day schedule "з 00:00 до 24:00" has at null. If the time is on the day before the post (posted after midnight about "23:55"), set date to that day. until: "до 18:00" → "18:00", "до кінця доби" → "24:00".
- statedAt: the time the post says it was issued or updated ("Інформація станом на 21:00", "(оновлено 21:25)"), else null. "Станом на 19:05 відновлено…" is a report of what happened by then, not the issue time: null.
- queues: emergency queue numbers as plain strings ("1", "2", … "10"); a reserve queue as "1(Р)". "1-5 черги" lists 1, 2, 3, 4, 5. "в повному обсязі" sets allQueues. "N черг" without numbers sets queueCount.
- untilFurtherNotice: a cancel "до окремого розпорядження" / "до особливого розпорядження" (it holds for the following days too).
- addedInEdit: the post is marked edited and this event is a line added to it later ("UPD:", "Оновлено:", "скасовано" appended under the original announcement).
- schedule (gpv start/change only): every queue the post lists (queue names like "1/1" or "1-1" are "1.1"), as "1.1"…"6.2" (or the region's own names), with its outage hours as {from, to, kind}. "kind": "off" for planned outages, "maybe" for "можливе відключення". A queue listed without hours: intervals null. A queue the post says has no outages: intervals []. When the post lists hours WITH power ("світло буде", "графік заживлення"), give the hours without power instead: e.g. power "00:00 - 17:00" and "з 22:30" means off "17:00"–"22:30". "з 00:00 до 24:00 діятимуть наступні черги:" followed by queues and hours lists outages. Times exactly as written; an interval through midnight ends at "24:00".
- photosAreSchedules: true when the post's photos are a schedule (a table or poster of hours per queue), also when the text lists the same hours; false otherwise (crews, damage, infographics, no photos).
- Never invent queues, hours or times that the post doesn't state.`

export const IMAGE_SYSTEM = `You read pictures published by Ukrainian power grid operators. Decide whether the picture is an outage schedule (a table or poster of hours per queue: ГПВ, ГАВ or СГАВ) and, if it is, read it exactly. Answer only with JSON in the given schema.

- isSchedule: false for anything else (crews at work, damage, infographics, maps, appeals, text without hours, and text that changes the hours of some queues only, e.g. "підчерга 2.1 - відключення триватимуть з 16:00 до 17:00"); then kind, date and statedAt are null and schedule is [].
- kind: "gpv" for the hourly schedule ("графік погодинних відключень", "ГПВ", queues 1.1…6.2), "gav" or "sgav" for emergency ones.
- date: the day the schedule is for, YYYY-MM-DD. Take the year from the publication date. null if the picture shows no date.
- statedAt: "станом на HH:MM", "оновлено HH:MM" printed on it, else null.
- schedule: one entry for EVERY queue the region has, with the queue names given. intervals: each span without power, {from, to, kind}; "off" for a planned outage, "maybe" for a possible one (often a lighter colour or a separate legend entry). A queue with no outages: []. Merge adjacent cells of the same kind into one span. Half-hour cells count: 08:30 is a valid boundary. Times HH:MM, the end of the day is "24:00".
- Read every digit carefully; if a part is unreadable, still give your best reading of the rest — never skip a queue.`

/** The user turn for a post: its input as JSON */
export function textPrompt(input: PostInput): string {
  return `Post:\n${JSON.stringify(input, null, 1)}`
}

/** The user turn for a picture (the picture itself goes alongside) */
export function imagePrompt(input: ImageInput): string {
  const meta = {
    region: input.region.name,
    queues: input.region.queues,
    publishedAt: input.publishedAt,
    album: input.of > 1 ? `picture ${input.index + 1} of ${input.of}` : null,
    caption: input.caption,
  }
  return `Picture from ${input.url}\n${JSON.stringify(meta, null, 1)}`
}

export const IMAGE_CHECK_SYSTEM =
  'Is this picture an outage schedule: a table or poster of hours per queue (ГПВ, ГАВ or СГАВ) from a Ukrainian power grid operator? Photos of crews, damage, infographics, maps and plain text are not. Answer only with JSON.'
