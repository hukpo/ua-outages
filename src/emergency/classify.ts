import { findUaDate } from '../providers/ua-text.js'
import { kyivDate, kyivInstant, toKyivIso } from '../time.js'
import { sortQueues } from './queues.js'

/**
 * Reads operator announcements about emergency schedules ("ГАВ застосовано", "аварійні
 * відключення скасовано", "заміна черг…") into structured events. Wording differs between
 * operators, so this works per sentence: a sentence counts when it names an emergency schedule
 * and has a verb of applying or cancelling; the first such sentence decides what the post is.
 *
 * Vocabulary:
 * - ГАВ: "ГАВ", "графік(и) аварійних відключень / вимкнень";
 * - СГАВ: "СГАВ", "СпецГАВ", "спеціальний графік аварійних відключень";
 * - emergency (unnamed ГАВ/СГАВ): "екстрені відключення" (DTEK, ЦЕК), and for other operators
 *   "аварійні відключення / знеструмлення / обмеження". DTEK uses "аварійні" for local damage
 *   after attacks, so its dialect doesn't count those.
 */

export type EmergencyKind = 'gav' | 'sgav' | 'emergency'

export interface Announcement {
  /**
   * apply: in force (new, more queues, or "тривають"); cancel: lifted (all, or the queues named);
   * update: the set of switched-off queues changed ("заміна черг"); unclear: the headline names
   * an emergency schedule, but what happened can't be read
   */
  action: 'apply' | 'cancel' | 'update' | 'unclear'
  kind: EmergencyKind
  /** When it took effect: the time in the text, else the post time. ISO, Kyiv offset */
  at: string
  /** `at` came from the text */
  timed: boolean
  /** apply: queues switched off; cancel: queues switched back on; update: queues switched off now */
  queues: string[] | null
  /** update: queues switched back on */
  restored: string[] | null
  /** "10 черг" without numbers; with numbers, how many */
  count: number | null
  /** "в повному обсязі": every queue */
  all: boolean
  /** apply: adds to what is in force ("додатково", "ще") instead of replacing it */
  add: boolean
  /** cancel of some queues only ("скасовано 5 черг ГАВ (з 6 по 10)") */
  partial: boolean
  /** ГПВ applies alongside: true; suspended: false; not said: null */
  scheduleApplies: boolean | null
  area: string | null
  /** A cancellation written into an earlier apply post ("UPD: … скасовано"); its time is unknown */
  edited: boolean
}

export interface Dialect {
  /** DTEK group: ГАВ is "екстрені відключення", "аварійні" is local damage */
  dtek?: boolean
  /** How many ГАВ queues "в повному обсязі" means, when the operator has a fixed number (10) */
  fullVolume?: number | null
  /** The part of the region a post is about, when the operator names it in its own way */
  area?: (text: string, sentence: string) => string | null
  /**
   * The operator's own oblast ("Житомир"). Operators repost national summaries ("у Київській,
   * Сумській … областях застосовуються аварійні відключення"): a sentence naming oblasts, none of
   * them this one, is about elsewhere.
   */
  home?: RegExp
}

// --- vocabulary ---

const L = String.raw`[\p{L}'ʼ’]`
const NOT_L = String.raw`(?<![\p{L}])`
const END_L = String.raw`(?![\p{L}])`

/** Oblasts named in a sentence: "Київщині", "Харківській області", "Київській, Сумській … областях", "м. Києві" */
const OBLASTS = new RegExp(
  `\\p{Lu}${L}+щин${L}*|\\p{Lu}${L}+(?:ськ|цьк|зьк)${L}*(?=(?:,?\\s+(?:(?:та|і|й)\\s+)?\\p{Lu}${L}+(?:ськ|цьк|зьк)${L}*)*\\s+област)|${NOT_L}Києв${L}*|${NOT_L}Київ${END_L}`,
  'gu',
)

/** The sentence names oblasts and none is `home`. Exported for tests. */
export function aboutElsewhere(sentence: string, home: RegExp | undefined): boolean {
  if (!home) return false
  const named = sentence.match(OBLASTS)
  return !!named?.length && !named.some((n) => home.test(n))
}

const SGAV = new RegExp(
  `спеціальн${L}*\\s+граф${L}*\\s+аварійн|${NOT_L}(?:с|спец\\.?\\s?)гав${END_L}|спецгав`,
  'iu',
)
const GAV = new RegExp(
  `${NOT_L}гав${END_L}|граф${L}*\\s+аварійн${L}*\\s+(?:відключ|вимкн|знеструм)|аварійн${L}*\\s+вимкн`,
  'iu',
)
const EXTRA = new RegExp(`екстрен${L}*\\s+(?:відключ|вимкн|знеструм)`, 'iu')
/** Not for DTEK: there these words mean local damage */
const AVAR = new RegExp(`аварійн${L}*\\s+(?:відключ|знеструм|обмежен)`, 'iu')

const CANCEL = new RegExp(
  [
    `скасован${L}*`,
    `скасування`,
    `скасувати`,
    `відмінен${L}*`,
    `відміну`,
    `відмінити`,
    `деактивован${L}*`,
    `деактивац${L}*`,
    `замість\\s+(?:граф${L}*\\s+)?аварійн`,
    `замінено\\s+на`,
  ].join('|'),
  'iu',
)
/** "замість аварійних діють графіки погодинних": names ГАВ and cancels it */
const INSTEAD = new RegExp(`замість\\s+(?:граф${L}*\\s+)?аварійн`, 'iu')
/** Words of cancelling that don't cancel: "до окремої вказівки про скасування", "будуть скасовані після стабілізації", "не вдається скасувати" */
const NOT_A_CANCEL = new RegExp(
  [
    `до\\s+окрем${L}*\\s+(?:вказівк|розпоряджен|команд)${L}*(?:\\s+(?:про|щодо)\\s+(?:їх\\s+)?скасуван${L}*)?`,
    `(?:будуть|буде|можуть|може)\\s+(?:${L}+\\s+)?скасован${L}*\\s+(?:${L}+\\s+){0,3}?(?:після|щойно|одразу|коли)`,
    `(?:не\\s+(?:${L}+\\s+)?)скасувати`,
    `скасувати\\s+[^.]{0,60}?не\\s+вда`,
  ].join('|'),
  'giu',
)
const NEG = String.raw`(?<!не\s)(?<!не\s\s)`
const APPLY = new RegExp(
  [
    `застосован${L}*`,
    `застосову(?:ється|ються|ватимуться)`,
    `застосування`,
    `будуть\\s+застосовуватися`,
    `запроваджен${L}*`,
    `введен${L}*`,
    `ввести`,
    `вводиться`,
    `вводяться`,
    `задіян${L}*`,
    `${NEG}діють`,
    `${NEG}діє`,
    `тривають`,
    `триває`,
    `відключили`,
    `відключаємо`,
    `знеструмлюємо`,
  ]
    .map((v) => `${NOT_L}(?:${v})${END_L}`)
    .join('|'),
  'iu',
)
/** A post about how the switched-off queues changed */
const UPDATE = new RegExp(
  `зміни\\s+в\\s+(?:застосуванні\\s+)?(?:гав|граф)|заміна\\s+черг|оновлення\\s+щодо\\s+граф${L}*\\s+аварійн|ситуація\\s+по\\s+гав`,
  'iu',
)
/** Explanations and reminders: they use the same words without announcing anything */
const EXPLAINER = new RegExp(
  `^[^\\p{L}]*(?:шановні\\s+споживачі,?\\s+)?(?:нагада|нагаду|чому|що\\s+таке|що\\s+відбувається|як\\s|пояснюємо|роз'ясню|❓)`,
  'iu',
)
const ADD = new RegExp(`${NOT_L}(?:додатково|ще)${END_L}`, 'iu')

/** DTEK: "Київ: повертаємось до графіків" cancels without naming the emergency */
const BACK_TO_SCHEDULES = new RegExp(`поверта${L}*\\s+до\\s+(?:${L}+\\s+){0,2}?граф`, 'iu')

const SCHEDULE_ON = new RegExp(
  [
    `(?:продовжу${L}*|одночасно|також)\\s+(?:${L}+\\s+){0,3}?(?:діяти|діють|діє|діятим${L}*)\\s+(?:${L}+\\s+){0,2}?(?:граф${L}*\\s+погодинн|гпв)`,
    `граф${L}*\\s+погодинн${L}*\\s+(?:відключ${L}*\\s+)?(?:продовжу${L}*\\s+діяти|діють)`,
    `окрім\\s+граф${L}*\\s+погодинн`,
    `поверта${L}*\\s+до\\s+(?:${L}+\\s+){0,2}?граф`,
    `(?:діють|застосовані|натомість\\s+діють)\\s+(?:граф${L}*\\s+)?погодинн`,
    `замість\\s+(?:граф${L}*\\s+)?аварійн${L}*\\s+(?:${L}+\\s+){0,4}?(?:діють|застосовані|застосовано|будуть\\s+застосовані)\\s+(?:граф${L}*\\s+)?(?:погодинн|підчерг)`,
  ].join('|'),
  'iu',
)
const SCHEDULE_OFF = new RegExp(
  `граф${L}*(?:\\s+(?:погодинн|стабілізаційн|знеструмлен|відключен)${L}*)*[^.!?\\n]{0,90}?\\s(?:наразі\\s+|тимчасово\\s+)?не\\s+ді(?:ють|є)`,
  'iu',
)

// --- numbers ---

const WORD_COUNT: [RegExp, number][] = [
  [new RegExp(`${NOT_L}(?:одн(?:ієї|а|у|ієї))${END_L}`, 'iu'), 1],
  [new RegExp(`${NOT_L}(?:дві|двох|два)${END_L}`, 'iu'), 2],
  [new RegExp(`${NOT_L}(?:три|трьох)${END_L}`, 'iu'), 3],
  [new RegExp(`${NOT_L}(?:чотири|чотирьох)${END_L}`, 'iu'), 4],
  [new RegExp(`${NOT_L}(?:п'ять|п'яти)${END_L}`, 'iu'), 5],
  [new RegExp(`${NOT_L}(?:шість|шести)${END_L}`, 'iu'), 6],
  [new RegExp(`${NOT_L}(?:сім|семи)${END_L}`, 'iu'), 7],
  [new RegExp(`${NOT_L}(?:вісім|восьми)${END_L}`, 'iu'), 8],
  [new RegExp(`${NOT_L}(?:дев'ять|дев'яти)${END_L}`, 'iu'), 9],
  [new RegExp(`${NOT_L}(?:десять|десяти)${END_L}`, 'iu'), 10],
]
const ORDINALS: [string, number][] = [
  ['перш', 1],
  ['друг', 2],
  ['трет', 3],
  ['четверт', 4],
  ["п'ят", 5],
  ['шост', 6],
  ['сьом', 7],
  ['восьм', 8],
  ["дев'ят", 9],
  ['десят', 10],
]
const ORD = `(?:${ORDINALS.map(([s]) => s).join('|')})(?:а|у|ої|ій|ою|і)`
const ORD_LIST = new RegExp(
  `черг${L}*[^.\\n]{0,25}?[–—-]\\s*(${ORD}(?:\\s*(?:,|і|та|й)\\s*${ORD})*)${END_L}`,
  'iu',
)

interface Queues {
  list: string[] | null
  count: number | null
  all: boolean
}

/** Times, dates and ГПВ subqueues ("1.1") out, so their digits aren't read as queues. */
function stripNonQueueNumbers(s: string): string {
  return s
    .replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, ' ')
    .replace(/\d{1,2}\s*год\.?\s*\d{1,2}\s*хв\.?/giu, ' ')
    .replace(/\d{1,2}[:.]\d{1,2}/g, ' ')
    .replace(
      new RegExp(
        `\\d{1,2}\\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)${END_L}`,
        'giu',
      ),
      ' ',
    )
    .replace(/\(\s*\d+(?:[.,]\d+)?\s*Гц\s*\)/giu, ' ')
}

const range = (a: number, b: number): string[] => {
  if (a < 1 || b < a || b > 30) return []
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i))
}

/** Queue numbers, count and "all" named in one piece of text. Exported for tests. */
export function extractQueues(text: string, fullVolume: number | null = null): Queues {
  const s = stripNonQueueNumbers(text.replace(/[’ʼ`]/g, "'"))
  const all = new RegExp(
    `(?:в|у)\\s+повному\\s+обсязі|${NOT_L}(?:всіх|усіх)\\s+(?:\\d+\\s+)?черг|${NOT_L}(?:всі|усі)\\s+черги`,
    'iu',
  ).test(s)
  const list = new Set<string>()
  let count: number | null = null

  // ranges: "1-5 черг", "(6-10 черга)", "6-10 черги", "з 6 по 10", "1-ша - 3-тя черги"
  const suffix = String.raw`(?:-?[\p{L}]{1,3})?`
  const rangeRe = new RegExp(
    `${NOT_L}(?<![\\d.])(\\d{1,2})${suffix}\\s*[-–—]\\s*(\\d{1,2})${suffix}(?![\\d.])(?=[^\\d]{0,12}черг|\\s*\\))|${NOT_L}з\\s+(\\d{1,2})\\s+по\\s+(\\d{1,2})${END_L}`,
    'giu',
  )
  for (const m of s.matchAll(rangeRe))
    for (const q of range(Number(m[1] ?? m[3]), Number(m[2] ?? m[4]))) list.add(q)

  const withoutRanges = s.replace(rangeRe, ' ')
  // numbers after "черг…": "черги 3 і 4", "черга 2", "черг 1 та 10", "черги: 5,6,7"
  const sep = String.raw`\s*(?:,|і|та|й)\s*`
  const after = new RegExp(
    `черг${L}*\\s*(?:№\\s*|:\\s*)?((?:\\d{1,2}(?![\\d.])${sep})*\\d{1,2})(?![\\d.])`,
    'giu',
  )
  for (const m of withoutRanges.matchAll(after))
    for (const n of m[1]!.split(/\D+/).filter(Boolean)) list.add(String(Number(n)))
  // numbers before "черг…": a list ("1, 2 чергу", "1,2,3 та 4 черги") names queues; one number is
  // a count ("10 черг", "2 черги", "1 чергу") unless its form names one queue ("8 черга", "7 черги")
  const before = new RegExp(
    `(?<![\\d.])((?:\\d{1,2}${sep})*\\d{1,2})\\s*(?:-?[\\p{L}]{1,3}\\s+)?(черг${L}*)`,
    'giu',
  )
  for (const m of withoutRanges.matchAll(before)) {
    const nums = m[1]!.split(/\D+/).filter(Boolean).map(Number)
    if (nums.length > 1) for (const n of nums) list.add(String(n))
    else {
      const n = nums[0]!
      const form = m[2]!.toLowerCase()
      if (form === 'черг' || n <= 4) count = Math.max(count ?? 0, n)
      else list.add(String(n))
    }
  }
  // "5 черг графіків аварійних вимкнень (5,6,7,8,9)"
  for (const m of withoutRanges.matchAll(
    new RegExp(`черг${L}*[^()\\d.]{0,50}\\(\\s*((?:\\d{1,2}\\s*[,;]\\s*)+\\d{1,2})\\s*\\)`, 'giu'),
  ))
    for (const n of m[1]!.split(/\D+/).filter(Boolean)) list.add(String(Number(n)))
  // "дві черги ГАВ – пʼята та шоста"
  const ord = ORD_LIST.exec(s)
  if (ord)
    for (const word of ord[1]!.split(/\s*,\s*|\s+(?:і|та|й)\s+/))
      for (const [stem, n] of ORDINALS) if (word.toLowerCase().startsWith(stem)) list.add(String(n))
  if (count === null) {
    // "в обсязі однієї черги", "десять черг"
    const words = new RegExp(`(${L}+)\\s+черг`, 'giu')
    for (const m of s.matchAll(words))
      for (const [re, n] of WORD_COUNT) if (re.test(m[1]!)) count = Math.max(count ?? 0, n)
  }
  // "ще одна черга": one more
  if (count === null && new RegExp(`ще\\s+одн${L}*\\s+черг`, 'iu').test(s)) count = 1

  const queues = list.size ? sortQueues(list) : null
  if (all && !queues && fullVolume) return { list: range(1, fullVolume), count: fullVolume, all }
  return { list: queues, count: queues ? queues.length : all ? (fullVolume ?? count) : count, all }
}

// --- sentences ---

/** Sentence ends; abbreviations ("м.", "год.", "вул.") don't end one. Exported for tests. */
export function sentences(text: string): string[] {
  return (
    text
      .replace(/[’ʼ`]/g, "'")
      // a line break inside a sentence ("введено Спеціальні\nграфіки …") isn't an end
      .replace(/\n(?=\p{Ll})/gu, ' ')
      .split(
        /\n+|(?<!(?:^|[\s("«\d])(?:м|с|смт|вул|обл|ім|год|хв|див|тис|ч|р|пров|просп|бул|пл))[.!?‼❗]+️?(?=\s|$)/u,
      )
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

interface Hit {
  sentence: string
  index: number
  kind: EmergencyKind
  action: 'apply' | 'cancel'
}

const SGAV_ALL = new RegExp(SGAV.source, 'giu')

function termOf(s: string, dialect: Dialect): EmergencyKind | null {
  // "ГАВ та СГАВ" in one sentence: ГАВ (СГАВ alone only when no plain ГАВ is named)
  if (SGAV.test(s)) return GAV.test(s.replace(SGAV_ALL, ' ')) ? 'gav' : 'sgav'
  if (GAV.test(s) || INSTEAD.test(s)) return 'gav'
  if (EXTRA.test(s)) return 'emergency'
  if (!dialect.dtek && AVAR.test(s)) return 'emergency'
  return null
}

function hitOf(s: string, index: number, dialect: Dialect): Hit | null {
  if (EXPLAINER.test(s) || /\?\s*$/.test(s) || aboutElsewhere(s, dialect.home)) return null
  const kind = termOf(s, dialect)
  if (!kind) {
    // DTEK: "Київщина: повертаємось до графіків відключень" ends an emergency without naming it
    if (dialect.dtek && BACK_TO_SCHEDULES.test(s) && !/аварі/iu.test(s))
      return { sentence: s, index, kind: 'emergency', action: 'cancel' }
    return null
  }
  if (CANCEL.test(s.replace(NOT_A_CANCEL, ' '))) return { sentence: s, index, kind, action: 'cancel' }
  if (APPLY.test(s)) return { sentence: s, index, kind, action: 'apply' }
  if (BACK_TO_SCHEDULES.test(s)) return { sentence: s, index, kind, action: 'cancel' }
  return null
}

// --- time ---

const TIME_RES: RegExp[] = [
  // "22.01.2026 з 08 год. 24 хв."
  /(?<date>\d{2}\.\d{2}\.\d{4})\s+з\s+(?<h>\d{1,2})\s*год\.?\s*(?<m>\d{1,2})\s*хв/iu,
  /(?:^|[\s(])з\s+(?<h>\d{1,2})\s*год\.?\s*(?<m>\d{1,2})\s*хв/iu,
  // "з 10:35", "О 9:44", "об 11:12", "В 06:10", "станом на 22:02", "з 18.00"
  /(?:^|[\s(])(?:з|о|об|в|станом\s+на|на)\s+(?<h>\d{1,2})[:.](?<m>\d{2})(?!\d)/iu,
]

/** The time named in `text` as an instant, read against the post time. */
function timeIn(text: string, posted: Date): Date | null {
  for (const re of TIME_RES) {
    const m = re.exec(text)
    if (!m?.groups) continue
    const h = Number(m.groups.h)
    const min = Number(m.groups.m)
    if (h > 23 || min > 59) continue
    let date = m.groups.date
      ? m.groups.date.split('.').reverse().join('-')
      : findUaDate(text.replace(/\d{1,2}\s*[:.]\s*\d{2}(?!\.\d)/g, ' '), posted)
    const explicit = !!date
    date ??= kyivDate(posted)
    let at = kyivInstant(date, h * 60 + min)
    if (!explicit) {
      // "з 23:55" posted at 00:10 is yesterday; "з 00:05" posted at 23:58 is tomorrow
      const diff = at.getTime() - posted.getTime()
      if (diff > 12 * 3600_000) at = new Date(at.getTime() - 86400_000)
      else if (diff < -12 * 3600_000) at = new Date(at.getTime() + 86400_000)
    }
    return at
  }
  return null
}

// --- area ---

const DISTRICTS = new RegExp(
  `(?:^|\\s)(?:у|в)\\s+((?:частині\\s+)?(?:\\p{Lu}${L}+(?:ському|цькому|зькому|ського|цького|зького)(?:,\\s*|\\s+(?:і|та|й)\\s+))*\\p{Lu}${L}+(?:ському|цькому|зькому|ського|цького|зького)\\s+район(?:ах|ів|і|у))`,
  'u',
)
const PART = new RegExp(
  `(?:^|\\s)(?:у|в)\\s+((?:північн|південн|східн|західн|центральн)${L}*\\s+(?:частині|районах)\\s+\\p{Lu}${L}+(?:\\s+област${L}*)?)`,
  'u',
)

/** The part of the region named in a sentence ("у Ніжинському і Прилуцькому районах"). Exported for tests. */
export function districtArea(sentence: string): string | null {
  return DISTRICTS.exec(sentence)?.[1] ?? PART.exec(sentence)?.[1] ?? null
}

// --- the post ---

/**
 * One post → what it announces, or null when it isn't about an emergency schedule. `posted`
 * is the post time; times in the text ("з 10:35") are read against it.
 */
export function classifyPost(text: string, posted: Date, dialect: Dialect = {}): Announcement | null {
  const all = sentences(text)
  if (!all.length) return null
  // "❓ Чому застосовуються графіки…", "Нагадаємо, СГАВ — це…": explanations, not announcements
  if (EXPLAINER.test(all[0]!) || /^[^\n]*\?\s*(?:\n|$)/u.test(text.trim())) return null
  // "UPD: … скасовано" on top of an apply post: the post is now a cancellation
  const upd = /^\W*UPD\b/iu.test(text.trim())
  const hits = all.map((s, i) => hitOf(s, i, dialect)).filter((h): h is Hit => !!h)
  const update = all.some((s) => UPDATE.test(s))

  // the "UPD" line comes first; "UPD." may stand as a sentence of its own
  let first = upd ? hits.find((h) => h.index <= 1) : hits[0]
  if (upd && !first) first = hits[0]
  if (!first && !update) {
    // a headline naming the schedule without saying what happened
    const head = all[0]!
    const kind = EXPLAINER.test(head) ? null : termOf(head, dialect)
    if (!kind) return null
    // "аварійні знеструмлення. Графіки погодинних відключень наразі не діють": in force
    const action = SCHEDULE_OFF.test(text) ? 'apply' : 'unclear'
    return base(action, kind, [head], text, posted, dialect, upd)
  }

  if (update && (!first || first.action === 'apply')) {
    const kind = first?.kind ?? termOf(text, dialect) ?? 'gav'
    const { off, on } = swapOf(all, dialect.fullVolume ?? null)
    if (off.length || on.length) {
      const a = base('update', kind, all, text, posted, dialect, false)
      return {
        ...a,
        queues: off.length ? off : null,
        restored: on.length ? on : null,
        count: off.length || null,
      }
    }
  }
  if (!first) return null
  // "На Дніпровщині та Київщині … У зв'язку з цим застосовуються аварійні відключення": a
  // national summary (other oblasts, or a list of many); the operator's own names only its oblast
  if (first.kind === 'emergency' && dialect.home) {
    const named = new Set(text.match(OBLASTS) ?? [])
    if (named.size >= 3 || (named.size && !dialect.home.test(text))) return null
  }

  // the sentences that say the same thing as the decisive one carry its details
  const same = hits.filter((h) => h.action === first.action).map((h) => h.sentence)
  const kind = kindOf(first, hits, text)
  const a = base(first.action, kind, same, text, posted, dialect, upd)
  // "в повному обсязі" is a known number of queues only for ГАВ
  const q = extractQueues(same.join('. '), kind === 'gav' ? (dialect.fullVolume ?? null) : null)
  const named = q.list ?? null
  const announcement: Announcement = {
    ...a,
    queues: named,
    count: q.count,
    all: q.all,
    add: first.action === 'apply' && same.some((x) => ADD.test(x)),
    partial: first.action === 'cancel' && !q.all && (!!named || q.count !== null),
  }
  // "Наразі діє 10 черг ГАВ одночасно": the total after an addition
  const total = new RegExp(`наразі\\s+(?:діє|діють)\\s+(\\d{1,2})\\s+черг`, 'iu').exec(text)
  if (announcement.action === 'apply' && total) {
    announcement.add = false
    announcement.count = Number(total[1])
    if (named && named.length !== announcement.count) announcement.queues = null
  }
  // "Сумщині введені графіки аварійних відключень для 6-10 черг (1-5 ввімкнені)": the rest is on
  if (announcement.action === 'apply' && !announcement.add) {
    const { on } = swapOf(same, null)
    if (on.length && named) {
      announcement.queues = named.filter((n) => !on.includes(n))
      announcement.count = announcement.queues.length
    }
  }
  return announcement
}

function kindOf(first: Hit, hits: Hit[], text: string): EmergencyKind {
  if (first.action === 'cancel') {
    // "UPD: аварійні відключення скасовані. … запроваджено (СпецГАВ)": still a cancel of everything
    return first.kind
  }
  if (first.kind !== 'emergency') return first.kind
  // "аварійні відключення електроенергії (ГАВ)" in another sentence of the post
  const named = hits.find((h) => h.action === 'apply' && h.kind !== 'emergency')?.kind
  if (named) return named
  if (/\(\s*гав\s*\)/iu.test(text)) return 'gav'
  if (/\(\s*(?:с|спец)\s*гав\s*\)/iu.test(text)) return 'sgav'
  return 'emergency'
}

function base(
  action: Announcement['action'],
  kind: EmergencyKind,
  relevant: string[],
  text: string,
  posted: Date,
  dialect: Dialect,
  edited: boolean,
): Announcement {
  let at: Date | null = null
  for (const s of relevant) if ((at = timeIn(s, posted))) break
  const decisive = relevant[0] ?? ''
  return {
    action,
    kind,
    at: toKyivIso(at ?? posted),
    timed: !!at,
    queues: null,
    restored: null,
    count: null,
    all: false,
    add: false,
    partial: false,
    scheduleApplies: scheduleAppliesOf(action, text),
    area: dialect.area ? dialect.area(text, decisive) : districtArea(decisive),
    edited: edited && action === 'cancel',
  }
}

function scheduleAppliesOf(action: Announcement['action'], text: string): boolean | null {
  const on = SCHEDULE_ON.test(text)
  const off = SCHEDULE_OFF.test(text)
  if (action === 'cancel') return on ? true : null
  if (off) return false
  return on ? true : null
}

const ON_WORDS = new RegExp(`увімкн|ввімкн|вмика|відновл|зі\\s+світлом|заживл|поверта${L}*\\s+електро`, 'iu')
const OFF_WORDS = new RegExp(`вимкн|знеструмлю|без\\s+(?:електро)?(?:постачання|світла)|відключ`, 'iu')
const CLAUSE_BREAK = new RegExp(
  `[;\\n]|\\.\\s|,\\s*(?=(?:${L}+\\s+){0,2}?(?:вимкн|знеструм|вмика|увімкн|ввімкн|відновл|заживл))|натомість|\\(`,
  'iu',
)

/** Queues switched off and back on in a "заміна черг" / "зміни в ГАВ" post. */
function swapOf(parts: string[], fullVolume: number | null): { off: string[]; on: string[] } {
  const off = new Set<string>()
  const on = new Set<string>()
  for (const clause of parts.join('\n').split(CLAUSE_BREAK)) {
    const isOn = ON_WORDS.test(clause)
    const isOff = OFF_WORDS.test(clause.replace(new RegExp(ON_WORDS.source, 'giu'), ' '))
    if (isOn === isOff) continue
    const q = extractQueues(clause, fullVolume).list
    for (const n of q ?? []) (isOn ? on : off).add(n)
  }
  for (const n of on) off.delete(n)
  return { off: sortQueues(off), on: sortQueues(on) }
}

// --- Ukrenergo ---

/**
 * A national @Ukrenergo post about one oblast (its adjective stem, e.g. "Волинськ"): apply,
 * cancel, or null when the post doesn't name it. Ukrenergo names oblasts only sometimes
 * ("у Харківській, Сумській та Полтавській областях запроваджені аварійні відключення"), so
 * this is a low-confidence hint; "лише у Харківській області" ends it everywhere else.
 */
export function classifyUkrenergo(text: string, posted: Date, oblastStem: string): Announcement | null {
  const stem = new RegExp(`${NOT_L}${oblastStem}`, 'iu')
  for (const s of sentences(text)) {
    if (!AVAR.test(s) && !GAV.test(s)) continue
    const only = new RegExp(`продовжують\\s+діяти\\s+лише\\s+(?:у|в)\\s+([^.]*)`, 'iu').exec(s)
    if (only) {
      if (stem.test(only[1]!)) return ukr('apply', text, posted)
      return ukr('cancel', text, posted)
    }
    if (!stem.test(s)) continue
    // past tense ("зранку застосовувалися") says nothing about now
    if (new RegExp(`застосовувал${L}*|діяли${END_L}`, 'iu').test(s)) continue
    if (CANCEL.test(s)) return ukr('cancel', text, posted)
    if (APPLY.test(s) || /вимушен/iu.test(s)) return ukr('apply', text, posted)
  }
  return null
}

function ukr(action: 'apply' | 'cancel', text: string, posted: Date): Announcement {
  return {
    action,
    kind: 'emergency',
    at: toKyivIso(posted),
    timed: false,
    queues: null,
    restored: null,
    count: null,
    all: false,
    add: false,
    partial: false,
    scheduleApplies: scheduleAppliesOf(action, text),
    area: null,
    edited: false,
  }
}
