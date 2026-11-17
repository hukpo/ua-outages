import { describe, expect, it } from 'vitest'
import {
  classifyPost,
  classifyUkrenergo,
  extractQueues,
  sentences,
  type Announcement,
  type Dialect,
} from '../../src/emergency/classify.js'
import { fixture } from '../helpers.js'

/** Verbatim posts from the operators' channels (research/<region>/gav). */
const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts

const OBLENERGO = (home: RegExp): Dialect => ({ fullVolume: 10, home })
const DTEK: Dialect = { dtek: true }

function read(id: string, dialect: Dialect = { fullVolume: 10 }): Announcement | null {
  const p = POSTS[id]
  if (!p) throw new Error(`no post ${id} in the fixture`)
  return classifyPost(p.text, new Date(p.at), dialect)
}

describe('classifyPost: apply', () => {
  it('Poltava: the time and queues from the text ("О 9:44 … ввести ГАВ (1-5 черга)")', () => {
    expect(read('poltavaOE/4504')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      at: '2026-11-09T09:44:00+02:00',
      timed: true,
      queues: ['1', '2', '3', '4', '5'],
      count: 5,
      add: false,
    })
  })

  it('Poltava: "в повному обсязі" is all ten queues', () => {
    expect(read('poltavaOE/4446')).toMatchObject({
      action: 'apply',
      at: '2026-11-02T07:34:00+02:00',
      all: true,
      count: 10,
      queues: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    })
  })

  it('Poltava: "ввести ГАВ додатково 5 черг" adds a count', () => {
    expect(read('poltavaOE/4498')).toMatchObject({ action: 'apply', add: true, count: 5, queues: null })
  })

  it('Sumy: a range in the long form', () => {
    expect(read('SumyEnergo/3813')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      at: '2026-11-02T07:35:00+02:00',
      queues: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    })
  })

  it('Sumy: "для 6-10 черг споживачів (1-5 ввімкнені)" — the rest is on', () => {
    expect(read('SumyEnergo/3848')).toMatchObject({
      action: 'apply',
      queues: ['6', '7', '8', '9', '10'],
      count: 5,
    })
  })

  it('Sumy: "О 10:28 додатково введено ГАВ для 6-10 черг"', () => {
    expect(read('SumyEnergo/3876')).toMatchObject({
      action: 'apply',
      add: true,
      at: '2026-11-09T10:28:00+02:00',
      queues: ['6', '7', '8', '9', '10'],
    })
  })

  it('Sumy: "в обсязі однієї черги" without a time: the post time', () => {
    const p = POSTS['SumyEnergo/3829']!
    expect(read('SumyEnergo/3829')).toMatchObject({ action: 'apply', count: 1, queues: null, timed: false })
    expect(Date.parse(read('SumyEnergo/3829')!.at)).toBe(Date.parse(p.at))
  })

  it('Sumy: СГАВ "у повному обсязі" names no number of queues', () => {
    expect(read('SumyEnergo/3669')).toMatchObject({ action: 'apply', kind: 'sgav', all: true, queues: null })
  })

  it('Ivano-Frankivsk: "з 18:30 введені дві черги ГАВ – пʼята та шоста"', () => {
    expect(read('prykarpattyaoblenergo_official/3078')).toMatchObject({
      action: 'apply',
      at: '2025-10-16T18:30:00+03:00',
      queues: ['5', '6'],
      count: 2,
    })
  })

  it('Ivano-Frankivsk: "до окремої вказівки про скасування" is not a cancellation', () => {
    expect(read('prykarpattyaoblenergo_official/3081')).toMatchObject({ action: 'apply', add: true })
  })

  it('Kirovohrad: "з 08 год. 24 хв." with the date of the text', () => {
    expect(read('SvitloKropyvnytskyiMisto/1325')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      at: '2026-01-22T08:24:00+02:00',
      timed: true,
    })
    expect(read('SvitloKropyvnytskyiMisto/1327')).toMatchObject({ action: 'apply', kind: 'sgav' })
  })

  it('Kirovohrad: the short form "В 06:10 застосовано СГАВ 1, 2 чергу"', () => {
    expect(read('SvitloKropyvnytskyiMisto/1758')).toMatchObject({
      action: 'apply',
      kind: 'sgav',
      at: '2026-11-07T06:10:00+02:00',
      queues: ['1', '2'],
    })
  })

  it('Kirovohrad: ГОП "в обсязі 1, 2, 3, 4, 5 черг" is not ГАВ', () => {
    expect(read('SvitloKropyvnytskyiMisto/1748')).toBeNull()
  })

  it('Ternopil: "з 18.00" with a dot, and "додатково введена ще одна черга"', () => {
    expect(read('ternopiloblenerho/1140')).toMatchObject({
      action: 'apply',
      at: '2025-10-15T18:00:00+03:00',
      count: 2,
    })
    expect(read('ternopiloblenerho/1147')).toMatchObject({ action: 'apply', add: true, count: 1 })
  })

  it('Cherkasy: "5 листопада з 10:35"; ГПВ continues', () => {
    expect(read('pat_cherkasyoblenergo/1961')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      at: '2026-11-05T10:35:00+02:00',
      scheduleApplies: true,
    })
  })

  it('Cherkasy: ГАВ and СГАВ in one sentence count as ГАВ', () => {
    expect(read('pat_cherkasyoblenergo/1319')).toMatchObject({ action: 'apply', kind: 'gav', all: true })
  })

  it('Chernihiv: a count, a district, СГАВ', () => {
    expect(read('chernigivoblenergo/5643')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      count: 10,
      queues: null,
    })
    expect(read('chernigivoblenergo/5633')).toMatchObject({
      count: 10,
      area: 'Ніжинському і Прилуцькому районах',
    })
    expect(read('chernigivoblenergo/5646')).toMatchObject({ action: 'apply', kind: 'sgav', count: 3 })
  })

  it('Chernihiv: "додатково … ще 5 черг … Наразі діє 10 черг ГАВ одночасно" is the total', () => {
    expect(read('chernigivoblenergo/4930')).toMatchObject({ action: 'apply', add: false, count: 10 })
  })

  it('Kharkiv: ГАВ alongside ГПВ ("Одночасно продовжують діяти графіки погодинних відключень")', () => {
    expect(read('kharkivenergy/2196')).toMatchObject({ action: 'apply', kind: 'gav', scheduleApplies: true })
    expect(read('kharkivenergy/2325')).toMatchObject({ action: 'apply', kind: 'emergency' })
  })

  it('Khmelnytskyi: "окрім графіка погодинних відключень, додатково запроваджено графік аварійних"', () => {
    expect(read('khmelnytskoblenergo/1059')).toMatchObject({
      action: 'apply',
      kind: 'gav',
      scheduleApplies: true,
    })
    expect(read('khmelnytskoblenergo/1081')).toMatchObject({ action: 'apply', kind: 'sgav' })
  })

  it('Lviv: a count in words and an area', () => {
    expect(read('lvivoblenergo/2719')).toMatchObject({ action: 'apply', count: 10 })
    expect(read('lvivoblenergo/2831')).toMatchObject({
      action: 'apply',
      count: 10,
      area: 'північних районах Львівщини',
    })
  })

  it('Zhytomyr: "аварійні відключення електроенергії (ГАВ)" is ГАВ', () => {
    expect(read('ztoe_ua/1881', OBLENERGO(/Житомир/u))).toMatchObject({ action: 'apply', kind: 'gav' })
  })

  it('ЦЕК: ГАВ vs СГАВ vs unnamed "ЕКСТРЕНІ ВІДКЛЮЧЕННЯ"; ГПВ suspended', () => {
    expect(read('cek_info/4315', {})).toMatchObject({
      action: 'apply',
      kind: 'emergency',
      scheduleApplies: false,
    })
    expect(read('cek_info/4340', {})).toMatchObject({ action: 'apply', kind: 'sgav' })
    // "ЕКСТРЕНІ ВІДКЛЮЧЕННЯ тривають … ГАВ та СГАВ введенні в повному обсязі"
    expect(read('cek_info/4341', {})).toMatchObject({ action: 'apply', kind: 'gav', all: true, queues: null })
  })

  it('DTEK: "екстрені відключення" with the area in the prefix', () => {
    expect(read('dtek_ua/4575', DTEK)).toMatchObject({
      action: 'apply',
      kind: 'emergency',
      scheduleApplies: false,
    })
    // (the post as it was first: it now ends with "UPD: екстрені відключення скасовані")
    const before = POSTS['dtek_ua/4684']!.text.replace(/\s*UPD:[^\n]*$/u, '')
    expect(classifyPost(before, new Date(POSTS['dtek_ua/4684']!.at), DTEK)).toMatchObject({
      action: 'apply',
      area: 'частині Голосієвського та Соломянського районів',
    })
    // …and as it is: the edit under the text cancels what the text applied, there
    expect(read('dtek_ua/4684', DTEK)).toMatchObject({
      action: 'cancel',
      edited: true,
      area: 'частині Голосієвського та Соломянського районів',
    })
    // "тривають" restates; "Поки що скасувати … не вдається" is no cancel
    expect(read('dtek_ua/4767', DTEK)).toMatchObject({ action: 'apply' })
  })
})

describe('classifyPost: cancel', () => {
  it('Poltava: all, and only some queues', () => {
    expect(read('poltavaOE/4456')).toMatchObject({
      action: 'cancel',
      at: '2026-11-02T14:05:00+02:00',
      partial: false,
    })
    expect(read('poltavaOE/4447')).toMatchObject({
      action: 'cancel',
      at: '2026-11-02T07:53:00+02:00',
      partial: true,
      queues: ['6', '7', '8', '9', '10'],
    })
    // "О 9:58 отримана команда НЕК "Укренерго" скасувати ГАВ"
    expect(read('poltavaOE/4450')).toMatchObject({
      action: 'cancel',
      partial: false,
      at: '2026-11-02T09:58:00+02:00',
    })
  })

  it('Kharkiv: "Аварійні обмеження електропостачання скасовані! Продовжують діяти графіки погодинних"', () => {
    expect(read('kharkivenergy/2326')).toMatchObject({
      action: 'cancel',
      kind: 'emergency',
      scheduleApplies: true,
    })
  })

  it('Chernihiv: matched on the schedule name despite the typo "Чернгівщині"', () => {
    expect(read('chernigivoblenergo/5583', OBLENERGO(/Черніг|Чернг/u))).toMatchObject({
      action: 'cancel',
      kind: 'gav',
    })
  })

  it('Kirovohrad: ГАВ and СГАВ cancels, also "з 21год. 16 хв."', () => {
    expect(read('SvitloKropyvnytskyiMisto/1333')).toMatchObject({
      action: 'cancel',
      kind: 'gav',
      at: '2026-01-23T00:55:00+02:00',
    })
    expect(read('SvitloKropyvnytskyiMisto/1328')).toMatchObject({ action: 'cancel', kind: 'sgav' })
    expect(read('SvitloKropyvnytskyiMisto/1406')).toMatchObject({
      action: 'cancel',
      at: '2026-02-08T21:16:00+02:00',
    })
    expect(read('SvitloKropyvnytskyiMisto/1760')).toMatchObject({
      action: 'cancel',
      kind: 'sgav',
      queues: ['1', '2'],
      partial: true,
    })
  })

  it('Ternopil: "з 22.27 … скасовано графіки аварійних відключень (ГАВ)"', () => {
    expect(read('ternopiloblenerho/1141')).toMatchObject({
      action: 'cancel',
      at: '2025-10-15T22:27:00+03:00',
    })
  })

  it('Ivano-Frankivsk: "станом на 22:02 деактивовані всі черги ГАВ"; "замість графіків аварійних … ГПВ"', () => {
    expect(read('prykarpattyaoblenergo_official/3091')).toMatchObject({
      action: 'cancel',
      at: '2025-10-16T22:02:00+03:00',
      partial: false,
    })
    expect(read('prykarpattyaoblenergo_official/3187')).toMatchObject({
      action: 'cancel',
      scheduleApplies: true,
    })
  })

  it('an edited post: "UPD … скасовані" on top of the apply text', () => {
    expect(read('lvivoblenergo/2881')).toMatchObject({
      action: 'cancel',
      kind: 'gav',
      edited: true,
      timed: false,
    })
    // "UPD. … замість аварійних діють графіки погодинних відключень."
    expect(read('lvivoblenergo/2772')).toMatchObject({
      action: 'cancel',
      edited: true,
      scheduleApplies: true,
    })
    expect(read('ztoe_ua/1814', OBLENERGO(/Житомир/u))).toMatchObject({
      action: 'cancel',
      kind: 'emergency',
      edited: true,
    })
  })

  it('ЦЕК: the cancel, with ГПВ subqueues that are not ГАВ queues', () => {
    expect(read('cek_info/4316', {})).toMatchObject({ action: 'cancel', scheduleApplies: true })
    expect(read('cek_info/4374', {})).toMatchObject({ action: 'cancel', partial: false, queues: null })
  })

  it('DTEK: "повертаємось до графіків" with and without naming the emergency', () => {
    expect(read('dtek_ua/4576', DTEK)).toMatchObject({ action: 'cancel', kind: 'emergency' })
    expect(read('dtek_ua/4678', DTEK)).toMatchObject({ action: 'cancel', kind: 'emergency' })
  })
})

describe('classifyPost: update', () => {
  it('Sumy: "заміна черг за ГАВ (знеструмлюються 6-10 черги, вмикаються 1-5 черги)"', () => {
    expect(read('SumyEnergo/3921')).toMatchObject({
      action: 'update',
      at: '2026-11-15T19:00:00+02:00',
      queues: ['6', '7', '8', '9', '10'],
      restored: ['1', '2', '3', '4', '5'],
    })
  })

  it('Ivano-Frankivsk: "вимкнені черги 3 і 4. Натомість черги 1 і 2 знову зі світлом"', () => {
    expect(read('prykarpattyaoblenergo_official/3074')).toMatchObject({
      action: 'update',
      at: '2025-10-15T20:00:00+03:00',
      queues: ['3', '4'],
      restored: ['1', '2'],
    })
    expect(read('prykarpattyaoblenergo_official/3089')).toMatchObject({
      action: 'update',
      queues: ['3', '4'],
      restored: ['1', '10'],
    })
  })
})

describe('classifyPost: not an announcement', () => {
  it('DTEK "аварійні" is local damage, not ГАВ', () => {
    const odesa = 'Одещина: через атаку на обʼєкти енергетики фіксуються аварійні відключення'
    expect(classifyPost(odesa, new Date(), DTEK)).toBeNull()
    expect(read('dtek_ua/4668', DTEK)).toBeNull()
    expect(read('dtek_ua/4717', DTEK)).toBeNull()
  })

  it('explanations and questions', () => {
    expect(read('SumyEnergo/3658')).toBeNull()
    expect(read('dtek_ua/4775', DTEK)).toBeNull()
    // "Чому аварійні відключення скасовують і невдовзі вводять знову"
    expect(read('pat_cherkasyoblenergo/1962')).toBeNull()
  })

  it('a warning of possible damage', () => {
    expect(read('oe_cv_ua/3940')).toBeNull()
  })

  it('a national summary reposted by an operator', () => {
    const text =
      'Найскладніша ситуація з електропостачанням - на Дніпровщині та Київщині. У звʼязку з цим застосовуються аварійні відключення.'
    expect(classifyPost(text, new Date(), OBLENERGO(/Житомир/u))).toBeNull()
  })
})

describe('Ukrenergo, per oblast', () => {
  const ukr = (id: string, stem: string) => {
    const p = POSTS[id]!
    return classifyUkrenergo(p.text, new Date(p.at), stem)
  }

  it('applies when the oblast is named', () => {
    expect(ukr('Ukrenergo/5623', 'Полтавськ')).toMatchObject({
      action: 'apply',
      kind: 'emergency',
      scheduleApplies: false,
    })
    expect(ukr('Ukrenergo/5611', 'Черкаськ')).toMatchObject({ action: 'apply' })
    expect(ukr('Ukrenergo/5611', 'Волинськ')).toBeNull()
  })

  it('"продовжують діяти лише у Харківській області" ends it elsewhere', () => {
    expect(ukr('Ukrenergo/5608', 'Волинськ')).toMatchObject({ action: 'cancel' })
    expect(ukr('Ukrenergo/5608', 'Харківськ')).toMatchObject({ action: 'apply' })
  })

  it('ignores the past tense and posts that name no region', () => {
    expect(ukr('Ukrenergo/5631', 'Харківськ')).toBeNull()
    expect(ukr('Ukrenergo/5603', 'Волинськ')).toBeNull()
  })
})

describe('queue extraction', () => {
  it('reads ranges, lists, counts and words', () => {
    expect(extractQueues('ввести ГАВ (6-10 черга)').list).toEqual(['6', '7', '8', '9', '10'])
    expect(extractQueues('скасовано 5 черг ГАВ (з 6 по 10)')).toMatchObject({
      list: ['6', '7', '8', '9', '10'],
      count: 5,
    })
    expect(extractQueues('вимкнені черги 3 і 4').list).toEqual(['3', '4'])
    expect(extractQueues('відключили 1,2,3 та 4 черги ГАВ').list).toEqual(['1', '2', '3', '4'])
    expect(extractQueues('діють також 5 черг графіків аварійних вимкнень (5,6,7,8,9)').list).toEqual([
      '5',
      '6',
      '7',
      '8',
      '9',
    ])
    expect(extractQueues('застосовано 10 черг')).toEqual({ list: null, count: 10, all: false })
    expect(extractQueues('введені десять черг').count).toBe(10)
    expect(extractQueues('в повному обсязі', 10).list).toHaveLength(10)
    expect(extractQueues('в повному обсязі')).toEqual({ list: null, count: null, all: true })
  })

  it('ignores times, dates and ГПВ subqueues', () => {
    expect(extractQueues('22.01.2026 з 08 год. 24 хв. введено ГАВ').list).toBeNull()
    expect(extractQueues('до 22:00 відключаються черги: 1.1, 1.2, 5.1').list).toBeNull()
  })
})

describe('sentences', () => {
  it('keeps abbreviations and soft line breaks inside a sentence', () => {
    expect(sentences('Шановні споживачі м. ДНІПРО‼️\n\nЗастосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ')).toEqual([
      'Шановні споживачі м. ДНІПРО',
      'Застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ',
    ])
    expect(sentences('введено Спеціальні\nграфіки аварійних відключень')).toHaveLength(1)
    expect(sentences('з 21год. 16 хв. скасовано')).toHaveLength(1)
  })
})

describe('classifyPost: time and spelling', () => {
  const KIRO = OBLENERGO(/Кіровоград|Кропивни/u)

  it('Kirovohrad: "у 19:00 скасовано СГАВ" ends at 19:00, not at the post time', () => {
    const a = classifyPost(
      '16.11.26 у 19:00 скасовано СГАВ (спеціальний графік аварійних відключень).',
      new Date('2026-11-16T17:02:22Z'),
      KIRO,
    )
    expect(a).toMatchObject({ action: 'cancel', kind: 'sgav', at: '2026-11-16T19:00:00+02:00', timed: true })
  })

  it('Latin lookalikes inside a Cyrillic word still read as ГАВ ("гaв", "CГАВ")', () => {
    const at = new Date('2026-11-16T08:00:00Z')
    expect(classifyPost('О 09:50 застосовано гaв для 1-3 черг', at, KIRO)).toMatchObject({
      action: 'apply',
      kind: 'gav',
      queues: ['1', '2', '3'],
    })
    expect(classifyPost('О 09:50 скасовано CГАВ', at, KIRO)).toMatchObject({ action: 'cancel', kind: 'sgav' })
  })
})
