import { describe, expect, it } from 'vitest'
import {
  compactImage,
  downscale,
  encodePng,
  jpegSize,
  trimMargins,
  upscale,
} from '../../src/image/compact.js'
import { decodeJpeg } from '../../src/image/jpeg.js'
import { decodePng } from '../../src/image/png.js'
import { fixtureBytes } from '../helpers.js'

const flat = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8Array(w * h * 4)
  for (let p = 0; p < data.length; p += 4) data.set([...rgb, 255], p)
  return { width: w, height: h, data }
}

describe('compactImage', () => {
  it('scales a big table down to the long edge, never up', () => {
    const big = compactImage(fixtureBytes('volyn/gpv-2026-10-17-1847.png'), { maxLongEdge: 1100 })
    expect(big).toMatchObject({ width: 856, height: 1100, mediaType: 'image/png', compacted: true })
    expect(decodePng(big.bytes)).toMatchObject({ width: 856, height: 1100 })
    // a Telegram preview, smaller than the edge, goes as it was
    const small = compactImage(fixtureBytes('zakarpattia/posters/10104_2026-04-10T0946.jpg'), {
      maxLongEdge: 1100,
    })
    expect(small).toMatchObject({ width: 800, height: 210, mediaType: 'image/jpeg', compacted: false })
  })

  it('blows a thin grid up by a whole factor, pixel for pixel, and leaves a poster alone', () => {
    const grid = fixtureBytes('zakarpattia/posters/10104_2026-04-10T0946.jpg')
    expect(compactImage(grid, { maxLongEdge: 1000, minShortEdge: 400 })).toMatchObject({
      width: 2400,
      height: 630,
      mediaType: 'image/png',
      compacted: true,
    })
    const poster = fixtureBytes('chernihiv/posters/tg-5650.jpg')
    expect(compactImage(poster, { maxLongEdge: 1000, minShortEdge: 400 })).toMatchObject({
      width: 471,
      height: 800,
    })
  })

  it('sends a picture the decoders cannot read as it is, with its size from the header', () => {
    const progressive = fixtureBytes('image/sample-progressive.jpg')
    const r = compactImage(progressive, { maxLongEdge: 1100 })
    expect(r.compacted).toBe(false)
    expect(r.bytes).toBe(progressive)
    expect(r.width).toBeGreaterThan(0)
    expect(jpegSize(progressive)).toEqual({ width: r.width, height: r.height })
  })

  it('refuses what is not a picture', () => {
    expect(() => compactImage(new TextEncoder().encode('<html>'), { maxLongEdge: 1100 })).toThrow(
      /not a PNG or JPEG/,
    )
  })
})

describe('trimMargins', () => {
  it('cuts a wide flat frame, keeping a small pad', () => {
    const img = flat(400, 400, [255, 255, 255])
    // a dark 200×200 block in the middle
    for (let y = 100; y < 300; y++)
      for (let x = 100; x < 300; x++) img.data.set([20, 20, 20, 255], (y * 400 + x) * 4)
    const t = trimMargins(img)
    expect(t.width).toBe(216)
    expect(t.height).toBe(216)
  })

  it('leaves a picture alone when there is little to gain', () => {
    const img = flat(400, 400, [255, 255, 255])
    for (let y = 5; y < 395; y++)
      for (let x = 5; x < 395; x++) img.data.set([20, 20, 20, 255], (y * 400 + x) * 4)
    expect(trimMargins(img)).toBe(img)
  })
})

describe('upscale', () => {
  it('copies each pixel into an f×f block, keeping cell edges sharp', () => {
    const img = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) }
    const up = upscale(img, 3, 6)
    expect(up).toMatchObject({ width: 6, height: 3 })
    const px = (x: number, y: number) => up.data[(y * 6 + x) * 4]
    expect([px(0, 0), px(2, 2), px(3, 0), px(5, 2)]).toEqual([0, 0, 255, 255])
    // never past the long edge cap
    expect(upscale({ width: 1500, height: 100, data: new Uint8Array(1500 * 100 * 4) }, 400)).toMatchObject({
      width: 1500,
    })
  })
})

describe('downscale and encodePng', () => {
  it('averages areas and round-trips through the decoder', () => {
    const img = flat(100, 50, [200, 100, 50])
    const small = downscale(img, 20)
    expect(small).toMatchObject({ width: 20, height: 10 })
    expect([...small.data.slice(0, 4)]).toEqual([200, 100, 50, 255])
    const back = decodePng(encodePng(small))
    expect([...back.data.slice(0, 3)]).toEqual([200, 100, 50])
  })

  it('writes grey pictures as 8-bit grey', () => {
    const grey = encodePng(flat(10, 10, [90, 90, 90]))
    // IHDR colour type at byte 25: 0 = grey
    expect(grey[25]).toBe(0)
    expect(encodePng(flat(10, 10, [90, 10, 90]))[25]).toBe(2)
  })

  it('reads a real JPEG poster at the same size it says', () => {
    const bytes = fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg')
    const img = decodeJpeg(bytes)
    expect(jpegSize(bytes)).toEqual({ width: img.width, height: img.height })
  })
})

describe('compactImage: review fixes', () => {
  it('a thin picture over the long edge keeps its pixels, up to 2400 px, not scaled down then up', () => {
    const wide = encodePng(flat(1280, 336, [200, 200, 200]))
    expect(compactImage(wide, { maxLongEdge: 1000, minShortEdge: 400, trim: false })).toMatchObject({
      width: 1280,
      height: 336,
    })
    const huge = encodePng(flat(3000, 300, [200, 200, 200]))
    expect(compactImage(huge, { maxLongEdge: 1000, minShortEdge: 400, trim: false })).toMatchObject({
      width: 2400,
      height: 240,
    })
  })

  it('trims by what is drawn: an opaque block on transparent black is kept whole', () => {
    const img = { width: 400, height: 400, data: new Uint8Array(400 * 400 * 4) }
    for (let y = 30; y < 370; y++)
      for (let x = 30; x < 370; x++) img.data.set([0, 0, 0, 255], (y * 400 + x) * 4)
    const t = trimMargins(img)
    expect(t.width).toBeGreaterThanOrEqual(340)
  })
})
