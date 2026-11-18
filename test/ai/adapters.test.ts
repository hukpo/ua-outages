import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { anthropicImageProcessor, anthropicTextProcessor } from '../../src/adapters/anthropic.js'
import { openaiImageProcessor, openaiTextProcessor } from '../../src/adapters/openai.js'
import { IMAGE_SCHEMA, PROMPT_VERSION, TEXT_SCHEMA, TEXT_SYSTEM } from '../../src/ai/prompts.js'
import { postRegion } from '../../src/ai/regions.js'
import type { ImageInput, PostInput } from '../../src/ai/types.js'

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

/** A stand-in for the SDK client: records the request, answers with `reply` */
function anthropic(reply: Partial<Anthropic.Message> | Error) {
  const requests: Anthropic.MessageCreateParams[] = []
  const client = {
    messages: {
      create: async (req: Anthropic.MessageCreateParams) => {
        requests.push(req)
        if (reply instanceof Error) throw reply
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 0,
          },
          ...reply,
        }
      },
    },
  } as unknown as Anthropic
  return { client, requests }
}

function openai(reply: Partial<OpenAI.Responses.Response> | Error) {
  const requests: OpenAI.Responses.ResponseCreateParams[] = []
  const client = {
    responses: {
      create: async (req: OpenAI.Responses.ResponseCreateParams) => {
        requests.push(req)
        if (reply instanceof Error) throw reply
        return {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
          output_text: JSON.stringify(answer),
          usage: { input_tokens: 12, output_tokens: 6 },
          ...reply,
        }
      },
    },
  } as unknown as OpenAI
  return { client, requests }
}

describe('ua-outages/anthropic', () => {
  it('asks Haiku 5.5 for structured JSON in the schema, the instructions cached', async () => {
    const { client, requests } = anthropic({})
    const p = anthropicTextProcessor({ client })
    expect(p.id).toBe(`anthropic:claude-haiku-5-5:default:${PROMPT_VERSION}`)
    const r = await p.analyzePost(post, {})
    expect(r).toEqual({ value: answer, usage: { inputTokens: 1010, outputTokens: 5 } })
    const req = requests[0]!
    expect(req.model).toBe('claude-haiku-5-5')
    expect(req.output_config).toEqual({ format: { type: 'json_schema', schema: TEXT_SCHEMA } })
    expect(req.system).toEqual([{ type: 'text', text: TEXT_SYSTEM, cache_control: { type: 'ephemeral' } }])
    expect(JSON.stringify(req.messages)).toContain('В 14:05 відміна дії графіку ГАВ')
  })

  it('sends the picture as base64 with the image schema, and offers the cheap check', async () => {
    const { client, requests } = anthropic({})
    const p = anthropicImageProcessor({
      client,
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxLongEdge: 900,
    })
    expect(p.maxLongEdge).toBe(900)
    await p.readImage(picture, {})
    const req = requests[0]!
    expect(req.output_config).toEqual({
      format: { type: 'json_schema', schema: IMAGE_SCHEMA },
      effort: 'high',
    })
    expect((req.messages[0]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
    })
    expect(p.isSchedule).toBeTypeOf('function')
    expect(anthropicImageProcessor({ client, check: false }).isSchedule).toBeUndefined()
  })

  it('a refusal or a cut-off answer is a parse error; API failures are http or network', async () => {
    await expect(
      anthropicTextProcessor({ client: anthropic({ stop_reason: 'refusal' }).client }).analyzePost(post, {}),
    ).rejects.toMatchObject({ code: 'parse', message: expect.stringContaining('refusal') })
    await expect(
      anthropicTextProcessor({
        client: anthropic({ content: [{ type: 'text', text: 'not json' }] as never }).client,
      }).analyzePost(post, {}),
    ).rejects.toMatchObject({ code: 'parse' })
    await expect(
      anthropicTextProcessor({
        client: anthropic(Object.assign(new Error('rate limited'), { status: 429 })).client,
      }).analyzePost(post, {}),
    ).rejects.toMatchObject({ code: 'http', details: { status: 429 } })
    await expect(
      anthropicTextProcessor({
        client: anthropic(Object.assign(new Error('ECONNRESET'), { name: 'APIConnectionError' })).client,
      }).analyzePost(post, {}),
    ).rejects.toMatchObject({ code: 'network' })
  })
})

describe('ua-outages/openai', () => {
  it('uses the Responses API with a strict JSON schema', async () => {
    const { client, requests } = openai({})
    const p = openaiTextProcessor({ client, model: 'gpt-6-luna', reasoningEffort: 'low' })
    expect(p.id).toBe(`openai:gpt-6-luna:low:${PROMPT_VERSION}`)
    expect(await p.analyzePost(post, {})).toEqual({
      value: answer,
      usage: { inputTokens: 12, outputTokens: 6 },
    })
    const req = requests[0]!
    expect(req).toMatchObject({
      model: 'gpt-6-luna',
      instructions: TEXT_SYSTEM,
      text: { format: { type: 'json_schema', name: 'post_analysis', schema: TEXT_SCHEMA, strict: true } },
      reasoning: { effort: 'low' },
    })
  })

  it('sends the picture as a data URL', async () => {
    const { client, requests } = openai({})
    await openaiImageProcessor({ client, model: 'gpt-6-luna' }).readImage(picture, {})
    const content = (
      requests[0]!.input as { content: { type: string; image_url?: string; detail?: string }[] }[]
    )[0]!.content
    const p = openaiImageProcessor({ client, model: 'gpt-6-luna' })
    expect([p.maxLongEdge, p.minLongEdge]).toEqual([1600, 1600])
    expect(content[0]).toEqual({
      type: 'input_image',
      detail: 'high',
      image_url: 'data:image/png;base64,AQID',
    })
  })

  it('a refusal or an incomplete answer is a parse error', async () => {
    const refusal = { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } as never
    await expect(
      openaiTextProcessor({ client: openai(refusal).client, model: 'm' }).analyzePost(post, {}),
    ).rejects.toMatchObject({
      code: 'parse',
    })
    const cut = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } as never
    await expect(
      openaiTextProcessor({ client: openai(cut).client, model: 'm' }).analyzePost(post, {}),
    ).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringContaining('max_output_tokens'),
    })
  })
})

describe('the core', () => {
  it('imports neither vendor SDK', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? (d.name === 'adapters' ? [] : walk(join(dir, d.name))) : [join(dir, d.name)],
      )
    for (const file of walk('src'))
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from '(?:@anthropic-ai\/sdk|openai)'/)
  })
})
