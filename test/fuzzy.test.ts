import { describe, expect, it } from 'vitest'
import { editDistance, fuzzyScore, rankByName, searchFragments, wordScore } from '../src/fuzzy.js'
import { fixture } from './helpers.js'

// 736 real streets of Mykolaiv
const streets: string[] = JSON.parse(fixture('mykolaiv/addr-ns-171-street.json')).map(
  (s: { nazstreet: string }) => s.nazstreet.trim(),
)
const top = (q: string, n = 2) => rankByName(q, streets, (s) => s, 'street', { limit: n }).map((r) => r.item)

describe('street search the way people type', () => {
  it.each([
    ['Адміральська', 'вул. Адміральська'], // exact, no type
    ['Адмиральская', 'вул. Адміральська'], // Russian spelling
    ['морская', 'вул. Морська'],
    ['космонавтов', 'вул. Космонавтів'],
    ['Собрна', 'вул. Соборна'], // missing letter
    ['Шевченко', 'вул. Шевченка'], // wrong ending
    ['Тараса Шевченка', 'вул. Шевченка'], // first name the directory omits
    ['Шевч', 'вул. Шевченка'], // still typing
    ['Центральний проспект', 'пр. Центральний'], // type after the name
    ['Херсонська', 'Херсонське шосе'],
    ['Велика Морська', 'вул. Велика Морська'],
  ])('%s → %s', (query, want) => {
    expect(top(query, 4)).toContain(want)
  })

  it('puts the street type the user named first', () => {
    expect(top('площа Соборна')[0]).toBe('пл. Соборна')
    expect(top('вулиця Соборна')[0]).toBe('вул. Соборна')
  })

  it('ranks the exact name above longer names that contain it', () => {
    const r = rankByName('Велика Морська', streets, (s) => s, 'street')
    expect(r[0]!.item).toBe('вул. Велика Морська')
    expect(r[0]!.score).toBe(1)
    expect(r[1]!.score).toBeLessThan(0.95)
  })

  it('does not invent matches from initials or unrelated words', () => {
    expect(top('соборная').every((s) => s.includes('Соборна'))).toBe(true)
    expect(top('Генерала Карпенка')).toEqual([]) // renamed, not in the directory
  })

  it('treats a reordered name as close but not exact', () => {
    expect(fuzzyScore('просп. Дмитра Яворницького', 'просп. Дмитра Яворницького')).toBe(1)
    const swapped = fuzzyScore('просп. Дмитра Яворницького', 'просп. Яворницького Дмитра')
    expect(swapped).toBeGreaterThan(0.9)
    expect(swapped).toBeLessThan(1)
  })

  it('matches settlements without their type', () => {
    expect(fuzzyScore('Дніпро', 'м. Дніпро', 'settlement')).toBe(1)
    expect(fuzzyScore('Днипро', 'м. Дніпро', 'settlement')).toBe(1) // и for і folds
    expect(fuzzyScore('Дніпро', 'с. Дніпровське', 'settlement')).toBeLessThan(1)
  })
})

describe('building blocks', () => {
  it('counts typos with swaps', () => {
    expect(editDistance('соборна', 'соброна')).toBe(1)
    expect(editDistance('хрещатик', 'хрищатик')).toBe(1)
    expect(editDistance('abc', 'xyz', 1)).toBe(2) // capped
  })

  it('scores words', () => {
    expect(wordScore('хрещ', 'хрещатик')).toBeGreaterThan(0.9)
    expect(wordScore('б', 'богдана')).toBeLessThan(0.7)
    expect(wordScore('кот', 'кит')).toBe(0) // too short to allow a typo
  })

  it('splits a long word into fragments for substring servers', () => {
    expect(searchFragments('вул. Хрищатик', 'street')).toEqual(
      ['Хри', 'щат', 'тик'].map((s) => s.toLowerCase()),
    )
    expect(searchFragments('Миру', 'street')).toEqual([])
  })
})
