import type OpenAI from 'openai'
import { OutageError } from '../errors.js'
import {
  IMAGE_CHECK_SCHEMA,
  IMAGE_CHECK_SYSTEM,
  IMAGE_SCHEMA,
  IMAGE_SYSTEM,
  PROMPT_VERSION,
  TEXT_SCHEMA,
  TEXT_SYSTEM,
  imagePrompt,
  textPrompt,
} from '../ai/prompts.js'
import type { CallOptions, ImageInput, ImageProcessor, ProcessorResult, TextProcessor } from '../ai/types.js'
import { base64, parseJson, vendorError } from './common.js'

/**
 * Text and image processors on the OpenAI Responses API (`openai`, an optional peer
 * dependency). The SDK holds no key: pass your own client and the model to use.
 *
 * ```ts
 * import OpenAI from 'openai'
 * import { openaiImageProcessor, openaiTextProcessor } from 'ua-outages/openai'
 *
 * const openai = new OpenAI() // OPENAI_API_KEY
 * const outages = new OutageClient({
 *   textProcessor: openaiTextProcessor({ client: openai, model: '<model>' }),
 *   imageProcessor: openaiImageProcessor({ client: openai, model: '<model>' }),
 * })
 * ```
 *
 * Answers use strict structured outputs (`text.format: json_schema`); the SDK still
 * validates every one.
 */
export interface OpenAIProcessorOptions {
  client: OpenAI
  model: string
  /** `reasoning.effort` for reasoning models; default the model's own */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  /** Default 16000 */
  maxOutputTokens?: number
  /**
   * `service_tier`, default `flex`: the same model at half the price, answering slower. When
   * flex has no capacity (429), the call is made again on the standard tier, so a schedule is
   * never left unread for want of it. `auto` for standard processing only
   */
  serviceTier?: 'flex' | 'auto' | 'default' | 'priority'
}

export interface OpenAIImageProcessorOptions extends OpenAIProcessorOptions {
  /**
   * Long edge the picture is scaled down to before it is sent, px; default 1600. OpenAI bills a
   * picture by its size after scaling the short side to 768 px itself, so a larger one costs
   * little more and keeps small cells legible
   */
  maxLongEdge?: number
  /** A smaller picture is scaled up by a whole factor towards this, px; default 1600, 0 for none */
  minLongEdge?: number
  /** Run the cheap "is it a schedule?" check on bare photos, default true */
  check?: boolean
  /** `detail` of the image input, default `high` */
  detail?: 'low' | 'high' | 'auto'
}

const VENDOR = 'OpenAI'

type Content = OpenAI.Responses.ResponseInputMessageContentList

async function ask(
  o: OpenAIProcessorOptions,
  system: string,
  name: string,
  schema: Record<string, unknown>,
  content: Content,
  url: string,
  call: CallOptions,
): Promise<ProcessorResult> {
  // the instructions and schema come first and never change: OpenAI caches that prefix itself
  const create = (tier: NonNullable<OpenAIProcessorOptions['serviceTier']>) =>
    o.client.responses.create(
      {
        model: o.model,
        instructions: system,
        input: [{ role: 'user', content }],
        max_output_tokens: o.maxOutputTokens ?? 16000,
        text: { format: { type: 'json_schema', name, schema, strict: true } },
        service_tier: tier,
        ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}),
      },
      // flex answers slower: 15 min before giving up, as the docs advise
      { signal: call.signal, ...(tier === 'flex' ? { timeout: 15 * 60_000 } : {}) },
    )
  const tier = o.serviceTier ?? 'flex'
  let res: OpenAI.Responses.Response
  try {
    try {
      res = await create(tier)
    } catch (e) {
      // flex out of capacity (429, not billed): the standard tier, once
      if (tier !== 'flex' || (e as { status?: unknown })?.status !== 429 || call.signal?.aborted) throw e
      res = await create('auto')
    }
  } catch (e) {
    throw vendorError(VENDOR, e, call.signal)
  }
  const refusal = res.output
    .flatMap((item) => (item.type === 'message' ? item.content : []))
    .find((c) => c.type === 'refusal')
  if (refusal || res.status === 'incomplete')
    throw new OutageError(
      'parse',
      `${VENDOR}: no answer for ${url} (${refusal ? 'refusal' : (res.incomplete_details?.reason ?? 'incomplete')})`,
      { url },
    )
  return {
    value: parseJson(VENDOR, res.output_text, url),
    usage: res.usage
      ? {
          inputTokens: res.usage.input_tokens,
          cachedInputTokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: res.usage.output_tokens,
          ...(res.service_tier ? { tier: res.service_tier } : {}),
        }
      : undefined,
  }
}

export function openaiTextProcessor(o: OpenAIProcessorOptions): TextProcessor {
  return {
    id: `openai:${o.model}:${o.reasoningEffort ?? 'default'}:${PROMPT_VERSION}`,
    analyzePost: (input, call) =>
      ask(
        o,
        TEXT_SYSTEM,
        'post_analysis',
        TEXT_SCHEMA,
        [{ type: 'input_text', text: textPrompt(input) }],
        input.url,
        call,
      ),
  }
}

const imageItem = (input: ImageInput, detail: 'low' | 'high' | 'auto') =>
  ({
    type: 'input_image',
    detail,
    image_url: `data:${input.mediaType};base64,${base64(input.bytes)}`,
  }) as const

export function openaiImageProcessor(o: OpenAIImageProcessorOptions): ImageProcessor {
  return {
    id: `openai:${o.model}:${o.reasoningEffort ?? 'default'}:${o.detail ?? 'high'}:${PROMPT_VERSION}`,
    maxLongEdge: o.maxLongEdge ?? 1600,
    minLongEdge: o.minLongEdge ?? 1600,
    readImage: (input, call) =>
      ask(
        o,
        IMAGE_SYSTEM,
        'image_reading',
        IMAGE_SCHEMA,
        [imageItem(input, o.detail ?? 'high'), { type: 'input_text', text: imagePrompt(input) }],
        input.url,
        call,
      ),
    ...(o.check === false
      ? {}
      : {
          isSchedule: (input: ImageInput, call: CallOptions) =>
            ask(
              { ...o, maxOutputTokens: 2000 },
              IMAGE_CHECK_SYSTEM,
              'image_check',
              IMAGE_CHECK_SCHEMA,
              [
                imageItem(input, 'low'),
                { type: 'input_text', text: input.caption ? `Caption: ${input.caption}` : 'No caption.' },
              ],
              input.url,
              call,
            ),
        }),
  }
}
