import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiSdkImageProcessor, aiSdkTextProcessor } from '../../src/adapters/ai-sdk.js'
import { tanstackImageProcessor, tanstackTextProcessor } from '../../src/adapters/tanstack-ai.js'
import { IMAGE_SYSTEM, PROMPT_VERSION, TEXT_SCHEMA, TEXT_SYSTEM } from '../../src/ai/prompts.js'
import { postRegion } from '../../src/ai/regions.js'
import type { ImageInput, PostInput } from '../../src/ai/types.js'

// chat() of TanStack AI, replaced: it records its options and answers as a model would
const chatCalls: Record<string, any>[] = []
let chatAnswer: (opts: Record<string, any>) => unknown = () => answer
vi.mock('@tanstack/ai', () => ({
  chat: async (opts: Record<string, any>) => {
    chatCalls.push(opts)
    const value = chatAnswer(opts)
    for (const m of opts.middleware ?? [])
      m.onUsage?.(
        {},
        { promptTokens: 30, completionTokens: 7, totalTokens: 37, promptTokensDetails: { cachedTokens: 20 } },
      )
    return value
  },
}))

const post: PostInput = {
  url: 'https://t.me/SvitloKropyvnytskyiMisto/1834',
  source: { kind: 'telegram', channel: 'SvitloKropyvnytskyiMisto' },
  publishedAt: '2026-11-17T14:25:14+02:00',
  edited: false,
  title: null,
  text: 'В 14:05 відміна дії графіку ГАВ',
  replyTo: null,
  photoCount: 0,
  regions: [postRegion('kirovohrad')],
}
const picture: ImageInput = {
  url: 'https://t.me/chernigivoblenergo/5704',
  index: 0,
  of: 1,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png',
  width: 10,
  height: 10,
  caption: null,
  publishedAt: '2026-11-16T21:00:00+02:00',
  region: postRegion('chernihiv'),
}
const answer = { events: [], photosAreSchedules: false, statedAt: null }

/** An AI SDK model that answers `text` and records the calls */
function model(text: string, over: Partial<LanguageModelV4GenerateResult> = {}) {
  const calls: LanguageModelV4CallOptions[] = []
  const m = new MockLanguageModelV4({
    provider: 'openai.responses',
    modelId: 'gpt-6.1-terra',
    doGenerate: async (opts) => {
      calls.push(opts)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 2500, noCache: 100, cacheRead: 2400, cacheWrite: 0 },
          outputTokens: { total: 180, text: 180, reasoning: 0 },
        },
        warnings: [],
        ...over,
      }
    },
  })
  return { m, calls }
}

describe('ua-outages/ai-sdk', () => {
  it('asks any AI SDK model for JSON in the schema, the instructions as the system prompt', async () => {
    const { m, calls } = model(JSON.stringify(answer))
    const p = aiSdkTextProcessor({ model: m })
    expect(p.id).toBe(`ai-sdk:openai.responses:gpt-6.1-terra:text:${PROMPT_VERSION}`)
    expect(await p.analyzePost(post, {})).toEqual({
      value: answer,
      usage: { inputTokens: 2500, cachedInputTokens: 2400, outputTokens: 180 },
    })
    const call = calls[0]!
    expect(call.responseFormat).toMatchObject({ type: 'json', schema: TEXT_SCHEMA })
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: TEXT_SYSTEM })
    expect(JSON.stringify(call.prompt[1])).toContain('В 14:05 відміна дії графіку ГАВ')
  })

  it('sends the picture as a file part, with the picture defaults', async () => {
    const { m, calls } = model(
      JSON.stringify({ isSchedule: false, kind: null, date: null, statedAt: null, schedule: [] }),
    )
    const p = aiSdkImageProcessor({ model: m })
    expect([p.maxLongEdge, p.minShortEdge]).toEqual([1000, 400])
    await p.readImage(picture, {})
    expect(calls[0]!.prompt[0]).toMatchObject({ role: 'system', content: IMAGE_SYSTEM })
    const parts = calls[0]!.prompt[1]!.content as { type: string; mediaType?: string }[]
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png' })
    expect(aiSdkImageProcessor({ model: m, check: false }).isSchedule).toBeUndefined()
  })

  it('an answer that is not JSON or is cut off is a parse error; an API status is http', async () => {
    await expect(
      aiSdkTextProcessor({ model: model('not json').m }).analyzePost(post, {}),
    ).rejects.toMatchObject({
      code: 'parse',
    })
    const cut = model('{"events": [', { finishReason: { unified: 'length', raw: 'max_tokens' } })
    await expect(aiSdkTextProcessor({ model: cut.m }).analyzePost(post, {})).rejects.toMatchObject({
      code: 'parse',
    })
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw Object.assign(new Error('rate limited'), {
          name: 'AI_APICallError',
          statusCode: 429,
          isRetryable: false,
        })
      },
    })
    await expect(
      aiSdkTextProcessor({ model: failing, maxRetries: 0 }).analyzePost(post, {}),
    ).rejects.toMatchObject({ code: 'http', details: { status: 429 } })
  })
})

describe('ua-outages/tanstack-ai', () => {
  const adapter = { kind: 'text', name: 'openai', model: 'gpt-6.1-terra' } as never
  beforeEach(() => {
    chatCalls.length = 0
    chatAnswer = () => answer
  })

  it('runs chat() with the schema and the instructions, and counts the tokens', async () => {
    const p = tanstackTextProcessor({ adapter })
    expect(p.id).toBe(`tanstack-ai:openai:gpt-6.1-terra:text:${PROMPT_VERSION}`)
    expect(await p.analyzePost(post, {})).toEqual({
      value: answer,
      usage: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 7 },
    })
    expect(chatCalls[0]).toMatchObject({ adapter, systemPrompts: [TEXT_SYSTEM], outputSchema: TEXT_SCHEMA })
    expect(JSON.stringify(chatCalls[0]!.messages)).toContain('В 14:05 відміна дії графіку ГАВ')
  })

  it('sends the picture as base64 data', async () => {
    chatAnswer = () => ({ isSchedule: false, kind: null, date: null, statedAt: null, schedule: [] })
    await tanstackImageProcessor({ adapter }).readImage(picture, {})
    expect(chatCalls[0]!.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'data', value: 'AQID', mimeType: 'image/png' },
    })
  })

  it('a structured output that fails is a parse error; an API status is http', async () => {
    chatAnswer = () => {
      throw Object.assign(new Error('not JSON'), { rawText: 'oops' })
    }
    await expect(tanstackTextProcessor({ adapter }).analyzePost(post, {})).rejects.toMatchObject({
      code: 'parse',
    })
    chatAnswer = () => {
      throw Object.assign(new Error('overloaded'), { status: 529 })
    }
    await expect(tanstackTextProcessor({ adapter }).analyzePost(post, {})).rejects.toMatchObject({
      code: 'http',
      details: { status: 529 },
    })
  })
})

describe('processor ids carry the settings that change answers', () => {
  it('two AI SDK processors differing only in providerOptions have different ids', () => {
    const { m } = model('{}')
    const a = aiSdkTextProcessor({ model: m })
    const b = aiSdkTextProcessor({ model: m, providerOptions: { openai: { reasoningEffort: 'high' } } })
    expect(a.id).not.toBe(b.id)
    expect(aiSdkTextProcessor({ model: m }).id).toBe(a.id)
  })
})

describe('vendor errors, wherever the SDK puts the status', () => {
  it("AI SDK's RetryError and TanStack's wrapped cause keep their HTTP status; a 400 on the input is parse", async () => {
    const { vendorError } = await import('../../src/adapters/common.js')
    expect(vendorError('x', { name: 'AI_RetryError', lastError: { statusCode: 429 } })).toMatchObject({
      code: 'http',
      details: { status: 429 },
    })
    expect(vendorError('x', new Error('overloaded', { cause: { status: 529 } }))).toMatchObject({
      code: 'http',
    })
    expect(vendorError('x', Object.assign(new Error('image too large'), { status: 413 }))).toMatchObject({
      code: 'parse',
    })
    expect(vendorError('x', Object.assign(new Error('bad key'), { status: 401 }))).toMatchObject({
      code: 'http',
    })
  })

  it('TanStack: a caller gone before the call sends nothing', async () => {
    chatCalls.length = 0
    const ctrl = new AbortController()
    ctrl.abort(new Error('gone'))
    await expect(
      tanstackTextProcessor({ adapter: { kind: 'text', name: 'openai', model: 'm' } as never }).analyzePost(
        post,
        {
          signal: ctrl.signal,
        },
      ),
    ).rejects.toThrow('gone')
    expect(chatCalls).toHaveLength(0)
  })
})
