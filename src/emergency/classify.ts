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
  /** update, apply: queues switched back on ("(1-5 ввімкнені)", "замість 1 та 2 черг …") */
  restored: string[] | null
  /** "10 черг" without numbers; with numbers, how many */
  count: number | null
  /** "в повному обсязі": every queue */
  all: boolean
  /** apply: adds to what is in force ("додатково", "ще") instead of replacing it */
  add: boolean
  /**
   * apply: "знову введені ГАВ (для 6-10 черг)": the queues named are in force again, so whatever
   * ran before was lifted in between (Sumy never posts that)
   */
  again: boolean
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

/** A word of a name, hyphen included ("Івано-Франківській") */
const LH = String.raw`[\p{L}'ʼ’-]`
/** Oblasts named in a sentence: "Київщині", "Харківській області", "Київській, Сумській … областях", "м. Києві" */
const OBLASTS = new RegExp(
  `(?<![\\p{L}-])\\p{Lu}${LH}+щин${L}*|(?<![\\p{L}-])\\p{Lu}${LH}+(?:ськ|цьк|зьк)${L}*(?=(?:,?\\s+(?:(?:та|і|й)\\s+)?\\p{Lu}${LH}+(?:ськ|цьк|зьк)${L}*)*\\s+област)|${NOT_L}Києв${L}*|${NOT_L}Київ${END_L}`,
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
  `${NOT_L}гав${END_L}|граф${L}*\\s+аварійн${L}*\\s+(?:відключ|вимкн|знеструм)|аварійн(?:і|их)\\s+вимкн`,
  'iu',
)
const EXTRA = new RegExp(`екстрен${L}*\\s+(?:відключ|вимкн|знеструм)`, 'iu')
/**
 * Not for DTEK: there these words mean local damage. Plural only: "аварійне відключення /
 * знеструмлення" (singular) is one fault ("через аварійне відключення в мережах 110 кВ").
 */
const AVAR = new RegExp(`аварійн(?:і|их|ими)\\s+(?:відключ|знеструм|обмежен)`, 'iu')
/** "внаслідок обстрілу діють аварійні відключення у …районі": damage, not a schedule */
const DAMAGE = new RegExp(
  `(?:через|внаслідок|унаслідок)\\s+(?:${L}+\\s+){0,3}?(?:обстріл|атак|удар|пошкоджен|аварі|влучан)|пошкоджен${L}*\\s+(?:кабел|лін|обладнан|підстанц)`,
  'iu',
)

/**
 * "замість аварійних діють графіки погодинних": names ГАВ and cancels it. Only with the schedule
 * that replaces it named: "замість аварійного трансформатора встановлено новий" is not about ГАВ.
 */
const INSTEAD = new RegExp(
  `замість\\s+(?:граф${L}*\\s+)?аварійн${L}*(?=[^.!?\\n]{0,80}?(?:погодинн|гпв|підчерг))`,
  'iu',
)

const CANCEL = new RegExp(
  [
    `скасован${L}*`,
    // the present tense, ЦЕК 17.11.2026: "скасовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️ Повертаємося до ГПВ"
    `скасову${L}+`,
    `відміня(?:ю|є)ться`,
    // the noun only as news: "Повідомляємо про скасування", "команда … про скасування ГАВ"
    `${NOT_L}про\\s+скасування`,
    `скасувати`,
    `припинен${L}*`,
    `завершен${L}*`,
    `${NOT_L}знято${END_L}`,
    `відмінен${L}*`,
    `відміну`,
    // the noun as the whole news, Kirovohrad 17.11.2026: "В 14:05 відміна дії графіку ГАВ"
    `${NOT_L}відміна\\s+(?:дії\\s+)?(?:граф${L}*\\s+)?(?:с?гав${END_L}|аварійн|екстрен)`,
    `відмінити`,
    `деактивован${L}*`,
    `деактивац${L}*`,
    // "ГАВ замінено на графіки погодинних відключень" (the other way round is an apply)
    `замінено\\s+на\\s+(?:граф${L}*\\s+)?(?:погодинн|гпв)`,
  ].join('|'),
  'iu',
)
/**
 * Words of cancelling that don't cancel: conditions, the future, the possible. "до окремої
 * вказівки … про їх скасування", "будуть скасовані після стабілізації", "можуть бути скасовані у
 * будь-який момент", "скасовано не буде", "Скасування ГАВ залежить від…", "Після скасування ГАВ
 * будуть діяти ГПВ", "скасувати … не вдається".
 */
const NOT_A_CANCEL = new RegExp(
  [
    `до\\s+окрем${L}*\\s+(?:вказівк|розпоряджен|команд)${L}*(?:\\s+(?:${L}+\\s+){0,3}?(?:про|щодо)\\s+(?:їх\\s+|його\\s+)?скасуван${L}*)?`,
    `(?:будуть|буде|можуть|може|мають|має|планують|планується|можливе|можливо)\\s+(?:бути\\s+)?(?:${L}+\\s+){0,2}?скасов${L}*`,
    `(?:скасов|скасув)${L}*\\s+не\\s+буд${L}*`,
    `скасуванн${L}*\\s+(?:${L}+\\s+){0,3}?(?:залеж|відбуд|можлив|очіку)${L}*`,
    `(?:після|до|щодо|для|без)\\s+(?:їх\\s+)?скасуванн${L}*`,
    `скасувати\\s+[^.]{0,60}?не\\s+вда${L}*`,
    // "діятимуть до завершення ремонтних робіт", "до припинення дефіциту потужності"
    `(?:до|після)\\s+(?:повного\\s+)?(?:завершення|припинення|відміни|закінчення)`,
  ].join('|'),
  'giu',
)
/**
 * ГПВ cancelled: "Графіки погодинних відключень скасовано, натомість застосовано графіки
 * аварійних", "ГПВ відмінено та застосовано ГАВ". The cancel is about ГПВ; what follows may
 * apply the emergency schedule.
 */
const GPV_CANCELLED = new RegExp(
  [
    `(?:граф${L}*\\s+(?:погодинн|стабілізаційн)${L}*(?:\\s+(?:відключ|вимкн)${L}*)?|${NOT_L}гпв${END_L})(?:\\s+${L}+){0,3}?\\s+(?:скасован|відмінен)${L}*`,
    `(?:скасован|відмінен)${L}*\\s+(?:${L}+\\s+){0,2}?(?:граф${L}*\\s+(?:погодинн|стабілізаційн)${L}*(?:\\s+(?:відключ|вимкн)${L}*)?|гпв${END_L})`,
  ].join('|'),
  'giu',
)
/** Denials: "Інформація про скасування аварійних відключень … не відповідає дійсності" */
const DENIAL = new RegExp(`не\\s+відповіда${L}*\\s+дійсн|${NOT_L}фейк|${NOT_L}неправд`, 'iu')
/**
 * Hypotheses, conditions, purposes and the past: "У разі перевищення лімітів … будуть
 * застосовані ГАВ", "щоб уникнути застосування", "Вчора застосовано ГАВ". Not news of now.
 */
const NOT_NOW = new RegExp(
  `${NOT_L}(?:у|в)\\s+разі${END_L}|${NOT_L}(?:якщо|щоб|аби|вчора|напередодні)${END_L}|уникн${L}*|минул${L}*\\s+доби|під\\s+час\\s+(?:застосування|дії)`,
  'iu',
)
/** "було застосовано", "були скасовані": the past, unless it names a time of the last day */
const PAST = new RegExp(`${NOT_L}(?:було|були)${END_L}`, 'iu')
/**
 * A purpose clause, up to the next comma: "Щоб уникнути аварій в енергосистемі, застосовано ГАВ"
 * applies, "Економте, щоб уникнути застосування ГАВ" doesn't. What it says isn't news.
 */
const PURPOSE = new RegExp(
  `(?:${NOT_L}(?:щоб|аби)${END_L}|${NOT_L}(?:з\\s+метою|задля|для)\\s+(?=уникн|запобіг|недопущ))[^,.;:!?—–]*`,
  'giu',
)
const withoutPurpose = (s: string) => s.replace(PURPOSE, ' ')
/**
 * National wording, about no region in particular: "в окремих регіонах України запроваджені
 * аварійні відключення", "У більшості регіонів скасовано", "по всій країні". Operators repost
 * Ukrenergo's summaries; they say nothing about this region unless the sentence names an oblast
 * ("після обстрілів по всій Україні … по Тернопільській області вводяться"). "В УСІХ РЕГІОНАХ
 * (крім …)" includes it and counts.
 */
const NATIONAL = new RegExp(
  [
    `${NOT_L}(?:в|у)\\s+(?:окремих|деяких|низці|багатьох|більшості|частині|ряді)\\s+(?:регіон|област)${L}*`,
    `${NOT_L}(?:в|у)\\s+регіонах(?:\\s+україни|,?\\s+де${END_L})`,
    `${NOT_L}(?:по|в|у)\\s+(?:всій|усій)\\s+(?:країні|україні)`,
    `${NOT_L}по\\s+(?:країні|україні)${END_L}`,
  ].join('|'),
  'iu',
)
/** About the schedules as documents: "набрали чинності оновлені графіки (ГПВ, ГАВ та СГАВ)" */
const DOCS = new RegExp(
  `набра${L}*\\s+чинност|\\(\\s*(?:гпв|гав|сгав|гоп|ачр)(?:\\s*(?:,|та|і|й)\\s*(?:гпв|гав|сгав|гоп|ачр))+\\s*\\)`,
  'iu',
)
/**
 * A negated verb says what is not happening: "не скасовано", "поки що не скасовано", "не
 * застосовуються", "не діють". Such a sentence neither applies nor cancels (an operator saying
 * "аварійні відключення не застосовуються" is ignored rather than read as a cancellation: a
 * false "cancelled" hides a real emergency, a missed one ends with the TTL).
 */
const NEGATED = new RegExp(
  `${NOT_L}не\\s+(?:${L}+\\s+){0,2}?(?:скасов|скасув|відмін|деактив|припин|застосов|запровадж|введ|вводя|вводи|діют|діє|діял|трива|задіян)${L}*`,
  'giu',
)
const NEG = String.raw`(?<!не\s)(?<!не\s\s)`
const APPLY = new RegExp(
  [
    `застосован${L}*`,
    `застосову(?:ється|ються|ватимуться)`,
    // nouns only as news: "команда на застосування ГАВ", "Повідомляємо про застосування",
    // "вказівка про введення графіків аварійних вимкнень"
    `(?:про|на)\\s+(?:застосування|введення)`,
    `будуть\\s+застосовуватися`,
    `замінено\\s+на\\s+(?:граф${L}*\\s+)?аварійн${L}*`,
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
    `продовжу${L}*\\s+діяти`,
    // "протягом доби відбувається зміна черг СГАВ": a rotation, so in force
    `(?:відбувається|відбуватиметься|триває)\\s+зміна\\s+черг`,
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
  `зміни\\s+в\\s+(?:застосуванні\\s+)?(?:гав|граф)|заміна\\s+черг|підмін${L}*\\s+черг|оновлення\\s+щодо\\s+граф${L}*\\s+аварійн|ситуація\\s+по\\s+гав`,
  'iu',
)
/** Explanations and reminders: they use the same words without announcing anything */
const EXPLAINER = new RegExp(
  // "Як повідомляє Укренерго, …" reports news; "Як діяти…" explains
  `^[^\\p{L}]*(?:шановні\\s+споживачі,?\\s+)?(?:нагада|нагаду|чому|що\\s+таке|що\\s+відбувається|як\\s(?!повідом|інформу|зазнач|передає)|пояснюємо|роз'ясню|❓)`,
  'iu',
)
const ADD = new RegExp(`${NOT_L}(?:додатково|ще)${END_L}`, 'iu')
const AGAIN = new RegExp(`${NOT_L}(?:знову|повторно)${END_L}`, 'iu')

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
  `граф${L}*(?:\\s+(?:погодинн|стабілізаційн|знеструмлен|відключен)${L}*)*[^.!?\\n]{0,90}?\\s(?:наразі\\s+|тимчасово\\s+)?не\\s+ді(?:ють|є)|${GPV_CANCELLED.source}`,
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
      // "N черг" (5+) and "2–4 черги" count; "N чергу" (N ≥ 2: "застосовано 3 чергу"), "N черга",
      // "N черги" for N ≥ 5 ("7 черги ГАВ") and "для N черги" name one queue. "1 чергу" is the
      // count one (Chernihiv: "застосовано 1 чергу Графіка")
      const forQueue = /для\s*$/iu.test(withoutRanges.slice(Math.max(0, m.index! - 6), m.index!))
      const counts = form === 'черг' || (form === 'черги' && n <= 4) || (form === 'чергу' && n === 1)
      if (counts && !forQueue) count = Math.max(count ?? 0, n)
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
/** Latin letters that look Cyrillic, typed into Cyrillic words ("гaв" with a Latin a) */
const LOOKALIKE: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  i: 'і',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  I: 'І',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
}

/** "гaв", "CГАВ" (Latin a, C) → "гав", "СГАВ"; words without a Cyrillic letter stay as they are */
export function foldLookalikes(text: string): string {
  return text.replace(/[\p{Script=Cyrillic}A-Za-z]+/gu, (w) =>
    /\p{Script=Cyrillic}/u.test(w) && /[A-Za-z]/.test(w)
      ? w.replace(/[A-Za-z]/g, (c) => LOOKALIKE[c] ?? c)
      : w,
  )
}

export function sentences(text: string): string[] {
  return (
    foldLookalikes(text)
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

const LABEL_SGAV = /\(\s*(?:с|спец\.?\s?)гав\s*\)/iu
const LABEL_GAV = /\(\s*гав\s*\)/iu

function termOf(s: string, dialect: Dialect): EmergencyKind | null {
  // an explicit label decides: "дію графіка аварійних відключень (СГАВ) скасовано" is СГАВ
  const sg = LABEL_SGAV.test(s)
  const g = LABEL_GAV.test(s)
  if (sg !== g) return sg ? 'sgav' : 'gav'
  // "ГАВ та СГАВ" in one sentence: ГАВ (СГАВ alone only when no plain ГАВ is named)
  if (SGAV.test(s)) return GAV.test(s.replace(SGAV_ALL, ' ')) ? 'gav' : 'sgav'
  if (GAV.test(s) || INSTEAD.test(s)) return 'gav'
  if (EXTRA.test(s)) return 'emergency'
  // "аварійні відключення" without a schedule named: not after damage ("внаслідок обстрілу …")
  if (!dialect.dtek && AVAR.test(s) && !DAMAGE.test(s)) return 'emergency'
  return null
}

/** "…, діють графіки погодинних відключень": the verb is about ГПВ, not the emergency */
const ABOUT_GPV = new RegExp(
  `${NOT_L}(?:діють|діє|діятимуть|застосован${L}*|застосову${L}*|запроваджен${L}*|введен${L}*|вводяться|продовжу${L}*\\s+діяти)\\s+(?:${L}+\\s+)?(?:граф${L}*\\s+)?(?:погодинн|гпв|стабілізаційн|підчерг)${L}*`,
  'giu',
)

/** The sentence without what doesn't happen: negated verbs, conditional or future cancels */
const unhedged = (s: string) => s.replace(NOT_A_CANCEL, ' ').replace(NEGATED, ' ')
/** …and without what is said about ГПВ ("діють графіки погодинних", "ГПВ скасовано") */
const asserted = (s: string) => unhedged(s).replace(GPV_CANCELLED, ' ').replace(ABOUT_GPV, ' ')

/** "може призвести до значних аварійних відключень": a possibility, not an announcement */
const MAYBE = new RegExp(`${NOT_L}(?:може|можуть|можливі|можливо|ймовірн${L}*|загроза|ризик)${END_L}`, 'iu')

/**
 * "можуть бути застосовані", "у разі перевищення … будуть застосовані", "Вчора застосовано",
 * "… не відповідає дійсності": nothing happening now. "Було застосовано" is the past, except
 * with a time of the last day ("о 07:35 … було застосовано ГАВ" is this episode). `s` is
 * without its purpose clause.
 */
function notNow(s: string, posted: Date): boolean {
  if (MAYBE.test(s) || NOT_NOW.test(s) || DENIAL.test(s)) return true
  if (!PAST.test(s)) return false
  const at = timeIn(s, posted)
  return !at || posted.getTime() - at.getTime() > 24 * 3600_000
}

/** It says what is not, may be, was or would be: no event, and no headline fallback either */
const hedged = (s: string, posted: Date) => {
  const core = withoutPurpose(s)
  return unhedged(core) !== core || notNow(core, posted)
}

/** A sentence that may announce something about this operator's region */
const candidate = (s: string, dialect: Dialect) =>
  !EXPLAINER.test(s) &&
  !/\?\s*$/.test(s) &&
  !aboutElsewhere(s, dialect.home) &&
  !(NATIONAL.test(s) && !dialect.home?.test(s) && !s.match(OBLASTS)) &&
  !DOCS.test(s)

function hitOf(s: string, index: number, dialect: Dialect, posted: Date): Hit | null {
  if (!candidate(s, dialect)) return null
  const core = withoutPurpose(s)
  if (notNow(core, posted)) return null
  const kind = termOf(core, dialect)
  const said = asserted(core)
  if (!kind) {
    // DTEK: "Київщина: повертаємось до графіків відключень" ends an emergency without naming it
    if (dialect.dtek && BACK_TO_SCHEDULES.test(said) && !/аварі/iu.test(s))
      return { sentence: s, index, kind: 'emergency', action: 'cancel' }
    return null
  }
  // tested before the ГПВ wording is stripped: that wording is what makes it a cancel
  const cancels = CANCEL.test(said) || INSTEAD.test(unhedged(core))
  const applies = APPLY.test(said)
  // both in one sentence: in force ("скасовано …, натомість застосовано ГАВ"); a false "cancelled"
  // is the worse mistake. "Замість аварійних діють графіки погодинних" is a cancel: the apply verb
  // there is about ГПВ and was stripped.
  if (cancels && !applies) return { sentence: s, index, kind, action: 'cancel' }
  if (applies) return { sentence: s, index, kind, action: 'apply' }
  if (BACK_TO_SCHEDULES.test(said)) return { sentence: s, index, kind, action: 'cancel' }
  return null
}

// --- time ---

const TIME_RES: RegExp[] = [
  // "22.01.2026 з 08 год. 24 хв."
  /(?<date>\d{2}\.\d{2}\.\d{4})\s+з\s+(?<h>\d{1,2})\s*год\.?\s*(?<m>\d{1,2})\s*хв/giu,
  /(?:^|[\s(])з\s+(?<h>\d{1,2})\s*год\.?\s*(?<m>\d{1,2})\s*хв/giu,
  // "з 10:35", "О 9:44", "об 11:12", "В 06:10", "у 19:00", "станом на 22:02", "з 18.00"
  /(?:^|[\s(])(?:з|о|об|в|у|станом\s+на|на)\s+(?<h>\d{1,2})(?<sep>[:.])(?<m>\d{2})(?![\d.]\d)/giu,
]

/** Words of the future: "будуть застосовуватися", "буде введено", "діятимуть" */
const FUTURE = new RegExp(`${NOT_L}(?:буде|будуть)${END_L}|${L}+тимуть${END_L}|${L}+тиметься${END_L}`, 'iu')

/** "YYYY-MM-DD" `days` later (earlier when negative) */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** "з 16.11" is a date, not 16:11: a valid day.month within a week of the post */
function looksLikeDate(h: number, m: number, posted: Date): boolean {
  if (m < 1 || m > 12 || h < 1 || h > 31) return false
  const y = Number(kyivDate(posted).slice(0, 4))
  return [y - 1, y, y + 1].some((yy) => {
    const t = Date.UTC(yy, m - 1, h)
    return new Date(t).getUTCDate() === h && Math.abs(t - posted.getTime()) <= 7 * 86400_000
  })
}

/**
 * The time named in `text` as an instant, read against the post time. Reports are about what
 * happened ("О 23:55 скасовано" posted at noon was last night); a time ahead is taken only for
 * the near future (3 h), or the day ahead when the verb is in the future tense.
 */
function timeIn(text: string, posted: Date): Date | null {
  for (const re of TIME_RES) {
    for (const m of text.matchAll(re)) {
      if (!m.groups) continue
      const h = Number(m.groups.h)
      const min = Number(m.groups.m)
      if (h > 23 || min > 59) continue
      // "з 16.11" (a date), but "з 18.00", "з 22.27" (times)
      if (m.groups.sep === '.' && looksLikeDate(h, min, posted)) continue
      let date = m.groups.date
        ? m.groups.date.split('.').reverse().join('-')
        : findUaDate(text.replace(/\d{1,2}\s*[:.]\s*\d{2}(?!\.\d)/g, ' '), posted)
      const explicit = !!date
      date ??= kyivDate(posted)
      let at = kyivInstant(date, h * 60 + min)
      if (!explicit) {
        const ahead = FUTURE.test(text) ? 20 * 3600_000 : 3 * 3600_000
        const diff = at.getTime() - posted.getTime()
        // the day before or after by the Kyiv calendar: around a DST switch a day isn't 24 h
        if (diff > ahead) at = kyivInstant(shiftDay(date, -1), h * 60 + min)
        else if (diff < ahead - 24 * 3600_000) at = kyivInstant(shiftDay(date, 1), h * 60 + min)
      }
      return at
    }
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
  const hits = all.map((s, i) => hitOf(s, i, dialect, posted)).filter((h): h is Hit => !!h)
  const update = all.some((s) => UPDATE.test(s))

  // the "UPD" line comes first; "UPD." may stand as a sentence of its own
  let first = upd ? hits.find((h) => h.index <= 1) : hits[0]
  if (upd && !first) first = hits[0]
  // "ГАВ: вимкнено 6 та 7 черги": the queues off now, as a change
  if (!first && !update) {
    const off = all.find(
      (x) =>
        candidate(x, dialect) &&
        termOf(withoutPurpose(x), dialect) &&
        !hedged(x, posted) &&
        /вимкнен|знеструмлен|відключен/iu.test(x),
    )
    const named = off ? extractQueues(off, null).list : null
    if (off && named) {
      const kind = termOf(off, dialect)!
      // "Зараз будуть знеструмлені 7, 8, 9, 10 черги по ГАВ. 5 та 6 черги залишаються відключені.
      // 1, 2, 3 та 4 черги скоро будуть заживлені.": the other lines say what else is off and on
      const swap = swapOf(all, null)
      const queues = sortQueues([...named, ...swap.off]).filter((q) => !swap.on.includes(q))
      return {
        ...base('update', kind, [off], text, posted, dialect, false),
        queues,
        restored: swap.on.length ? swap.on : null,
        count: queues.length,
      }
    }
  }
  if (!first && !update) {
    // the first sentence naming the schedule without saying what happened ("…на Житомирщині
    // аварійні знеструмлення."); one that negates or hedges ("ГАВ поки що не скасовано") says nothing
    // (named outside a purpose clause: "Економте, щоб уникнути застосування ГАВ" names nothing)
    const head = all.find(
      (x) => candidate(x, dialect) && termOf(withoutPurpose(x), dialect) && !hedged(x, posted),
    )
    if (!head) return null
    const kind = termOf(head, dialect)!
    // "аварійні знеструмлення. Графіки погодинних відключень наразі не діють": in force
    const action = SCHEDULE_OFF.test(text) ? 'apply' : 'unclear'
    if (action === 'unclear' && head !== all[0] && !termOf(all[0]!, dialect)) {
      // not the headline: an incidental mention ("Нагадуємо, що ГАВ …") is not news
      if (all.indexOf(head) > 2) return null
    }
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
    again: first.action === 'apply' && same.some((x) => AGAIN.test(x)),
    partial: first.action === 'cancel' && !q.all && (!!named || q.count !== null),
  }
  // "ГАВ скасовано частково: увімкнено 6-10 черги, 1-5 черги залишаються вимкненими": only 6-10
  if (announcement.action === 'cancel') {
    const { on } = swapOf(same, null)
    if (on.length) Object.assign(announcement, { queues: on, count: on.length, partial: true, all: false })
    else if (new RegExp(`${NOT_L}частково${END_L}`, 'iu').test(same.join(' ')) && !announcement.partial)
      // part of it, without saying which: still on (the TTL ends it)
      Object.assign(announcement, { partial: true, queues: null, count: null, all: false })
  }
  // "Наразі діє 10 черг ГАВ одночасно": the total after an addition
  const total = new RegExp(`наразі\\s+(?:діє|діють)\\s+(\\d{1,2})\\s+черг`, 'iu').exec(text)
  if (announcement.action === 'apply' && total) {
    announcement.add = false
    announcement.count = Number(total[1])
    if (named && named.length !== announcement.count) announcement.queues = null
  }
  // "Сумщині введені графіки аварійних відключень для 6-10 черг (1-5 ввімкнені)", "Відключаємо 1
  // та 2 черги ГАВ. Зможемо заживити 5 і 6 черги ГАВ.": those are back on
  if (announcement.action === 'apply' && !announcement.add) {
    const { on } = swapOf(all, null)
    if (on.length) {
      announcement.restored = on
      if (named) {
        announcement.queues = named.filter((n) => !on.includes(n))
        announcement.count = announcement.queues.length
      }
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
    again: false,
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

const ON_WORDS = new RegExp(`увімкн|ввімкн|вмика|віднов|зі\\s+світлом|зажив|поверта${L}*\\s+електро`, 'iu')
const OFF_WORDS = new RegExp(
  `вимкн|знеструмлю|знеструмлен|без\\s+(?:електро)?(?:постачання|світла)|відключ`,
  'iu',
)
const NUMS = String.raw`((?:\d{1,2}\s*(?:,|і|та|й)\s*)*\d{1,2})`
/** "замість 1 та 2 черг будуть знеструмлені 7 та 8": 1, 2 back on, 7, 8 off */
const INSTEAD_QUEUES = new RegExp(
  `замість\\s+${NUMS}\\s*(?:-?\\p{L}{1,3}\\s+)?черг${L}*\\s+(?:(?:буде|будуть|зараз)\\s+)*(?:знеструмл|вимкн|відключ|вимика)${L}*\\s+${NUMS}(?![\\d.])`,
  'giu',
)
const SCHEDULE_NAME = new RegExp(
  `граф${L}*\\s+(?:${L}+\\s+)?(?:відключ|вимкн|знеструм)${L}*|(?:аварійн|погодинн)${L}*\\s+(?:відключ|вимкн)${L}*`,
  'giu',
)
const numsOf = (s: string) =>
  s
    .split(/\D+/)
    .filter(Boolean)
    .map((n) => String(Number(n)))
const CLAUSE_BREAK = new RegExp(
  `[;\\n]|\\.\\s|,\\s+(?=(?:\\S+\\s+){0,3}?(?:вимкн|знеструм|вмика|увімкн|ввімкн|віднов|зажив|залиша))|натомість|\\(`,
  'iu',
)

/** Queues switched off and back on in a "заміна черг" / "зміни в ГАВ" post. */
function swapOf(parts: string[], fullVolume: number | null): { off: string[]; on: string[] } {
  const off = new Set<string>()
  const on = new Set<string>()
  const text = parts.join('\n').replace(INSTEAD_QUEUES, (_, back: string, now: string) => {
    for (const n of numsOf(back)) on.add(n)
    for (const n of numsOf(now)) off.add(n)
    return ' '
  })
  for (const clause of text.split(CLAUSE_BREAK)) {
    // "відновимо електропостачання 7,8,9,10 чергам графіку АВАРІЙНИХ відключень": the
    // schedule's name is no verb
    const said = clause.replace(SCHEDULE_NAME, ' ')
    const isOn = ON_WORDS.test(said)
    const isOff = OFF_WORDS.test(said.replace(new RegExp(ON_WORDS.source, 'giu'), ' '))
    if (isOn === isOff) continue
    // "♦️7,8 - залишаються відключеними": a list before a dash, without the word "черги";
    // "(1-5 ввімкнені)": a range
    const span = /^[^\p{L}\d]*(\d{1,2})\s*[-–—]\s*(\d{1,2})(?![\d.])\s+\p{L}/u.exec(clause)
    const bare = /^[^\p{L}\d]*((?:\d{1,2}\s*,\s*)*\d{1,2})\s*[-–—:]\s/u.exec(clause)?.[1]
    const q =
      extractQueues(clause, fullVolume).list ??
      (span ? range(Number(span[1]), Number(span[2])) : bare ? numsOf(bare) : null)
    for (const n of q ?? []) (isOn ? on : off).add(n)
  }
  for (const n of on) off.delete(n)
  return { off: sortQueues(off), on: sortQueues(on) }
}

// --- Ukrenergo ---

/**
 * A national @Ukrenergo post about one oblast (`oblast`: the stems of its names, e.g.
 * "Волинськ|Волин" for "Волинській області", "на Волині"): apply, cancel, or null when the post
 * doesn't name it. Ukrenergo names oblasts only sometimes ("у Харківській, Сумській та
 * Полтавській областях запроваджені аварійні відключення"), so this is a low-confidence hint;
 * "лише у Харківській області" ends it everywhere else.
 */
export function classifyUkrenergo(text: string, posted: Date, oblast: string): Announcement | null {
  const stem = new RegExp(`${NOT_L}(?:${oblast})`, 'u')
  for (const s of sentences(text)) {
    if (!AVAR.test(s) && !GAV.test(s)) continue
    const only = new RegExp(`продовжують\\s+діяти\\s+лише\\s+(?:у|в|на)\\s+([^.]*)`, 'iu').exec(s)
    if (only) {
      if (stem.test(only[1]!)) return ukr('apply', text, posted)
      return ukr('cancel', text, posted)
    }
    if (!stem.test(s)) continue
    // "можуть бути застосовані", "у разі …", "вчора": nothing in force now
    if (notNow(withoutPurpose(s), posted)) continue
    // past tense ("зранку застосовувалися") says nothing about now
    if (new RegExp(`застосовувал${L}*|діяли${END_L}`, 'iu').test(s)) continue
    const said = asserted(s)
    if (CANCEL.test(said)) return ukr('cancel', text, posted)
    if (APPLY.test(said) || /вимушен/iu.test(said)) return ukr('apply', text, posted)
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
    again: false,
    partial: false,
    scheduleApplies: scheduleAppliesOf(action, text),
    area: null,
    edited: false,
  }
}
