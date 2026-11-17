import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { OutageError } from '../../src/errors.js'
import { openPdf, parseCMap } from '../../src/pdf/text.js'
import { fixtureBytes } from '../helpers.js'

// Rivneoblenergo's list for the city, as Excel 2013 printed it: both pages' content, the font
// dictionaries and their /ToUnicode maps; the embedded font programs (600 KB) are cut out
const CITY = fixtureBytes('rivne/address/GPV_cherga_misto_Rivne-1.trimmed.pdf')
const OBLAST = fixtureBytes('rivne/address/GPV_cherga_Rivnenska_oblast-1.pages-1-16-19-20.pdf')

const latin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
const patch = (bytes: Uint8Array, from: string, to: string) => {
  const s = Buffer.from(bytes).toString('latin1')
  expect(s).toContain(from)
  return latin1(s.replace(from, to))
}

/** A one-page file around a content stream, with a WinAnsi font /F1 and a mapped font /F2 */
function tiny(content: string, opts: { compress?: boolean; trailer?: string; filter?: string } = {}) {
  const cmap = 'beginbfchar\n<0001> <0416>\n<0002> <0456>\nendbfchar'
  const body = opts.compress ? deflateSync(Buffer.from(content, 'latin1')).toString('latin1') : content
  const filter = opts.filter ?? (opts.compress ? '/Filter/FlateDecode' : '')
  return latin1(
    [
      '%PDF-1.5',
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj',
      '2 0 obj\n<</Type/Pages/Count 1/Kids[ 3 0 R] /MediaBox[ 0 0 200 100] >>\nendobj',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>\nendobj',
      `4 0 obj\n<<${filter}/Length ${body.length}>>\nstream\r\n${body}\r\nendstream\nendobj`,
      '5 0 obj\n<</Type/Font/Subtype/TrueType/BaseFont/Calibri/Encoding/WinAnsiEncoding>>\nendobj',
      '6 0 obj\n<</Type/Font/Subtype/Type0/BaseFont/Calibri/Encoding/Identity-H/ToUnicode 7 0 R>>\nendobj',
      `7 0 obj\n<</Length ${cmap.length}>>\nstream\r\n${cmap}\r\nendstream\nendobj`,
      `trailer\n<</Size 8/Root 1 0 R${opts.trailer ?? ''}>>\n%%EOF\n`,
    ].join('\n'),
  )
}

const parseError = (fn: () => unknown, message: RegExp) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(OutageError)
    expect((e as OutageError).code).toBe('parse')
    expect((e as OutageError).message).toMatch(message)
    return
  }
  throw new Error('expected a parse error')
}

describe('PDF text', () => {
  it('reads the pages of an Excel export: Cyrillic through /ToUnicode, digits through WinAnsi', () => {
    const doc = openPdf(CITY)
    expect(doc.pageCount).toBe(2)
    const page = doc.page(0)
    expect([page.width, page.height]).toEqual([595.2, 841.68])
    const texts = page.runs.map((r) => r.text)
    expect(texts).toContain('Назви вулиць та номери будинків в м.Рівне')
    expect(texts).toContain('вул.Соборна 5а')
    // no code was left without a character
    for (const p of [page, doc.page(1)]) expect(p.runs.some((r) => r.text.includes('�'))).toBe(false)
    // the group column is set in a font with no /ToUnicode
    const groups = page.runs.filter((r) => r.x > 480 && /^\d,\d$/.test(r.text))
    expect(groups.length).toBeGreaterThan(40)
    expect(new Set(groups.map((r) => Math.round(r.x)))).toEqual(new Set([488]))
  })

  it('places each run and gives the cell box it is clipped to', () => {
    const run = openPdf(CITY)
      .page(0)
      .runs.find((r) => r.text.startsWith('вул.Соборна 205,304'))!
    expect(Math.round(run.x)).toBe(74)
    expect(Math.round(run.y)).toBe(675)
    expect(run.size).toBeCloseTo(6.72)
    // row 8 is four lines high: its cell is 422.8 × 32.9 pt
    expect(run.clip).toMatchObject({ x: expect.closeTo(56.7, 0), w: expect.closeTo(422.8, 0) })
    expect(run.clip!.h).toBeCloseTo(32.9, 0)
    // lines of one cell: same box, y going down
    const next = openPdf(CITY)
      .page(0)
      .runs.find((r) => r.text.startsWith('Дорошенка 3,5, 2-16'))!
    expect(next.clip).toEqual(run.clip)
    expect(next.y).toBeLessThan(run.y)
  })

  it('reads the title and a landscape page', () => {
    const doc = openPdf(OBLAST)
    expect(doc.title).toBe('Графік відключень;')
    expect(doc.pageCount).toBe(4)
    expect(doc.page(0).width).toBeGreaterThan(doc.page(0).height)
    expect(openPdf(CITY).title).toBeNull()
  })

  it('reads both forms of bfrange and bfchar', () => {
    const map = parseCMap(
      [
        '2 beginbfchar\n<0003> <0020>\n<02BB> <0410>\nendbfchar',
        '2 beginbfrange\n<0310> <0312> <0430>\n<0320> <0322> [<0456> <0457> <00660066>]\nendbfrange',
      ].join('\n'),
    )
    expect(map.get(3)).toBe(' ')
    expect(map.get(0x2bb)).toBe('А')
    expect([0x310, 0x311, 0x312].map((c) => map.get(c))).toEqual(['а', 'б', 'в'])
    expect([0x320, 0x321, 0x322].map((c) => map.get(c))).toEqual(['і', 'ї', 'ff'])
    expect(map.get(0x313)).toBeUndefined()
  })

  it('follows the text operators and string escapes', () => {
    const content = [
      'BT /F1 10 Tf 1 0 0 1 20 80 Tm (a\\(b\\)\\\\ \\226 \\053) Tj ET',
      'BT 12 TL 1 0 0 1 20 60 Tm [(Ki) -20 (ev)] TJ T* (next) Tj 5 -3 Td <41 42> Tj ET',
      'BT /F2 8 Tf 1 0 0 1 100 40 Tm <00010002> Tj (\\000\\001) Tj ET',
      'q 2 0 0 2 10 10 cm 5 5 30 10 re W n BT /F1 10 Tf 1 0 0 1 7 6 Tm (in) Tj ET Q',
      'BT /F1 10 Tf 1 0 0 1 1 1 Tm (out) Tj ET',
    ].join('\n')
    for (const compress of [false, true]) {
      const { runs } = openPdf(tiny(content, { compress })).page(0)
      expect(runs.map((r) => [r.x, r.y, r.text])).toEqual([
        // an octal escape of cp1252's en dash, and "+"
        [20, 80, 'a(b)\\ – +'],
        [20, 60, 'Kiev'],
        [20, 48, 'next'],
        [25, 45, 'AB'],
        [100, 40, 'ЖіЖ'],
        // through the page's matrix: (7, 6) doubled and moved by (10, 10)
        [24, 22, 'in'],
        [1, 1, 'out'],
      ])
      expect(runs[5]!.clip).toEqual({ x: 20, y: 20, w: 60, h: 20 })
      expect(runs[6]!.clip).toBeNull()
      expect(runs[4]!.size).toBe(8)
    }
  })

  it('marks a code its font has no character for, so a caller can refuse the page', () => {
    const { runs } = openPdf(tiny('BT /F2 8 Tf 1 0 0 1 0 0 Tm <00010009> Tj ET')).page(0)
    expect(runs[0]!.text).toBe('Ж�')
  })

  it('refuses what it cannot read', () => {
    parseError(() => openPdf(latin1('<html>not here</html>')), /not a PDF/)
    parseError(() => openPdf(tiny('', { trailer: '/Encrypt 9 0 R' })), /encrypted/)
    parseError(() => openPdf(patch(CITY, 'trailer\n<<', 'trailer\n<</Encrypt 30 0 R')), /encrypted/)
    parseError(
      () => openPdf(tiny('BT ET', { filter: '/Filter/LZWDecode' })).page(0),
      /unsupported stream filter/,
    )
    parseError(() => openPdf(tiny('BT ET', { filter: '/Filter/FlateDecode' })).page(0), /doesn't inflate/)
    parseError(() => openPdf(tiny('BT /F9 8 Tf (x) Tj ET')).page(0), /unknown font/)
    parseError(() => openPdf(tiny('BT (x) Tj ET')).page(0), /before a font/)
    parseError(() => openPdf(tiny('BT /F1 8 Tf (x Tj ET')).page(0), /unterminated/)
    parseError(() => openPdf(CITY).page(2), /no page 3/)
    // a composite font without a map: its codes mean nothing
    parseError(
      () => openPdf(patch(tiny('BT /F2 8 Tf <0001> Tj ET'), '/ToUnicode 7 0 R', '')).page(0),
      /no \/ToUnicode/,
    )
    // the catalog kept in an object stream
    parseError(
      () => openPdf(patch(tiny(''), '<</Type/Catalog/Pages 2 0 R>>', '<</Type/ObjStm>>')),
      /no document catalog/,
    )
  })
})
