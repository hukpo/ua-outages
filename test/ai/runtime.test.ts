import { describe, expect, it } from 'vitest'
import { postRegion } from '../../src/ai/regions.js'
import { AiRuntime, MemoryProcessorCache } from '../../src/ai/runtime.js'
import type { PostInput, ProcessedEvent } from '../../src/ai/types.js'
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
