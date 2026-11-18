import { generateText, jsonSchema, Output, type LanguageModel, type ModelMessage } from 'ai'
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
import { optionsTag, vendorError } from './common.js'

/**
 * Text and image processors on the Vercel AI SDK (`ai`, an optional peer dependency): any model
 * it has a provider for (OpenAI, Anthropic, Google, Mistral, a local one, or a Gateway id).
 *
 * ```ts
 * import { openai } from '@ai-sdk/openai'
 * import { aiSdkImageProcessor, aiSdkTextProcessor } from 'ua-outages/ai-sdk'
 *
 * const outages = new OutageClient({
 *   textProcessor: aiSdkTextProcessor({ model: openai('gpt-6.1-terra') }),
 *   imageProcessor: aiSdkImageProcessor({ model: openai('gpt-6.1-terra') }),
 * })
 * ```
 *
 * The answers use the model's structured output where the provider has one; the SDK validates
 * every answer either way. Measure a model with `npm run eval` before relying on it: the
 * defaults below were chosen with GPT-6.1 Terra.
 */
export interface AiSdkProcessorOptions {
  /** A provider's model (`openai('gpt-6.1-terra')`) or an AI Gateway id (`'openai/gpt-6.1-terra'`) */
  model: LanguageModel
  /** Passed through to the provider, e.g. `{ openai: { reasoningEffort: 'low' } }` */
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions']
  /** Default 16000 */
  maxOutputTokens?: number
  /** Retries of the AI SDK itself (rate limits, overload), default 2 */
  maxRetries?: number
  /**
   * Part of the processor id, so cached answers aren't reused across settings that change them
   * (`providerOptions` above); default none
   */
  variant?: string
}

export interface AiSdkImageProcessorOptions extends AiSdkProcessorOptions {
  /** Long edge the picture is scaled down to before it is sent, px; default 1000 */
  maxLongEdge?: number
  /**
   * A picture with a shorter short side, px, is scaled up pixel for pixel by the largest whole
   * factor within 2400 px; default 400 (Zakarpattia's 800×210 grid goes as 2400×630), 0 for none
   */
  minShortEdge?: number
  /** Run the cheap "is it a schedule?" check on bare photos, default true */
  check?: boolean
}

const VENDOR = 'AI SDK'

/** "openai:gpt-6.1-terra" for a provider's model, the id itself for a Gateway one */
function modelName(model: LanguageModel): string {
  if (typeof model === 'string') return model
  const m = model as { provider?: string; modelId?: string }
  return `${m.provider ?? 'model'}:${m.modelId ?? 'unknown'}`
}

const idOf = (o: AiSdkProcessorOptions, kind: string) =>
  `ai-sdk:${modelName(o.model)}${o.variant ? `:${o.variant}` : ''}${optionsTag({ providerOptions: o.providerOptions, maxOutputTokens: o.maxOutputTokens })}:${kind}:${PROMPT_VERSION}`

async function ask(
  o: AiSdkProcessorOptions,
  instructions: string,
  name: string,
  schema: Record<string, unknown>,
  content: Extract<ModelMessage, { role: 'user' }>['content'],
  url: string,
  call: CallOptions,
): Promise<ProcessorResult> {
  let res: Awaited<ReturnType<typeof generateText>>
  let value: unknown
  try {
    res = await generateText({
      model: o.model,
      instructions,
      messages: [{ role: 'user', content }],
      output: Output.object({ schema: jsonSchema(schema as never), name }),
      maxOutputTokens: o.maxOutputTokens ?? 16000,
      maxRetries: o.maxRetries ?? 2,
      ...(o.providerOptions ? { providerOptions: o.providerOptions } : {}),
      ...(call.signal ? { abortSignal: call.signal } : {}),
    })
    if (res.finishReason === 'length' || res.finishReason === 'content-filter')
      throw new OutageError('parse', `${VENDOR}: no answer for ${url} (${res.finishReason})`, { url })
    // read here: the AI SDK parses the answer when it is first asked for
    value = res.output
  } catch (e) {
    // the model answered, but not with JSON in the schema: the answer is unusable, not the API
    const err = e as { name?: string }
    if (err?.name === 'AI_NoObjectGeneratedError' || err?.name === 'AI_NoOutputGeneratedError')
      throw new OutageError('parse', `${VENDOR}: no answer in the schema for ${url}`, { url, cause: e })
    throw vendorError(VENDOR, e, call.signal)
  }
  const u = res.usage
  return {
    value,
    usage:
      u?.inputTokens !== undefined && u?.outputTokens !== undefined
        ? {
            inputTokens: u.inputTokens,
            cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
            outputTokens: u.outputTokens,
          }
        : undefined,
  }
}

export function aiSdkTextProcessor(o: AiSdkProcessorOptions): TextProcessor {
  return {
    id: idOf(o, 'text'),
    analyzePost: (input, call) =>
      ask(
        o,
        TEXT_SYSTEM,
        'post_analysis',
        TEXT_SCHEMA,
        [{ type: 'text', text: textPrompt(input) }],
        input.url,
        call,
      ),
  }
}

const imagePart = (input: ImageInput) => ({
  type: 'image' as const,
  image: input.bytes,
  mediaType: input.mediaType,
})

export function aiSdkImageProcessor(o: AiSdkImageProcessorOptions): ImageProcessor {
  return {
    id: idOf(o, 'image'),
    maxLongEdge: o.maxLongEdge ?? 1000,
    minShortEdge: o.minShortEdge ?? 400,
    readImage: (input, call) =>
      ask(
        o,
        IMAGE_SYSTEM,
        'image_reading',
        IMAGE_SCHEMA,
        [imagePart(input), { type: 'text', text: imagePrompt(input) }],
        input.url,
        call,
      ),
    ...(o.check === false
      ? {}
      : {
          isSchedule: (input: ImageInput, call: CallOptions) =>
            ask(
              o,
              IMAGE_CHECK_SYSTEM,
              'image_check',
              IMAGE_CHECK_SCHEMA,
              [imagePart(input), { type: 'text', text: input.caption ?? 'No caption.' }],
              input.url,
              call,
            ),
        }),
  }
}
