import type Anthropic from '@anthropic-ai/sdk'
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
 * Text and image processors on the Claude API (`@anthropic-ai/sdk`, an optional peer
 * dependency). The SDK holds no key: pass your own client.
 *
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk'
 * import { OutageClient } from 'ua-outages'
 * import { anthropicImageProcessor, anthropicTextProcessor } from 'ua-outages/anthropic'
 *
 * const anthropic = new Anthropic() // ANTHROPIC_API_KEY
 * const outages = new OutageClient({
 *   textProcessor: anthropicTextProcessor({ client: anthropic }),
 *   imageProcessor: anthropicImageProcessor({ client: anthropic }),
 * })
 * ```
 *
 * Answers use structured outputs (`output_config.format`), so they are JSON in the schema;
 * the SDK still validates every one.
 */
export interface AnthropicProcessorOptions {
  client: Anthropic
  /** Default `claude-haiku-5-5` */
  model?: string
  /** `output_config.effort`; default the model's own */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Default 16000 */
  maxTokens?: number
}

export interface AnthropicImageProcessorOptions extends AnthropicProcessorOptions {
  /** Long edge the picture is scaled to before it is sent, px; default 800 */
  maxLongEdge?: number
  /** Run the cheap "is it a schedule?" check on bare photos, default true */
  check?: boolean
}

const VENDOR = 'Anthropic'
const DEFAULT_MODEL = 'claude-haiku-5-5'

type Content = Anthropic.MessageCreateParams['messages'][number]['content']

async function ask(
  o: AnthropicProcessorOptions,
  system: string,
  schema: Record<string, unknown>,
  content: Content,
  url: string,
  call: CallOptions,
): Promise<ProcessorResult> {
  let res: Anthropic.Message
  try {
    res = await o.client.messages.create(
      {
        model: o.model ?? DEFAULT_MODEL,
        max_tokens: o.maxTokens ?? 16000,
        // the same instructions on every call: cached
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema }, ...(o.effort ? { effort: o.effort } : {}) },
      },
      { signal: call.signal },
    )
  } catch (e) {
    throw vendorError(VENDOR, e, call.signal)
  }
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens')
    throw new OutageError('parse', `${VENDOR}: no answer for ${url} (${res.stop_reason})`, { url })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    value: parseJson(VENDOR, text, url),
    usage: {
      inputTokens:
        res.usage.input_tokens +
        (res.usage.cache_read_input_tokens ?? 0) +
        (res.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
    },
  }
}

export function anthropicTextProcessor(o: AnthropicProcessorOptions): TextProcessor {
  return {
    id: `anthropic:${o.model ?? DEFAULT_MODEL}:${o.effort ?? 'default'}:${PROMPT_VERSION}`,
    analyzePost: (input, call) => ask(o, TEXT_SYSTEM, TEXT_SCHEMA, textPrompt(input), input.url, call),
  }
}

const imageBlock = (input: ImageInput) =>
  ({
    type: 'image',
    source: { type: 'base64', media_type: input.mediaType, data: base64(input.bytes) },
  }) as const

export function anthropicImageProcessor(o: AnthropicImageProcessorOptions): ImageProcessor {
  return {
    id: `anthropic:${o.model ?? DEFAULT_MODEL}:${o.effort ?? 'default'}:${PROMPT_VERSION}`,
    maxLongEdge: o.maxLongEdge,
    readImage: (input, call) =>
      ask(
        o,
        IMAGE_SYSTEM,
        IMAGE_SCHEMA,
        [imageBlock(input), { type: 'text', text: imagePrompt(input) }],
        input.url,
        call,
      ),
    ...(o.check === false
      ? {}
      : {
          isSchedule: (input: ImageInput, call: CallOptions) =>
            ask(
              { ...o, effort: 'low', maxTokens: 2000 },
              IMAGE_CHECK_SYSTEM,
              IMAGE_CHECK_SCHEMA,
              [
                imageBlock(input),
                { type: 'text', text: input.caption ? `Caption: ${input.caption}` : 'No caption.' },
              ],
              input.url,
              call,
            ),
        }),
  }
}
