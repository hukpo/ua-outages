import { describe, expect, it } from 'vitest'
import type { Analyzed } from '../../src/ai/posts.js'
import { OutageError } from '../../src/errors.js'
import {
  assembleDays,
  layerPublications,
  type DatedPublication,
  type Publication,
  type UnreadItem,
} from '../../src/providers/posts.js'
import type { MinuteSlot } from '../../src/schedule.js'

/**
 * Properties of putting posts together, checked on random sequences: a minute-by-minute model of
 * what the publications say against `layerPublications`, and what an unread post must flag.
 */

/** A small seeded generator: the same sequences on every run */
function rng(seed: number) {
  let s = seed >>> 0
  const next = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
  }
}

const GROUPS = ['1.1', '1.2', '2.1']
type Minutes = boolean[] | null

const slotsOf = (r: ReturnType<typeof rng>): MinuteSlot[] => {
  const out: MinuteSlot[] = []
  let t = r.int(6) * 60
  while (t < 1440 && out.length < 3) {
    const start = t + r.int(8) * 30
    const end = Math.min(1440, start + 30 + r.int(6) * 30)
    if (start >= end) break
    out.push({ start, end, kind: 'off' })
    t = end + 30
  }
  return out
}

type Kind = 'whole' | 'window' | 'rest' | 'add' | 'cancel'

/** A random publication and what it is, as generated (not as the code under test decides) */
function randomKindPub(r: ReturnType<typeof rng>): { kind: Kind; pub: Publication } {
  const kind = r.pick(['whole', 'whole', 'window', 'rest', 'add', 'cancel'] as const)
  if (kind === 'cancel') return { kind, pub: { groups: {}, from: 0, cancelled: true } }
  const groups: Record<string, MinuteSlot[] | null> = {}
  for (const g of GROUPS) if (r.next() < 0.8) groups[g] = r.next() < 0.1 ? null : slotsOf(r)
  if (kind === 'whole') return { kind, pub: { groups, from: 0 } }
  if (kind === 'add') return { kind, pub: { groups, from: 0, add: true } }
  const from = (1 + r.int(20)) * 60
  if (kind === 'rest') return { kind, pub: { groups, from } }
  return { kind, pub: { groups, from, to: Math.min(1440, from + (1 + r.int(8)) * 60) } }
}
const randomPub = (r: ReturnType<typeof rng>) => randomKindPub(r).pub

const toMinutes = (slots: MinuteSlot[]): boolean[] => {
  const m = Array<boolean>(1440).fill(false)
  for (const s of slots) for (let i = s.start; i < s.end; i++) m[i] = true
  return m
}

/** What the publications say, minute by minute, as `layerPublications` documents it */
function model(pubs: readonly Publication[], omitted: 'unknown' | 'none') {
  let cur: Record<string, Minutes> = {}
  let cancelled = false
  let based = false
  for (const pub of pubs) {
    if (pub.cancelled) {
      cur = {}
      cancelled = true
      continue
    }
    const listed = Object.keys(pub.groups)
    if (pub.add) {
      if (cancelled) continue
      for (const g of listed) {
        const prev = cur[g]
        const slots = pub.groups[g]
        cur[g] =
          slots === null || prev === null || !based || (prev === undefined && omitted !== 'none')
            ? null
            : (prev ?? Array<boolean>(1440).fill(false)).map((v, i) => v || toMinutes(slots!)[i]!)
      }
      continue
    }
    const to = pub.to ?? 1440
    if (!pub.add && pub.from <= 0 && (pub.to ?? 1440) >= 1440) {
      cur = Object.fromEntries(
        listed.map((g) => [g, pub.groups[g] === null ? null : toMinutes(pub.groups[g]!)]),
      )
      cancelled = false
      based = true
      continue
    }
    if (!based || cancelled) {
      cur = Object.fromEntries([...new Set([...Object.keys(cur), ...listed])].map((g) => [g, null]))
      cancelled = false
      based = false
      continue
    }
    const next: Record<string, Minutes> = {}
    for (const g of new Set([...Object.keys(cur), ...listed])) {
      const prev = cur[g]
      const now = pub.groups[g]
      const outside = (m: boolean[]) => m.map((v, i) => v && (i < pub.from || i >= to))
      if (now === null) next[g] = null
      else if (now) {
        if (prev === null || (prev === undefined && omitted !== 'none')) next[g] = null
        else {
          // the window's slots, an outage in progress kept from its start, cut at the window's end
          const inside = toMinutes(
            now
              .filter((s) => s.end > pub.from && s.start < to)
              .map((s) => ({ ...s, end: Math.min(s.end, to) })),
          )
          next[g] = outside(prev ?? Array<boolean>(1440).fill(false)).map((v, i) => v || inside[i]!)
        }
      } else if (prev !== undefined)
        next[g] =
          prev &&
          (omitted === 'none' || !prev.some((v, i) => v && i >= pub.from && i < to) ? outside(prev) : null)
    }
    cur = next
  }
  return { cur, cancelled, based }
}

describe('layering, on random sequences of publications', () => {
  it('matches the minute-by-minute model, invents no outage, keeps slots in the day, and is whole or not known', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed)
      const pubs = Array.from({ length: 1 + r.int(5) }, () => randomPub(r))
      const omitted = r.pick(['unknown', 'none'] as const)
      const got = layerPublications(pubs, omitted)
      const want = model(pubs, omitted)
      const label = `seed ${seed}: ${JSON.stringify(pubs)} (${omitted})`
      expect(got.based, label).toBe(want.based)
      expect(got.cancelled, label).toBe(want.cancelled)
      expect(Object.keys(got.groups).sort(), label).toEqual(Object.keys(want.cur).sort())
      for (const [g, slots] of Object.entries(got.groups)) {
        if (slots === null) {
          expect(want.cur[g], `${label} ${g}`).toBeNull()
          continue
        }
        for (const s of slots) {
          expect(s.start >= 0 && s.end <= 1440 && s.start < s.end, `${label} ${g}`).toBe(true)
        }
        expect(toMinutes(slots), `${label} ${g}`).toEqual(want.cur[g])
        // no outage that no publication had for the group
        const said = pubs.flatMap((p) => p.groups[g] ?? [])
        const anywhere = toMinutes(said)
        expect(
          toMinutes(slots).every((v, i) => !v || anywhere[i]),
          `${label} ${g}`,
        ).toBe(true)
      }
      // a day no whole publication is under shows nothing as known
      if (!got.based)
        expect(
          Object.values(got.groups).every((v) => v === null),
          label,
        ).toBe(true)
    }
  })
})

describe('an unread post, on random sequences of posts', () => {
  it('flags every day today on that it may be about until a newer whole publication of that day, and no other', () => {
    const now = new Date('2026-11-18T12:00:00+02:00')
    const days = ['2026-11-17', '2026-11-18', '2026-11-19']
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed)
      // a page without times (newest first, the order is all there is), or a channel whose posts
      // may share a second (the message id orders them then)
      const timeless = r.next() < 0.3
      const n = 2 + r.int(6)
      const analyzed: Analyzed[] = []
      const pubs: DatedPublication[] = []
      const kinds: Kind[] = []
      const items: UnreadItem[] = []
      const times: number[] = []
      let t = Date.parse('2026-11-17T18:00:00+02:00')
      for (let i = 0; i < n; i++) {
        if (r.next() < 0.6) t += 3600_000 // otherwise: the same second as the post before
        times.push(t)
        const publishedAt = new Date(t).toISOString()
        const url = `https://t.me/x/${i + 1}`
        const unread = r.next() < 0.3
        analyzed.push({
          input: { url, publishedAt, source: { kind: 'telegram', channel: 'x' } } as never,
          analysis: unread ? null : ({ events: [], photosAreSchedules: false, statedAt: null } as never),
          error: unread ? new OutageError('parse', `misread ${i}`, { url }) : null,
        })
        if (unread)
          items.push({
            post: i,
            days: [r.pick(days), r.pick(days)],
            error: analyzed[i]!.error as OutageError,
          })
        else {
          const { kind, pub } = randomKindPub(r)
          kinds[i] = kind
          pubs.push({ date: r.pick(days), at: t, post: i, seq: i + 1, pub })
        }
      }
      // newer, worked out here: on a page, higher up (a lower index); on a channel, later, then the
      // higher message id
      const newer = (a: number, b: number) =>
        timeless ? a < b : times[a]! > times[b]! || (times[a] === times[b] && a > b)
      const out = assembleDays(analyzed, [...pubs], items, 'kharkiv', now, { timeless })
      for (const d of days) {
        const expected =
          d >= '2026-11-18' &&
          items.some(
            (it) =>
              it.days.includes(d) &&
              !pubs.some(
                (p) =>
                  p.date === d &&
                  (kinds[p.post] === 'whole' || kinds[p.post] === 'cancel') &&
                  newer(p.post, it.post),
              ),
          )
        expect(!!out.get(d)?.unread, `seed ${seed} ${d}${timeless ? ' (page)' : ''}`).toBe(expected)
      }
    }
  })
})
