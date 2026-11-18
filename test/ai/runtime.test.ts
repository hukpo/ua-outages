import { describe, expect, it, vi } from 'vitest'
import { postRegion } from '../../src/ai/regions.js'
import { AiRuntime, MemoryProcessorCache } from '../../src/ai/runtime.js'
import type { PostEvent, PostInput, ProcessedEvent } from '../../src/ai/types.js'
import { STANDARD_GROUPS } from '../../src/schedule.js'
import { ev, fakeImage, fakeText, fixtureBytes } from '../helpers.js'

const input = (text: string, over: Partial<PostInput> = {}): PostInput => ({
  url: 'https://t.me/poltavaOE/1',
  source: { kind: 'telegram', channel: 'poltavaOE' },
  publishedAt: '2026-11-02T07:34:00+02:00',
  edited: false,
  title: null,
  text,
  replyTo: null,
  photoCount: 0,
  regions: [postRegion('poltava')],
  ...over,
})

const apply = [ev({ kind: 'gav', action: 'start', regions: ['poltava'], allQueues: true })]

describe('AiRuntime: each post is parsed once', () => {
  it('answers the same input from the cache, and asks again when the text is edited', async () => {
    const text = fakeText(() => apply)
    const events: ProcessedEvent[] = []
    const ai = new AiRuntime({ textProcessor: text, onProcessed: (e) => events.push(e) })
    await ai.analyzePost('poltava', input('ГАВ застосовано'))
    await ai.analyzePost('poltava', input('ГАВ застосовано'))
    expect(text.calls).toHaveLength(1)
    await ai.analyzePost('poltava', input('ГАВ застосовано\nUPD: скасовано', { edited: true }))
    expect(text.calls).toHaveLength(2)
    expect(events.map((e) => e.cached)).toEqual([false, true, false])
    expect(events[0]).toMatchObject({
      type: 'text',
      ok: true,
      usage: { inputTokens: 100 },
      processor: 'fake-text',
    })
  })

  it('shares one call between concurrent askers', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const text = fakeText(async () => {
      await gate
      return apply
    })
    const ai = new AiRuntime({ textProcessor: text })
    const both = Promise.all([ai.analyzePost('poltava', input('x')), ai.analyzePost('poltava', input('x'))])
    release()
    await both
    expect(text.calls).toHaveLength(1)
  })

  it('keys by the processor: another model or prompt parses again', async () => {
    const cache = new MemoryProcessorCache()
    const a = fakeText(() => apply, 'model-a')
    const b = fakeText(() => apply, 'model-b')
    await new AiRuntime({ textProcessor: a, processorCache: cache }).analyzePost('poltava', input('x'))
    await new AiRuntime({ textProcessor: b, processorCache: cache }).analyzePost('poltava', input('x'))
    await new AiRuntime({ textProcessor: a, processorCache: cache }).analyzePost('poltava', input('x'))
    expect([a.calls.length, b.calls.length]).toEqual([1, 1])
  })

  it('remembers a misread for a while instead of paying for it on every poll', async () => {
    const text = fakeText(() => [ev({ kind: 'gav', action: 'start', regions: ['poltava'], at: '25:00' })])
    const ai = new AiRuntime({ textProcessor: text })
    await expect(ai.analyzePost('poltava', input('x'))).rejects.toMatchObject({ code: 'parse' })
    await expect(ai.analyzePost('poltava', input('x'))).rejects.toMatchObject({ code: 'parse' })
    expect(text.calls).toHaveLength(1)
  })

  it('does not remember an AI API failure', async () => {
    let fail = true
    const text = fakeText(() => {
      if (fail) throw Object.assign(new Error('overloaded'), { status: 529 })
      return apply
    })
    const ai = new AiRuntime({ textProcessor: text })
    await expect(ai.analyzePost('poltava', input('x'))).rejects.toThrow('overloaded')
    fail = false
    await expect(ai.analyzePost('poltava', input('x'))).resolves.toMatchObject({ events: apply })
    expect(text.calls).toHaveLength(2)
  })

  it('without a processor says so: config', async () => {
    const ai = new AiRuntime()
    await expect(ai.analyzePost('poltava', input('x'))).rejects.toMatchObject({
      code: 'config',
      message: expect.stringContaining('textProcessor'),
    })
    expect(() => ai.requireImage('volyn')).toThrow(expect.objectContaining({ code: 'config' }))
  })

  it('keeps at most `processorConcurrency` calls in flight', async () => {
    let running = 0
    let peak = 0
    const text = fakeText(async () => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return apply
    })
    const ai = new AiRuntime({ textProcessor: text, processorConcurrency: 2 })
    await Promise.all(Array.from({ length: 6 }, (_, i) => ai.analyzePost('poltava', input(`post ${i}`))))
    expect(peak).toBe(2)
  })

  it('a cancelled caller does not cancel the call others wait on', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const text = fakeText(async () => {
      await gate
      return apply
    })
    const ai = new AiRuntime({ textProcessor: text })
    const ctrl = new AbortController()
    const first = ai.analyzePost('poltava', input('x'), ctrl.signal)
    const second = ai.analyzePost('poltava', input('x'))
    ctrl.abort(new Error('gone'))
    await expect(first).rejects.toThrow('gone')
    release()
    await expect(second).resolves.toMatchObject({ events: apply })
  })
})

describe('AiRuntime: pictures', () => {
  const region = postRegion('volyn')
  const full = STANDARD_GROUPS.map((queue) => ({ queue, intervals: [] }))
  const bytes = fixtureBytes('volyn/gpv-2026-10-17-1847.png')

  it('reads a picture once per content, scaled down to the processor’s long edge', async () => {
    const image = fakeImage(() => ({ date: '2026-10-17', schedule: full }), { maxLongEdge: 800 })
    const events: ProcessedEvent[] = []
    const ai = new AiRuntime({ imageProcessor: image, onProcessed: (e) => events.push(e) })
    const src = {
      url: 'https://example/1.png',
      bytes,
      caption: null,
      publishedAt: '2026-10-17T18:47:00+03:00',
      region,
    }
    await ai.readImage('volyn', src)
    // a repost: another url, the same picture
    await ai.readImage('volyn', { ...src, url: 'https://example/2.png' })
    expect(image.calls).toHaveLength(1)
    expect(image.calls[0]).toMatchObject({ width: 622, height: 800, mediaType: 'image/png' })
    expect(events[0]!.image).toMatchObject({
      original: { width: 1750, height: 2250 },
      sent: { width: 622, height: 800 },
    })
  })

  it('checks a bare photo cheaply on a small copy', async () => {
    const image = fakeImage(() => undefined, { check: () => false })
    const ai = new AiRuntime({ imageProcessor: image })
    const src = {
      url: 'https://t.me/x/1',
      bytes,
      caption: null,
      publishedAt: '2026-10-17T18:47:00+03:00',
      region,
    }
    expect(await ai.isSchedule('volyn', src)).toBe(false)
    expect(image.checks[0]!.width).toBeLessThanOrEqual(256)
    expect(image.calls).toHaveLength(0)
  })
})

describe('AiRuntime: an emergency post is read twice, and a judge settles a disagreement', () => {
  const start = (queues: string[]) => [ev({ kind: 'gav', action: 'start', regions: ['poltava'], queues })]
  const post = input('ГАВ: 9,10,1,2 черги знеструмлюємо')

  it('takes the post when the second reader agrees, without asking the judge', async () => {
    const text = fakeText(() => start(['1', '2']), 'terra')
    const verify = fakeText(() => start(['2', '1']), 'haiku')
    const judge = fakeText(() => start(['5']), 'opus')
    const events: ProcessedEvent[] = []
    const ai = new AiRuntime({
      textProcessor: text,
      verifyProcessor: verify,
      judgeProcessor: judge,
      onProcessed: (e) => events.push(e),
    })
    expect((await ai.analyzeEmergencyPost('poltava', post)).events[0]!.queues).toEqual(['1', '2'])
    expect([text.calls.length, verify.calls.length, judge.calls.length]).toEqual([1, 1, 0])
    expect(events.map((e) => e.role)).toEqual([undefined, 'verify'])
  })

  it('lets two of three decide, and returns a reading of the majority', async () => {
    const ai = new AiRuntime({
      textProcessor: fakeText(() => start(['1', '2', '9', '10']), 'terra'),
      verifyProcessor: fakeText(() => start(['1', '2']), 'haiku'),
      judgeProcessor: fakeText(() => start(['1', '2']), 'opus'),
    })
    expect((await ai.analyzeEmergencyPost('poltava', post)).events[0]!.queues).toEqual(['1', '2'])
  })

  it('three readings, or two without a judge, that differ: parse, never a guess', async () => {
    const three = new AiRuntime({
      textProcessor: fakeText(() => start(['1']), 'terra'),
      verifyProcessor: fakeText(() => start(['2']), 'haiku'),
      judgeProcessor: fakeText(() => start(['3']), 'opus'),
    })
    await expect(three.analyzeEmergencyPost('poltava', post)).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringContaining('disagree'),
    })
    const two = new AiRuntime({
      textProcessor: fakeText(() => start(['1']), 'terra'),
      verifyProcessor: fakeText(() => start(['2']), 'haiku'),
    })
    await expect(two.analyzeEmergencyPost('poltava', post)).rejects.toMatchObject({ code: 'parse' })
  })

  it('readers that disagree are asked again after 10 minutes, not answered from the cache forever', async () => {
    const t0 = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      const haiku = fakeText(() => start(['2']), 'haiku')
      const ai = new AiRuntime({
        textProcessor: fakeText(() => start(['1']), 'terra'),
        verifyProcessor: haiku,
      })
      await expect(ai.analyzeEmergencyPost('poltava', post)).rejects.toMatchObject({ code: 'parse' })
      await expect(ai.analyzeEmergencyPost('poltava', post)).rejects.toMatchObject({ code: 'parse' })
      expect(haiku.calls).toHaveLength(1)
      clock.mockReturnValue(t0 + 11 * 60_000)
      await expect(ai.analyzeEmergencyPost('poltava', post)).rejects.toMatchObject({ code: 'parse' })
      expect(haiku.calls).toHaveLength(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('a second reader that fails validation is no vote: the judge decides with the first', async () => {
    const ai = new AiRuntime({
      textProcessor: fakeText(() => start(['1']), 'terra'),
      verifyProcessor: fakeText(
        () => [ev({ kind: 'gav', action: 'start', regions: ['poltava'], at: '25:00' })],
        'haiku',
      ),
      judgeProcessor: fakeText(() => start(['1']), 'opus'),
    })
    expect((await ai.analyzeEmergencyPost('poltava', post)).events[0]!.queues).toEqual(['1'])
  })

  it('checks only posts with emergency events, unless asked to check all', async () => {
    const plain = input('Шановні споживачі, економте електроенергію')
    const verify = fakeText(() => undefined, 'haiku')
    const ai = new AiRuntime({ textProcessor: fakeText(() => undefined, 'terra'), verifyProcessor: verify })
    await ai.analyzeEmergencyPost('poltava', plain)
    expect(verify.calls).toHaveLength(0)
    const all = new AiRuntime({
      textProcessor: fakeText(() => undefined, 'terra'),
      verifyProcessor: verify,
      verifyPosts: 'all',
    })
    await all.analyzeEmergencyPost('poltava', plain)
    expect(verify.calls).toHaveLength(1)
    // a schedule reader isn't checked at all
    const gpv = fakeText(() => undefined, 'haiku-2')
    await new AiRuntime({
      textProcessor: fakeText(() => start(['1']), 'terra'),
      verifyProcessor: gpv,
    }).analyzePost('poltava', post)
    expect(gpv.calls).toHaveLength(0)
  })
})

describe('AiRuntime: what two readers must agree on', () => {
  const post = input('ГАВ: оновлення')
  const run = async (a: PostEvent[], b: PostEvent[], c?: PostEvent[]) => {
    const judge = c ? fakeText(() => c, 'opus') : undefined
    const ai = new AiRuntime({
      textProcessor: fakeText(() => a, 'terra'),
      verifyProcessor: fakeText(() => b, 'haiku'),
      ...(judge ? { judgeProcessor: judge } : {}),
    })
    const r = await ai.analyzeEmergencyPost('poltava', post).catch((e) => e)
    return { r, judged: judge?.calls.length ?? 0 }
  }
  const start = ev({ kind: 'gav', action: 'start', regions: ['poltava'], allQueues: true })
  const cancel = ev({ kind: 'gav', action: 'cancel', regions: ['poltava'] })

  it('the order of a post’s events: "start, cancel" and "cancel, start" end apart', async () => {
    const { r, judged } = await run([start, cancel], [cancel, start])
    expect(r).toMatchObject({ code: 'parse' })
    expect(judged).toBe(0)
  })

  it('which area, not only that there is one', async () => {
    const at = (area: string) => ev({ kind: 'gav', action: 'cancel', regions: ['poltava'], area })
    expect((await run([at('м. Павлоград')], [at('м. Павлограді')])).r).toMatchObject({
      events: [{ area: 'м. Павлоград' }],
    })
    expect((await run([at('м. Павлоград')], [at('м. Дніпро')])).r).toMatchObject({ code: 'parse' })
  })

  it('"ще 2 черги" and "2 черги": additive counts apart', async () => {
    const two = (additive: boolean) =>
      ev({ kind: 'gav', action: 'start', regions: ['poltava'], queueCount: 2, additive })
    expect((await run([two(true)], [two(false)])).r).toMatchObject({ code: 'parse' })
  })

  it('a reader with another’s id is refused: it would answer from that one’s cache', () => {
    expect(
      () =>
        new AiRuntime({
          textProcessor: fakeText(() => [], 'same'),
          verifyProcessor: fakeText(() => [], 'same'),
        }),
    ).toThrow(expect.objectContaining({ code: 'config' }))
  })
})

describe('AiRuntime: the cache keeps raw answers and checks them on every use', () => {
  it('an answer cached before a stricter check is refused when used again', async () => {
    const cache = new MemoryProcessorCache()
    const text = fakeText(() => apply, 'p')
    const ai = new AiRuntime({ textProcessor: text, processorCache: cache })
    await ai.analyzePost('poltava', input('x'))
    // what a store from an older SDK holds: the raw answer, now with a time that doesn't exist
    for (const [k, v] of [
      ...(cache as unknown as { map: Map<string, { value: { value: { events: unknown[] } } }> }).map,
    ])
      cache.set(k, {
        ok: true,
        value: { ...v.value.value, events: [{ ...(v.value.value.events[0] as object), at: '25:00' }] },
      })
    const events: ProcessedEvent[] = []
    const watched = new AiRuntime({
      textProcessor: text,
      processorCache: cache,
      onProcessed: (e) => events.push(e),
    })
    await expect(watched.analyzePost('poltava', input('x'))).rejects.toMatchObject({ code: 'parse' })
    // reported as the failure it is, and remembered as a misread: asked again after a while
    expect(events).toMatchObject([{ cached: true, ok: false }])
    const entry = [
      ...(cache as unknown as { map: Map<string, { value: { ok: boolean; until: number } }> }).map.values(),
    ][0]!
    expect(entry.value).toMatchObject({ ok: false })
    expect(entry.value.until).toBeGreaterThan(Date.now())
    expect(text.calls).toHaveLength(1)
  })

  it('a cache store that fails is no cache: the answer still comes back', async () => {
    const text = fakeText(() => apply, 'p')
    const broken = {
      get: async () => {
        throw new Error('redis down')
      },
      set: async () => {
        throw new Error('redis down')
      },
    }
    const ai = new AiRuntime({ textProcessor: text, processorCache: broken })
    expect((await ai.analyzePost('poltava', input('x'))).events).toHaveLength(1)
  })

  it('a call its only caller left writes nothing, failure or not', async () => {
    let finish!: (v: unknown) => void
    const text = fakeText(() => new Promise<PostEvent[]>((r) => (finish = r as never)), 'p')
    const cache = new MemoryProcessorCache()
    const ai = new AiRuntime({ textProcessor: text, processorCache: cache })
    const ctrl = new AbortController()
    const call = ai.analyzePost('poltava', input('x'), ctrl.signal)
    await new Promise((r) => setTimeout(r, 5))
    ctrl.abort(new Error('gone'))
    await expect(call).rejects.toThrow('gone')
    finish([ev({ kind: 'gav', action: 'start', regions: ['poltava'], at: '25:00' })])
    await new Promise((r) => setTimeout(r, 5))
    expect((cache as unknown as { map: Map<string, unknown> }).map.size).toBe(0)
  })

  it('a picture reposted another day is read again, against that day', async () => {
    const region = postRegion('volyn')
    const full = STANDARD_GROUPS.map((queue) => ({ queue, intervals: [] }))
    const image = fakeImage(() => ({ date: '2026-10-17', schedule: full }))
    const ai = new AiRuntime({ imageProcessor: image })
    const src = { url: 'u', bytes: fixtureBytes('volyn/gpv-2026-10-17-1847.png'), caption: null, region }
    await ai.readImage('volyn', { ...src, publishedAt: '2026-10-17T18:47:00+03:00' })
    await ai.readImage('volyn', { ...src, publishedAt: '2026-10-17T19:30:00+03:00', url: 'v' })
    expect(image.calls).toHaveLength(2)
  })
})
