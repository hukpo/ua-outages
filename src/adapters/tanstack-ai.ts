import { chat, type AnyTextAdapter, type JSONSchema, type UsageInfo } from '@tanstack/ai'
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
import { base64, vendorError } from './common.js'

/**
 * Text and image processors on TanStack AI (`@tanstack/ai`, an optional peer dependency): any
 * text adapter of it (`@tanstack/ai-openai`, `-anthropic`, `-gemini`, `-ollama`, …).
 *
 * ```ts
 * import { openaiText } from '@tanstack/ai-openai'
 * import { tanstackImageProcessor, tanstackTextProcessor } from 'ua-outages/tanstack-ai'
 *
 * const outages = new OutageClient({
 *   textProcessor: tanstackTextProcessor({ adapter: openaiText('gpt-6.1-terra') }),
 *   imageProcessor: tanstackImageProcessor({ adapter: openaiText('gpt-6.1-terra') }),
 * })
 * ```
 *
 * Answers come through `chat({ outputSchema })`; the SDK validates every one. Measure a model
 * with `npm run eval` before relying on it: the defaults below were chosen with GPT-6.1 Terra.
 */
export interface TanstackProcessorOptions {
  /** A TanStack AI text adapter, e.g. `openaiText('gpt-6.1-terra')` */
  adapter: AnyTextAdapter
  /** Passed through as `modelOptions` */
  modelOptions?: Record<string, unknown>
  /**
   * Part of the processor id, so cached answers aren't reused across settings that change them
   * (`modelOptions` above); default none
   */
  variant?: string
}

export interface TanstackImageProcessorOptions extends TanstackProcessorOptions {
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

const VENDOR = 'TanStack AI'

const idOf = (o: TanstackProcessorOptions, kind: string) =>
  `tanstack-ai:${o.adapter.provider ?? o.adapter.name}:${o.adapter.model}${o.variant ? `:${o.variant}` : ''}:${kind}:${PROMPT_VERSION}`

type Part =
  | { type: 'text'; content: string }
  | { type: 'image'; source: { type: 'data'; value: string; mimeType: string } }

async function ask(
  o: TanstackProcessorOptions,
  system: string,
  schema: Record<string, unknown>,
  content: Part[],
  url: string,
  call: CallOptions,
): Promise<ProcessorResult> {
  // chat() takes a controller: one of our own, aborted with the caller's signal
  const abortController = new AbortController()
  const onAbort = () => abortController.abort(call.signal?.reason)
  call.signal?.addEventListener('abort', onAbort, { once: true })
  let usage: UsageInfo | undefined
  try {
    const value: unknown = await chat({
      adapter: o.adapter,
      systemPrompts: [system],
      messages: [{ role: 'user', content }] as never,
      outputSchema: schema as JSONSchema,
      threadId: `ua-outages:${url}`,
      abortController,
      ...(o.modelOptions ? { modelOptions: o.modelOptions as never } : {}),
      middleware: [{ name: 'ua-outages-usage', onUsage: (_ctx: unknown, u: UsageInfo) => void (usage = u) }],
    } as never)
    if (value === undefined || value === null)
      throw new OutageError('parse', `${VENDOR}: empty answer for ${url}`, { url })
    return {
      value,
      usage: usage
        ? {
            inputTokens: usage.promptTokens,
            cachedInputTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
            outputTokens: usage.completionTokens,
          }
        : undefined,
    }
  } catch (e) {
    // an answer that isn't JSON in the schema (chat() attaches the model's `rawText`, or finds no
    // result): unusable, not an API failure
    const err = e as { rawText?: unknown; message?: string }
    if (
      e instanceof SyntaxError ||
      err?.rawText !== undefined ||
      /structured output finalization produced no result/.test(err?.message ?? '')
    )
      throw new OutageError('parse', `${VENDOR}: no answer in the schema for ${url}`, { url, cause: e })
    throw vendorError(VENDOR, e, call.signal)
  } finally {
    call.signal?.removeEventListener('abort', onAbort)
  }
}

export function tanstackTextProcessor(o: TanstackProcessorOptions): TextProcessor {
  return {
    id: idOf(o, 'text'),
    analyzePost: (input, call) =>
      ask(o, TEXT_SYSTEM, TEXT_SCHEMA, [{ type: 'text', content: textPrompt(input) }], input.url, call),
  }
}

const imagePart = (input: ImageInput): Part => ({
  type: 'image',
  source: { type: 'data', value: base64(input.bytes), mimeType: input.mediaType },
})

export function tanstackImageProcessor(o: TanstackImageProcessorOptions): ImageProcessor {
  return {
    id: idOf(o, 'image'),
    maxLongEdge: o.maxLongEdge ?? 1000,
    minShortEdge: o.minShortEdge ?? 400,
    readImage: (input, call) =>
      ask(
        o,
        IMAGE_SYSTEM,
        IMAGE_SCHEMA,
        [imagePart(input), { type: 'text', content: imagePrompt(input) }],
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
              IMAGE_CHECK_SCHEMA,
              [imagePart(input), { type: 'text', content: input.caption ?? 'No caption.' }],
              input.url,
              call,
            ),
        }),
  }
}
