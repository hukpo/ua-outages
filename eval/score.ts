/**
 * How an answer is scored against a label, shared by `npm run eval` and the CI replay test
 * (`test/ai/replay.test.ts`): event by event, field by field. `area` counts only as present or
 * not (it is free text), touching spans of one kind are merged, and a ГПВ "з 00:00" is no time.
 */
import type { ImageReading, PostAnalysis, PostEvent } from '../src/ai/types.js'
/** Intervals as one comparable list: touching spans of one kind merged */
export function spans(list: readonly { from: string; to: string; kind: string }[]): string[] {
  const out: { from: string; to: string; kind: string }[] = []
  for (const i of [...list].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out.at(-1)
    if (last && last.kind === i.kind && last.to >= i.from) last.to = last.to > i.to ? last.to : i.to
    else out.push({ ...i })
  }
  return out.map((i) => `${i.from}-${i.to}${i.kind === 'maybe' ? '?' : ''}`)
}

const sortQ = (q: string[]) => [...q].sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b))
export function canon(e: PostEvent) {
  return {
    kind: e.kind,
    action: e.action,
    regions: [...e.regions].sort(),
    area: !!e.area,
    date: e.date,
    // a whole day "з 00:00" is the same as no time
    at: e.kind === 'gpv' && e.at === '00:00' ? null : e.at,
    until: e.until,
    allQueues: e.allQueues,
    queues: sortQ(e.queues),
    queuesRestored: sortQ(e.queuesRestored),
    queueCount: e.queueCount,
    additive: e.additive,
    again: e.again,
    gpvApplies: e.gpvApplies,
    addedInEdit: e.addedInEdit,
    untilFurtherNotice: e.untilFurtherNotice,
    schedule: [...e.schedule]
      .sort((a, b) => a.queue.localeCompare(b.queue, undefined, { numeric: true }))
      .map((q) => ({ queue: q.queue, intervals: q.intervals ? spans(q.intervals) : null })),
  }
}
type Canon = ReturnType<typeof canon>

/** Field-level differences between two event lists, matched by kind and action */
export function diffEvents(exp: PostEvent[], got: PostEvent[]): string[] {
  const a = exp.map(canon)
  const b = got.map(canon)
  const out: string[] = []
  const used = new Set<number>()
  for (const e of a) {
    let best = -1
    let bestDiff: string[] | null = null
    b.forEach((g, i) => {
      if (used.has(i) || g.kind !== e.kind || g.action !== e.action) return
      const d = (Object.keys(e) as (keyof Canon)[]).filter(
        (k) => JSON.stringify(e[k]) !== JSON.stringify(g[k]),
      )
      if (!bestDiff || d.length < bestDiff.length) {
        best = i
        bestDiff = d.map(
          (k) => `${e.kind}/${e.action}.${k}: want ${JSON.stringify(e[k])} got ${JSON.stringify(g[k])}`,
        )
      }
    })
    if (best === -1) out.push(`missing ${e.kind}/${e.action}${e.date ? ` ${e.date}` : ''}`)
    else {
      used.add(best)
      out.push(...bestDiff!)
    }
  }
  b.forEach((g, i) => {
    if (!used.has(i)) out.push(`extra ${g.kind}/${g.action}${g.date ? ` ${g.date}` : ''}`)
  })
  return out
}

export function diffImage(exp: ImageReading, got: ImageReading): string[] {
  const out: string[] = []
  for (const k of ['isSchedule', 'kind', 'date'] as const)
    if (exp[k] !== got[k]) out.push(`${k}: want ${exp[k]} got ${got[k]}`)
  const g = new Map(got.schedule.map((q) => [q.queue, q.intervals]))
  for (const q of exp.schedule) {
    const want = spans(q.intervals).join(',')
    const have = spans(g.get(q.queue) ?? []).join(',')
    if (want !== have) out.push(`${q.queue}: want ${want || '—'} got ${have || '—'}`)
  }
  return out
}

/**
 * What `photosAreSchedules` decides in the SDK: whether a post's photos are read as the schedule
 * (`readPicturePosts`): they are when the post says so or announces a schedule whose hours aren't
 * in its text
 */
export const readsPhotos = (a: PostAnalysis) =>
  a.photosAreSchedules ||
  a.events.some((e) => e.kind === 'gpv' && e.action !== 'cancel' && !e.schedule.length)
