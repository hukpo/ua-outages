import { STANDARD_GROUPS } from '../schedule.js'
import type { RegionId } from '../types.js'
import type { PostRegion } from './types.js'

/**
 * What a processor is told about the regions a source covers. One channel is always described
 * the same way, whichever region asked: a post of @dtek_ua is analysed once for all five DTEK
 * regions, and that one answer is cached.
 */

const NAMES: Partial<Record<RegionId, string>> = {
  kyiv: 'м. Київ',
  'kyiv-region': 'Київська область',
  dnipro: 'Дніпропетровська область (ДТЕК Дніпровські електромережі)',
  'dnipro-cek': 'Дніпропетровська область (ЦЕК: Дніпро, Павлоград, Вільногірськ та ін.)',
  odesa: 'Одеська область',
  donetsk: 'Донецька область',
  zaporizhzhia: 'Запорізька область',
  kharkiv: 'Харківська область',
  lviv: 'Львівська область',
  'ivano-frankivsk': 'Івано-Франківська область',
  ternopil: 'Тернопільська область',
  khmelnytskyi: 'Хмельницька область',
  chernihiv: 'Чернігівська область',
  zhytomyr: 'Житомирська область',
  cherkasy: 'Черкаська область',
  kirovohrad: 'Кіровоградська область',
  sumy: 'Сумська область',
  poltava: 'Полтавська область',
  mykolaiv: 'Миколаївська область',
  chernivtsi: 'Чернівецька область',
  zakarpattia: 'Закарпатська область',
  volyn: 'Волинська область',
  rivne: 'Рівненська область',
}

/** Chernivtsi numbers its queues 1–12 without subqueues */
const QUEUES: Partial<Record<RegionId, readonly string[]>> = {
  chernivtsi: Array.from({ length: 12 }, (_, i) => String(i + 1)),
}

const TEN = Array.from({ length: 10 }, (_, i) => String(i + 1))
/** Operators whose ГАВ has a fixed set of ten queues ("в повному обсязі" = all ten) */
const TEN_QUEUE_GAV = new Set<RegionId>([
  'zaporizhzhia',
  'kharkiv',
  'lviv',
  'ivano-frankivsk',
  'ternopil',
  'khmelnytskyi',
  'chernihiv',
  'zhytomyr',
  'cherkasy',
  'kirovohrad',
  'sumy',
  'poltava',
  'mykolaiv',
  'chernivtsi',
])

export function postRegion(id: RegionId): PostRegion {
  return {
    id,
    name: NAMES[id] ?? id,
    queues: QUEUES[id] ?? STANDARD_GROUPS,
    emergencyQueues: TEN_QUEUE_GAV.has(id) ? TEN : [],
  }
}

/** Telegram channels and the regions each one's posts may be about */
export const CHANNEL_REGIONS: Record<string, readonly RegionId[]> = {
  dtek_ua: ['kyiv', 'kyiv-region', 'dnipro', 'odesa', 'donetsk'],
  // national posts, read only for regions whose operator announces nothing itself
  Ukrenergo: ['chernivtsi', 'zakarpattia', 'volyn', 'rivne'],
  cek_info: ['dnipro-cek'],
  Zaporizhzhyaoblenergo_news: ['zaporizhzhia'],
  kharkivenergy: ['kharkiv'],
  lvivoblenergo: ['lviv'],
  prykarpattyaoblenergo_official: ['ivano-frankivsk'],
  ternopiloblenerho: ['ternopil'],
  khmelnytskoblenergo: ['khmelnytskyi'],
  chernigivoblenergo: ['chernihiv'],
  ztoe_ua: ['zhytomyr'],
  pat_cherkasyoblenergo: ['cherkasy'],
  SvitloKropyvnytskyiMisto: ['kirovohrad'],
  SvitloHolovanivskohoRayonu: ['kirovohrad'],
  SumyEnergo: ['sumy'],
  poltavaOE: ['poltava'],
  mk_energy_ua: ['mykolaiv'],
  oe_cv_ua: ['chernivtsi'],
  zakarpatenergyofficial: ['zakarpattia'],
}

/** The regions a channel's posts are analysed for: its registered ones, else the asking region */
export function channelRegions(channel: string, asking: RegionId): PostRegion[] {
  return (CHANNEL_REGIONS[channel] ?? [asking]).map(postRegion)
}

/** What each region's schedule is read with (`RegionInfo.capabilities.requires`) */
export const SCHEDULE_REQUIRES: Partial<Record<RegionId, ('textProcessor' | 'imageProcessor')[]>> = {
  zaporizhzhia: ['textProcessor'],
  kharkiv: ['textProcessor'],
  cherkasy: ['textProcessor'],
  khmelnytskyi: ['textProcessor', 'imageProcessor'],
  'dnipro-cek': ['textProcessor'],
  kirovohrad: ['textProcessor'],
  chernivtsi: ['textProcessor'],
  chernihiv: ['textProcessor', 'imageProcessor'],
  zakarpattia: ['textProcessor', 'imageProcessor'],
  volyn: ['imageProcessor'],
}
