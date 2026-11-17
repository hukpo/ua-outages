import { describe, expect, it } from 'vitest'
import { Http } from '../../src/http.js'
import {
  htmlToText,
  parseTelegramPreview,
  readChannel,
  readChannelWindow,
} from '../../src/emergency/telegram.js'
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

describe('Telegram channel preview: photos', () => {
  const chernihiv = fixture('telegram/chernigivoblenergo-5697-5704.trimmed.html')
  const zaporizhzhia = fixture('telegram/Zaporizhzhyaoblenergo_news-3604-3607.trimmed.html')
  const CDN = /^https:\/\/cdn\d+\.telesco\.pe\/file\/[\w-]+\.jpg$/

  it('lists the picture of a post with text', () => {
    const posts = parseTelegramPreview(chernihiv)
    expect(posts.map((p) => [p.id, p.photos.length])).toEqual([
      [5697, 1],
      [5698, 5],
      [5703, 1],
      [5704, 1],
    ])
    const p = posts.find((p) => p.id === 5703)!
    expect(p.at).toBe('2026-11-12T21:56:08+02:00')
    expect(p.text.length).toBeGreaterThan(20)
    expect(p.photos[0]).toMatch(CDN)
    expect(p.photos[0]).toMatch(/^https:\/\/cdn4\.telesco\.pe\/file\/IwokIjCZjQDKzH_6B9vJ1onw6RbzvBKy_/)
  })

  it('lists every picture of an album in order, and nothing that is not a photo', () => {
    const album = parseTelegramPreview(chernihiv).find((p) => p.id === 5698)!
    expect(album.photos).toHaveLength(5)
    expect(new Set(album.photos).size).toBe(5)
    for (const url of album.photos) expect(url).toMatch(CDN)
    expect(album.photos.map((u) => u.slice(29, 37))).toEqual([
      'TG9cG4d2',
      'YhiH_uza',
      'psfEyVUc',
      'cEFhPN2c',
      'DXfpsmkr',
    ])
    // avatars and reaction emoji are images too, but not the post's photos
    expect(album.photos.some((u) => u.includes('emoji'))).toBe(false)
    expect(album.text).not.toBe('')
  })

  it('gives posts without photos an empty list', () => {
    const posts = parseTelegramPreview(zaporizhzhia)
    expect(posts.map((p) => [p.id, p.photos])).toEqual([
      [3604, []],
      [3606, []],
    ])
    for (const p of parseTelegramPreview(fixture('telegram/cek_info-4315-4316.trimmed.html')))
      expect(p.photos).toEqual([])
  })

  it('drops posts without text unless asked for photo-only ones', () => {
    // the default, which the emergency readers rely on
    expect(parseTelegramPreview(zaporizhzhia).map((p) => p.id)).toEqual([3604, 3606])
    expect(parseTelegramPreview(zaporizhzhia, { withPhotoOnly: false }).map((p) => p.id)).toEqual([
      3604, 3606,
    ])
    const all = parseTelegramPreview(zaporizhzhia, { withPhotoOnly: true })
    expect(all.map((p) => p.id)).toEqual([3604, 3605, 3606, 3607])
    const bare = all.find((p) => p.id === 3605)!
    expect(bare).toMatchObject({
      channel: 'Zaporizhzhyaoblenergo_news',
      url: 'https://t.me/Zaporizhzhyaoblenergo_news/3605',
      at: '2026-11-16T05:26:26+02:00',
      text: '',
      edited: false,
    })
    expect(bare.photos).toHaveLength(1)
    expect(bare.photos[0]).toMatch(CDN)
    // posts with text come out the same either way
    expect(all.filter((p) => p.text)).toEqual(parseTelegramPreview(zaporizhzhia))
  })

  it('still drops a post with neither text nor photos', () => {
    const html = previewPage('x', [{ id: 7, at: '2026-11-05T10:00:00Z', text: '' }])
    expect(parseTelegramPreview(html, { withPhotoOnly: true })).toEqual([])
  })

  it('reads the link whatever the quoting, and decodes &amp;', () => {
    const post = (style: string) =>
      `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="x/1">` +
      `<a class="tgme_widget_message_photo_wrap" href="https://t.me/x/1" style="${style}"></a>` +
      `<time datetime="2026-11-05T10:00:00+00:00"></time></div></div>`
    const photos = (style: string) => parseTelegramPreview(post(style), { withPhotoOnly: true })[0]?.photos
    expect(photos("width:10px;background-image:url('https://cdn.test/a.jpg?x=1&amp;y=2')")).toEqual([
      'https://cdn.test/a.jpg?x=1&y=2',
    ])
    expect(photos('background-image: url(https://cdn.test/a.jpg)')).toEqual(['https://cdn.test/a.jpg'])
    expect(photos('background-image:url(&quot;https://cdn.test/a.jpg&quot;)')).toEqual([
      'https://cdn.test/a.jpg',
    ])
    // a photo wrap without a picture is no photo, so the textless post is dropped
    expect(photos('width:10px')).toBeUndefined()
  })

  it('threads withPhotoOnly through readChannel and readChannelWindow', async () => {
    const { fetch } = mockFetch([{ match: 't.me/s/Zaporizhzhyaoblenergo_news', body: zaporizhzhia }])
    const ctx = { http: new Http({ fetch }), now: () => new Date('2026-11-16T12:00:00Z') }
    const opts = { region: 'zaporizhzhia' as const, since: new Date('2026-11-15T00:00:00Z'), maxPages: 1 }
    expect((await readChannel(ctx, 'Zaporizhzhyaoblenergo_news', opts)).map((p) => p.id)).toEqual([
      3604, 3606,
    ])
    const withPhotos = await readChannelWindow(ctx, 'Zaporizhzhyaoblenergo_news', {
      ...opts,
      withPhotoOnly: true,
    })
    expect(withPhotos.posts.map((p) => p.id)).toEqual([3604, 3605, 3606, 3607])
    expect(withPhotos.posts[1]!.photos).toHaveLength(1)
    // only photo-only posts after `since` are returned, like any other
    const late = await readChannel(ctx, 'Zaporizhzhyaoblenergo_news', {
      ...opts,
      since: new Date('2026-11-16T03:30:00Z'),
      withPhotoOnly: true,
    })
    expect(late.map((p) => p.id)).toEqual([3607])
  })
})
