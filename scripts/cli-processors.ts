/**
 * Dev-only processors that run a model through a local CLI instead of an API key: `claude -p`
 * (Claude Code) and `codex exec` (Codex). For the eval set (`npm run eval -- --backend
 * claude-cli`), not shipped. Each call is a process, so they are slow; the answers go through
 * the same validation as any processor's.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
} from '../src/ai/prompts.js'
import type { ImageInput, ImageProcessor, ProcessorResult, TextProcessor } from '../src/ai/types.js'

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500) || out.slice(-500)}`)),
    )
  })
}

const scratch = () => mkdtempSync(join(tmpdir(), 'ua-outages-eval-'))
const ext = (input: ImageInput) => (input.mediaType === 'image/png' ? 'png' : 'jpg')

// --- Claude Code ---

async function claude(
  model: string,
  system: string,
  schema: object,
  prompt: string,
  signal?: AbortSignal,
  image?: ImageInput,
): Promise<ProcessorResult> {
  const dir = image ? scratch() : null
  try {
    let text = prompt
    const tools: string[] = ['--tools', '']
    if (image && dir) {
      const file = join(dir, `picture.${ext(image)}`)
      writeFileSync(file, image.bytes)
      text = `Look at the picture in ${file} (use the Read tool on it), then answer.\n\n${prompt}`
      tools.splice(0, 2, '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', dir)
    }
    const out = await run(
      'claude',
      [
        '-p',
        '--model',
        model,
        ...tools,
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
        '--system-prompt',
        system,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        text,
      ],
      signal,
    )
    const res = JSON.parse(out) as {
      structured_output?: unknown
      result?: string
      modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number }>
    }
    const usage = Object.values(res.modelUsage ?? {}).reduce(
      (a, u) => ({
        inputTokens: a.inputTokens + u.inputTokens,
        outputTokens: a.outputTokens + u.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    )
    return { value: res.structured_output ?? JSON.parse(res.result ?? 'null'), usage }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

export function claudeCliText(model = 'haiku'): TextProcessor {
  return {
    id: `claude-cli:${model}:${PROMPT_VERSION}`,
    analyzePost: (input, o) => claude(model, TEXT_SYSTEM, TEXT_SCHEMA, textPrompt(input), o.signal),
  }
}

export function claudeCliImage(model = 'haiku', maxLongEdge?: number, minShortEdge?: number): ImageProcessor {
  return {
    id: `claude-cli:${model}:${PROMPT_VERSION}`,
    maxLongEdge,
    minShortEdge,
    readImage: (input, o) => claude(model, IMAGE_SYSTEM, IMAGE_SCHEMA, imagePrompt(input), o.signal, input),
    isSchedule: (input, o) =>
      claude(model, IMAGE_CHECK_SYSTEM, IMAGE_CHECK_SCHEMA, input.caption ?? 'No caption.', o.signal, input),
  }
}

// --- Codex ---

async function codex(
  model: string,
  effort: string | undefined,
  system: string,
  schema: object,
  prompt: string,
  signal?: AbortSignal,
  image?: ImageInput,
): Promise<ProcessorResult> {
  const dir = scratch()
  try {
    const schemaFile = join(dir, 'schema.json')
    const outFile = join(dir, 'out.json')
    writeFileSync(schemaFile, JSON.stringify(schema))
    const args = ['exec', '-m', model, '--skip-git-repo-check', '--ephemeral', '-s', 'read-only']
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    args.push('--output-schema', schemaFile, '-o', outFile)
    if (image) {
      const file = join(dir, `picture.${ext(image)}`)
      writeFileSync(file, image.bytes)
      args.push(`--image=${file}`)
    }
    args.push('--json', `${system}\n\n${prompt}`)
    const usage = codexUsage(await run('codex', args, signal))
    return { value: JSON.parse(readFileSync(outFile, 'utf8')), ...(usage ? { usage } : {}) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Codex wraps the prompt in its own agent instructions (~20k input tokens for "Reply OK"):
 * CODEX_BASELINE_TOKENS, measured that way, is taken off so the count is about the prompt alone.
 * Output tokens include the model's reasoning.
 */
function codexUsage(jsonl: string): { inputTokens: number; outputTokens: number } | undefined {
  for (const line of jsonl.split('\n').reverse()) {
    if (!line.includes('"turn.completed"')) continue
    const u = JSON.parse(line).usage as {
      input_tokens: number
      cached_input_tokens: number
      output_tokens: number
      reasoning_output_tokens: number
    }
    if (process.env.CODEX_USAGE_LOG) appendFileSync(process.env.CODEX_USAGE_LOG, JSON.stringify(u) + '\n')
    const base = Number(process.env.CODEX_BASELINE_TOKENS ?? 0)
    return { inputTokens: Math.max(0, u.input_tokens - base), outputTokens: u.output_tokens }
  }
  return undefined
}

export function codexCliText(model = 'gpt-6.1-terra', effort?: string): TextProcessor {
  return {
    id: `codex-cli:${model}:${effort ?? 'default'}:${PROMPT_VERSION}`,
    analyzePost: (input, o) => codex(model, effort, TEXT_SYSTEM, TEXT_SCHEMA, textPrompt(input), o.signal),
  }
}

export function codexCliImage(
  model = 'gpt-6.1-terra',
  maxLongEdge?: number,
  minShortEdge?: number,
  effort?: string,
): ImageProcessor {
  return {
    id: `codex-cli:${model}:${effort ?? 'default'}:${PROMPT_VERSION}`,
    maxLongEdge,
    minShortEdge,
    readImage: (input, o) =>
      codex(model, effort, IMAGE_SYSTEM, IMAGE_SCHEMA, imagePrompt(input), o.signal, input),
    isSchedule: (input, o) =>
      codex(
        model,
        effort,
        IMAGE_CHECK_SYSTEM,
        IMAGE_CHECK_SCHEMA,
        input.caption ?? 'No caption.',
        o.signal,
        input,
      ),
  }
}
