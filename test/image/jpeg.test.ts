import { describe, expect, it } from 'vitest'
import { decodeJpeg, isJpeg } from '../../src/image/jpeg.js'
import { decodePng } from '../../src/image/png.js'
import { fixtureBytes } from '../helpers.js'

// references decoded by libjpeg (djpeg -nosmooth: chroma repeated, as here); odd sizes exercise
// the padded edge blocks
function compare(name: string) {
  const ours = decodeJpeg(fixtureBytes(`image/sample-${name}.jpg`))
  const ref = decodePng(fixtureBytes(`image/sample-${name}.png`))
  expect([ours.width, ours.height]).toEqual([ref.width, ref.height])
  let max = 0
  for (let i = 0; i < ours.data.length; i++) max = Math.max(max, Math.abs(ours.data[i]! - ref.data[i]!))
  return max
}

describe('decodeJpeg', () => {
  it('matches libjpeg for full-resolution colour and greyscale', () => {
    expect(compare('444')).toBeLessThanOrEqual(3)
    expect(compare('grey')).toBeLessThanOrEqual(3)
  })

  it('handles chroma subsampling and restart markers', () => {
    expect(compare('420')).toBeLessThanOrEqual(3)
    expect(compare('restart')).toBeLessThanOrEqual(3)
  })

  it('rejects progressive files and non-JPEG data', () => {
    expect(() => decodeJpeg(fixtureBytes('image/sample-progressive.jpg'))).toThrow(/baseline/)
    expect(isJpeg(new Uint8Array([0x89, 0x50]))).toBe(false)
    expect(() => decodeJpeg(new Uint8Array([1, 2, 3]))).toThrow(/not a JPEG/)
  })
})
