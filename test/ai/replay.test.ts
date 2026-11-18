import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diffEvents, diffImage, readsPhotos } from '../../eval/score.js'
import type { ImageInput, ImageReading, PostAnalysis, PostInput, PostRegion } from '../../src/ai/types.js'
import { validateImageReading, validatePostAnalysis } from '../../src/ai/validate.js'

/**
 * Real model answers, recorded by `npm run eval -- --record`, replayed through the SDK's own
 * validation and the eval's scoring, offline. Each recording also lists the cases that passed
 * when it was made: the replay must pass exactly those. A change to validation or mapping that
 * turns a right answer wrong (or the other way) shows up here, without calling any model.
 */
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const recordings = existsSync(root('test/fixtures/ai')) ? readdirSync(root('test/fixtures/ai')) : []

interface TextCase {
  input: PostInput
  expected: PostAnalysis
}
interface ImageCase {
  tags?: string[]
  input: { url: string; caption: string | null; publishedAt: string; region: PostRegion }
  expected: ImageReading
}
const load = <T>(path: string): T => JSON.parse(readFileSync(root(path), 'utf8'))

function scoreText(name: string, answer: unknown): boolean {
  const c = load<TextCase>(`eval/text/${name}.json`)
  try {
    const got = validatePostAnalysis(answer, c.input)
    const want = validatePostAnalysis(c.expected, c.input)
    return !diffEvents(want.events, got.events).length && readsPhotos(want) === readsPhotos(got)
  } catch {
    return false
  }
}

function scoreImage(name: string, answer: unknown): boolean {
  const c = load<ImageCase>(`eval/image/${name}.json`)
  // an album's picture may give some of the queues, as the SDK allows
  const album = c.tags?.includes('album') ? /-(\d+)$/.exec(name) : null
  const input: ImageInput = {
    ...c.input,
    index: album ? Number(album[1]) : 0,
    of: album ? 2 : 1,
    bytes: new Uint8Array(),
    mediaType: 'image/png',
    width: 0,
    height: 0,
  }
  try {
    return !diffImage(validateImageReading(c.expected, input), validateImageReading(answer, input)).length
  } catch {
    return false
  }
}

describe.each(recordings)('recorded answers of %s', (tag) => {
  for (const [kind, score] of [
    ['text', scoreText],
    ['image', scoreImage],
  ] as const) {
    const file = `test/fixtures/ai/${tag}/${kind}.json`
    if (!existsSync(root(file))) continue
    it(`${kind}: the same cases pass as when recorded`, () => {
      const answers = load<Record<string, unknown>>(file)
      const passed = Object.entries(answers)
        .filter(([name, answer]) => score(name, answer))
        .map(([name]) => name)
        .sort()
      expect(passed).toEqual(load<string[]>(`test/fixtures/ai/${tag}/${kind}.passed.json`))
    })
  }

  it('reads the posts the 0.4 regex reader got wrong', () => {
    const file = `test/fixtures/ai/${tag}/text.json`
    if (!existsSync(root(file))) return
    const answers = load<Record<string, unknown>>(file)
    for (const name of [
      'SvitloKropyvnytskyiMisto-1834',
      'Zaporizhzhyaoblenergo_news-3628',
      'Zaporizhzhyaoblenergo_news-3629',
    ])
      expect(scoreText(name, answers[name]), name).toBe(true)
  })
})
