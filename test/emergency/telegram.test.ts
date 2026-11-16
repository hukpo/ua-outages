import { describe, expect, it } from 'vitest'
import { Http } from '../../src/http.js'
import { htmlToText, parseTelegramPreview, readChannel } from '../../src/emergency/telegram.js'
import { fixture, mockFetch } from '../helpers.js'
import { previewPage } from './preview.js'

describe('Telegram channel preview', () => {
  const posts = parseTelegramPreview(fixture('telegram/ztoe_ua-before-1875.trimmed.html'))

  it('reads every post with text, oldest first', () => {
    expect(posts.map((p) => p.id)).toEqual([
      1855, 1856, 1857, 1858, 1859, 1860, 1861, 1862, 1869, 1870, 1871, 1872, 1873, 1874,
    ])
    expect(posts[0]).toMatchObject({
      channel: 'ztoe_ua',
      url: 'https://t.me/ztoe_ua/1855',
      // <time datetime="2026-10-30T08:34:29+00:00">, in Kyiv time
      at: '2026-10-30T10:34:29+02:00',
      edited: false,
    })
  })

  it('marks edited posts and shows their latest text', () => {
    const edited = posts.filter((p) => p.edited).map((p) => p.id)
    expect(edited).toEqual([1872, 1873])
    expect(posts.find((p) => p.id === 1872)!.text).toMatch(
      /^UPD: Аварійні відключення на Житомирщині скасовано\n\n/,
    )
  })

  it('turns the message HTML into plain text (emoji, line breaks, entities)', () => {
    const [apply, cancel] = parseTelegramPreview(fixture('telegram/cek_info-4315-4316.trimmed.html'))
    expect(apply!.text).toBe(
      '📢 Шановні споживачі м. ДНІПРО‼️\n\nПопереджаємо, що за командою диспетчерського центру НЕК "Укренерго" застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️ ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ не діють‼️',
    )
    expect(cancel!.at).toBe('2026-11-04T15:54:15+02:00')
    expect(htmlToText('a&nbsp;b<br/>c &#8212; &#x41; &laquo;x&raquo; <a href="#">link</a>')).toBe(
      'a b\nc — A «x» link',
    )
  })

  it('pages back with ?before= until the lookback is covered', async () => {
    const { fetch, calls } = mockFetch([
      {
        match: 't.me/s/ztoe_ua?before=1855',
        body: previewPage('ztoe_ua', [{ id: 1850, at: '2026-10-27T10:00:00Z', text: 'Старе повідомлення' }]),
      },
      { match: 't.me/s/ztoe_ua', body: fixture('telegram/ztoe_ua-before-1875.trimmed.html') },
    ])
    const ctx = { http: new Http({ fetch }), now: () => new Date('2026-11-04T12:00:00Z') }
    const got = await readChannel(ctx, 'ztoe_ua', {
      region: 'zhytomyr',
      since: new Date('2026-10-29T00:00:00Z'),
    })
    expect(calls.map((c) => c.url)).toEqual(['https://t.me/s/ztoe_ua', 'https://t.me/s/ztoe_ua?before=1855'])
    // 1850 is older than the lookback
    expect(got[0]!.id).toBe(1855)
    expect(got.at(-1)!.id).toBe(1874)
  })

  it('stops at one page when it already reaches back far enough', async () => {
    const { fetch, calls } = mockFetch([
      { match: 't.me/s/ztoe_ua', body: fixture('telegram/ztoe_ua-before-1875.trimmed.html') },
    ])
    const ctx = { http: new Http({ fetch }), now: () => new Date('2026-11-04T12:00:00Z') }
    const got = await readChannel(ctx, 'ztoe_ua', {
      region: 'zhytomyr',
      since: new Date('2026-11-02T00:00:00Z'),
    })
    expect(calls).toHaveLength(1)
    expect(got.map((p) => p.id)).toEqual([1861, 1862, 1869, 1870, 1871, 1872, 1873, 1874])
  })

  it('a page without posts is a format problem, not silence', async () => {
    const { fetch } = mockFetch([{ match: 't.me/s/', body: '<html><body>Channel not found</body></html>' }])
    const ctx = { http: new Http({ fetch }), now: () => new Date() }
    await expect(readChannel(ctx, 'nope', { region: 'zhytomyr', since: new Date(0) })).rejects.toMatchObject({
      code: 'parse',
    })
  })
})
