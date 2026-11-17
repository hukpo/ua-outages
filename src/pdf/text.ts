import { inflateSync } from 'node:zlib'
import { OutageError } from '../errors.js'

/**
 * Text out of a text PDF, as positioned runs: enough for the address lists operators export
 * from Excel, with no dependency beyond node:zlib. It reads top-level objects, FlateDecode
 * streams, the page tree, fonts with a `/ToUnicode` CMap (and WinAnsi fonts without one) and the
 * text operators of a content stream. It doesn't measure glyphs: a run is the text shown from one
 * position, not a word or a line.
 *
 * Anything it can't read with certainty is a `parse` error, never a guess: encryption, objects
 * kept in object streams, other filters, fonts with no usable mapping.
 */

export interface PdfRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PdfRun {
  /** Page coordinates of where the text starts; y grows upwards */
  x: number
  y: number
  text: string
  /** Font size as set by `Tf` */
  size: number
  /** The clipping rectangle in force. Excel clips every cell to its (merged) cell box */
  clip: PdfRect | null
}

export interface PdfPage {
  width: number
  height: number
  /** In drawing order */
  runs: PdfRun[]
}

export interface PdfDocument {
  pageCount: number
  /** Zero-based. Parsed on each call (one inflate, one pass over the content) and not kept */
  page(index: number): PdfPage
  /** `/Title` of the document information, when there is one */
  title: string | null
}

interface PdfObject {
  /** The object's source up to its stream, as Latin-1 */
  body: string
  /** Stream bytes in the file, when it has one */
  stream: { start: number; length: number } | null
}

interface Font {
  /** Bytes per character code: 2 for composite (Identity-H) fonts */
  bytes: 1 | 2
  /** null: WinAnsi */
  map: Map<number, string> | null
}

/** The most one stream may inflate to. A page of an address list is well under 1 MB */
export const MAX_STREAM_BYTES = 64 * 1024 * 1024
/** The most pages a file may have. The longest list read so far has a few hundred */
export const MAX_PAGES = 20_000

const fail = (message: string, cause?: unknown): never => {
  throw new OutageError('parse', `PDF: ${message}`, cause === undefined ? {} : { cause })
}

export function openPdf(bytes: Uint8Array): PdfDocument {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // one byte per character: offsets in the string are offsets in the file
  const src = buf.toString('latin1')
  if (!src.startsWith('%PDF-')) fail('not a PDF file')
  const objects = readObjects(src)

  const object = (ref: number): PdfObject =>
    objects.get(ref) ?? fail(`object ${ref} is not in the file body (kept in an object stream, or missing)`)
  /** A value that may be written in place or as a reference to an object holding it */
  const resolve = (value: string | null): string | null => {
    const ref = value === null ? null : refOf(value)
    return ref === null ? value : object(ref).body
  }
  const streamOf = (ref: number): Buffer => {
    const o = object(ref)
    if (!o.stream) return fail(`object ${ref} has no stream`)
    const raw = buf.subarray(o.stream.start, o.stream.start + o.stream.length)
    const filter = dictValue(o.body, 'Filter')
    if (filter === null) return raw
    if (!/^(\/FlateDecode|\[\s*\/FlateDecode\s*\])$/.test(filter) || dictValue(o.body, 'DecodeParms'))
      return fail(`object ${ref}: unsupported stream filter ${filter}`)
    try {
      return inflateSync(raw, { maxOutputLength: MAX_STREAM_BYTES })
    } catch (cause) {
      if ((cause as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE')
        return fail(`object ${ref}: stream inflates to more than ${MAX_STREAM_BYTES >> 20} MB`, cause)
      return fail(`object ${ref}: stream doesn't inflate`, cause)
    }
  }

  const root = [...objects.values()].filter((o) => /\/Type\s*\/Catalog\b/.test(o.body)).pop()
  if (!root) return fail('no document catalog in the file body (kept in an object stream?)')

  interface PageRef {
    body: string
    resources: string | null
    box: string | null
  }
  const pages: PageRef[] = []
  // a tree: a node listed twice (a loop, or `/Kids` repeating a node) multiplies the pages
  const visited = new Set<number>()
  const walk = (ref: number, resources: string | null, box: string | null, depth: number) => {
    if (depth > 32) fail('page tree too deep')
    if (visited.has(ref)) fail(`page tree lists object ${ref} twice`)
    visited.add(ref)
    if (pages.length >= MAX_PAGES) fail(`more than ${MAX_PAGES} pages`)
    const body = object(ref).body
    // both are inherited down the tree
    resources = dictValue(body, 'Resources') ?? resources
    box = dictValue(body, 'MediaBox') ?? box
    const kids = dictValue(body, 'Kids')
    if (kids === null) return void pages.push({ body, resources, box })
    for (const m of (resolve(kids) ?? '').matchAll(/(\d+)\s+\d+\s+R/g))
      walk(Number(m[1]), resources, box, depth + 1)
  }
  const pagesRef = refOf(dictValue(root.body, 'Pages') ?? '')
  if (pagesRef === null) return fail('the catalog has no page tree')
  walk(pagesRef, null, null, 0)

  const fonts = new Map<number, Font>()
  const fontOf = (ref: number): Font => {
    let f = fonts.get(ref)
    if (f) return f
    const body = object(ref).body
    const composite = /\/Subtype\s*\/Type0\b/.test(body)
    const encoding = dictValue(body, 'Encoding')
    const toUnicode = refOf(dictValue(body, 'ToUnicode') ?? '')
    if (composite && encoding !== '/Identity-H') fail(`font ${ref}: unsupported encoding ${encoding}`)
    if (toUnicode !== null)
      f = { bytes: composite ? 2 : 1, map: parseCMap(streamOf(toUnicode).toString('latin1')) }
    else if (!composite && (encoding === '/WinAnsiEncoding' || encoding === null)) f = { bytes: 1, map: null }
    else return fail(`font ${ref}: no /ToUnicode map and not WinAnsi`)
    fonts.set(ref, f)
    return f
  }

  return {
    pageCount: pages.length,
    title: infoTitle(src, objects),
    page(index) {
      const p = pages[index]
      if (!p) return fail(`no page ${index + 1}`)
      const fontDict = resolve(dictValue(resolve(p.resources) ?? '', 'Font')) ?? ''
      const fontRefs = new Map<string, number>()
      for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g))
        fontRefs.set(m[1]!, Number(m[2]))
      const contents = [...(dictValue(p.body, 'Contents') ?? '').matchAll(/(\d+)\s+\d+\s+R/g)].map((m) =>
        streamOf(Number(m[1])).toString('latin1'),
      )
      const box = (p.box ?? '').match(/-?[\d.]+/g)?.map(Number) ?? []
      return {
        width: (box[2] ?? 0) - (box[0] ?? 0),
        height: (box[3] ?? 0) - (box[1] ?? 0),
        runs: readContent(contents.join('\n'), (name) => {
          const ref = fontRefs.get(name)
          return ref === undefined ? fail(`page ${index + 1}: unknown font /${name}`) : fontOf(ref)
        }),
      }
    },
  }
}

// --- file structure ---

/**
 * Objects in file order, later definitions (incremental updates) replacing earlier ones. Streams
 * are stepped over by their `/Length`, so bytes that look like "12 0 obj" inside one don't count.
 */
function readObjects(src: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const head = /(\d+)\s+(\d+)\s+obj\b/g
  let at = 0
  for (;;) {
    head.lastIndex = at
    const m = head.exec(src)
    if (!m) break
    // between objects: cross-reference tables and trailers
    if (src.slice(at, m.index).includes('/Encrypt')) fail('the file is encrypted')
    const start = head.lastIndex
    let end = src.indexOf('endobj', start)
    if (end === -1) fail(`object ${m[1]} has no end`)
    const streamAt = /stream\r?\n/g
    streamAt.lastIndex = start
    const s = streamAt.exec(src)
    let stream: PdfObject['stream'] = null
    let bodyEnd = end
    if (s && s.index < end && /^\s*<<[\s\S]*>>\s*$/.test(src.slice(start, s.index))) {
      bodyEnd = s.index
      const body = src.slice(start, bodyEnd)
      const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body)
      let streamEnd = length ? streamAt.lastIndex + Number(length[1]) : -1
      // an indirect or wrong length: the stream runs to the next "endstream"
      if (streamEnd === -1 || !/^\s*endstream/.test(src.slice(streamEnd, streamEnd + 16)))
        streamEnd = src.indexOf('endstream', streamAt.lastIndex)
      if (streamEnd === -1) fail(`object ${m[1]}: stream has no end`)
      stream = { start: streamAt.lastIndex, length: streamEnd - streamAt.lastIndex }
      end = src.indexOf('endobj', streamEnd)
      if (end === -1) fail(`object ${m[1]} has no end`)
    }
    const body = src.slice(start, bodyEnd)
    // the trailer of a file with cross-reference streams
    if (/\/Type\s*\/XRef\b/.test(body) && body.includes('/Encrypt')) fail('the file is encrypted')
    objects.set(Number(m[1]), { body, stream })
    at = end + 6
  }
  if (src.slice(at).includes('/Encrypt')) fail('the file is encrypted')
  if (!objects.size) fail('no objects')
  return objects
}

const refOf = (value: string): number | null => {
  const m = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(value)
  return m ? Number(m[1]) : null
}

/**
 * Raw text of a key's value in the outermost dictionary of `body`: "<<…>>", "[…]", "(…)",
 * "12 0 R" or one token. null when the key isn't there.
 */
function dictValue(body: string, key: string): string | null {
  const open = body.indexOf('<<')
  if (open === -1) return null
  let i = open + 2
  let depth = 0
  const skip = (): string => {
    const from = i
    const c = body[i]
    if (c === '(') {
      for (let nest = 0; i < body.length; i++) {
        if (body[i] === '\\') i++
        else if (body[i] === '(') nest++
        else if (body[i] === ')' && --nest === 0) break
      }
      i++
    } else if (c === '<' && body[i + 1] !== '<') {
      i = body.indexOf('>', i) + 1 || body.length
    } else if (c === '[' || c === '<') {
      const [o, cl] = c === '[' ? ['[', ']'] : ['<<', '>>']
      let nest = 0
      while (i < body.length) {
        if (body[i] === '(' || (body[i] === '<' && body[i + 1] !== '<' && o === '[')) skip()
        else if (body.startsWith(o, i)) (nest++, (i += o.length))
        else if (body.startsWith(cl, i)) {
          i += cl.length
          if (--nest === 0) break
        } else i++
      }
    } else {
      i++
      while (i < body.length && !/[\s/<>[\]()]/.test(body[i]!)) i++
      // "12 0 R"
      const ref = /^\s+\d+\s+R\b/.exec(body.slice(i, i + 24))
      if (ref && /^\d+$/.test(body.slice(from, i))) i += ref[0].length
    }
    return body.slice(from, i)
  }
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++
    if (body.startsWith('>>', i)) {
      if (depth-- === 0) return null
      i += 2
      continue
    }
    if (body[i] !== '/') {
      skip()
      continue
    }
    const name = skip().slice(1)
    while (i < body.length && /\s/.test(body[i]!)) i++
    if (body.startsWith('>>', i)) continue
    const value = skip()
    if (name === key) return value
  }
  return null
}

function infoTitle(src: string, objects: Map<number, PdfObject>): string | null {
  // the last trailer (or cross-reference stream) names the current information dictionary
  const refs = [...src.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)]
  const info = objects.get(Number(refs.at(-1)?.[1] ?? NaN))
  const raw = info && dictValue(info.body, 'Title')
  if (!raw) return null
  let bytes: string
  if (raw.startsWith('(')) bytes = literalString(raw, 1).bytes
  else if (raw.startsWith('<')) bytes = hexString(raw.slice(1, -1))
  else return null
  if (bytes.startsWith('\xFE\xFF')) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1))
    return out
  }
  if (bytes.startsWith('\xEF\xBB\xBF')) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8')
  return winAnsi(bytes)
}

// --- fonts ---

/** A `/ToUnicode` CMap: character code → text. Exported for tests. */
export function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>()
  const utf16 = (hex: string) => {
    let out = ''
    for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return out
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))
      map.set(parseInt(m[1]!, 16), utf16(m[2]!))
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1]!.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g,
    )) {
      const from = parseInt(m[1]!, 16)
      const to = parseInt(m[2]!, 16)
      if (to < from || to - from > 0xffff) fail('bad range in a /ToUnicode map')
      if (m[3] !== undefined) {
        // <from> <to> <first>: consecutive, counting up in the last UTF-16 unit
        const first = utf16(m[3])
        const last = first.charCodeAt(first.length - 1)
        for (let c = from; c <= to; c++)
          map.set(c, first.slice(0, -1) + String.fromCharCode(last + (c - from)))
      } else {
        // <from> <to> [<a> <b> …]: one entry per code
        const list = [...m[4]!.matchAll(/<([0-9A-Fa-f]+)>/g)]
        for (let c = from; c <= to && c - from < list.length; c++) map.set(c, utf16(list[c - from]![1]!))
      }
    }
  return map
}

/** Windows-1252 where it differs from Latin-1 (0x80–0x9F) */
const CP1252 = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�' + '�‘’“”•–—˜™š›œ�žŸ'

const winAnsi = (bytes: string) => bytes.replace(/[\x80-\x9F]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]!)

/** A string operand's bytes → text. A code the font's map lacks becomes U+FFFD. */
function decode(bytes: string, font: Font): string {
  if (!font.map) return winAnsi(bytes)
  let out = ''
  if (font.bytes === 1) for (let i = 0; i < bytes.length; i++) out += font.map.get(bytes.charCodeAt(i)) ?? '�'
  else
    for (let i = 0; i + 1 < bytes.length; i += 2)
      out += font.map.get((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1)) ?? '�'
  return out
}

// --- strings ---

/** "(…)" starting at `at` (just past the bracket) → its bytes and where it ends */
function literalString(s: string, at: number): { bytes: string; end: number } {
  let out = ''
  let nest = 1
  let i = at
  for (; i < s.length; i++) {
    const c = s[i]!
    if (c === '\\') {
      const n = s[++i]
      if (n === undefined) break
      const oct = /^[0-7]{1,3}/.exec(s.slice(i, i + 3))
      if (oct) {
        out += String.fromCharCode(parseInt(oct[0], 8) & 0xff)
        i += oct[0].length - 1
      } else if (n === '\r') {
        if (s[i + 1] === '\n') i++
      } else if (n !== '\n') out += ESCAPES[n] ?? n
    } else if (c === '(') {
      nest++
      out += c
    } else if (c === ')') {
      if (--nest === 0) return { bytes: out, end: i + 1 }
      out += c
    } else out += c
  }
  return fail('unterminated string')
}
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

function hexString(hex: string): string {
  const h = hex.replace(/\s+/g, '')
  if (/[^0-9A-Fa-f]/.test(h)) fail('bad hex string')
  let out = ''
  for (let i = 0; i < h.length; i += 2)
    out += String.fromCharCode(parseInt(h.slice(i, i + 2).padEnd(2, '0'), 16))
  return out
}

// --- content streams ---

type Matrix = [number, number, number, number, number, number]
/** `a` applied first, then `b` */
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

type Operand = number | string | { bytes: string } | Operand[]

function readContent(s: string, fontOf: (name: string) => Font): PdfRun[] {
  const runs: PdfRun[] = []
  const stack: { ctm: Matrix; clip: PdfRect | null }[] = []
  let ctm = IDENTITY
  let clip: PdfRect | null = null
  let rect: PdfRect | null = null
  let font: Font | null = null
  let size = 0
  let leading = 0
  let line = IDENTITY
  let run: PdfRun | null = null

  const moveTo = (m: Matrix) => {
    line = m
    run = null
  }
  const show = (bytes: string) => {
    if (!font) return fail('text shown before a font is set')
    const text = decode(bytes, font)
    if (!text) return
    if (run) return void (run.text += text)
    const at = mul(line, ctm)
    run = { x: at[4], y: at[5], text, size, clip }
    runs.push(run)
  }

  let ops: Operand[] = []
  const num = (i: number): number => {
    const v = ops[ops.length + i]
    return typeof v === 'number' ? v : fail('operand is not a number')
  }
  const str = (v: Operand | undefined): string =>
    typeof v === 'object' && !Array.isArray(v) ? v.bytes : fail('operand is not a string')

  const operator = (op: string) => {
    switch (op) {
      case 'q':
        stack.push({ ctm, clip })
        break
      case 'Q': {
        const top = stack.pop()
        if (top) ({ ctm, clip } = top)
        break
      }
      case 'cm':
        ctm = mul([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)], ctm)
        break
      case 're': {
        // corners through the matrix; cells are axis-aligned
        const a = mul([1, 0, 0, 1, num(-4), num(-3)], ctm)
        const b = mul([1, 0, 0, 1, num(-4) + num(-2), num(-3) + num(-1)], ctm)
        rect = {
          x: Math.min(a[4], b[4]),
          y: Math.min(a[5], b[5]),
          w: Math.abs(b[4] - a[4]),
          h: Math.abs(b[5] - a[5]),
        }
        break
      }
      case 'W':
      case 'W*':
        // only a lone rectangle is a cell box; any other path leaves the clip unknown
        clip = rect
        break
      case 'm':
      case 'l':
      case 'c':
      case 'v':
      case 'y':
        rect = null
        break
      case 'BT':
        moveTo(IDENTITY)
        break
      case 'ET':
        run = null
        break
      case 'Tf': {
        const name = ops[ops.length - 2]
        if (typeof name !== 'string') return fail('Tf without a font name')
        font = fontOf(name.slice(1))
        size = num(-1)
        break
      }
      case 'TL':
        leading = num(-1)
        break
      case 'Tm':
        moveTo([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)])
        break
      case 'Td':
        moveTo(mul([1, 0, 0, 1, num(-2), num(-1)], line))
        break
      case 'TD':
        leading = -num(-1)
        moveTo(mul([1, 0, 0, 1, num(-2), num(-1)], line))
        break
      case 'T*':
        moveTo(mul([1, 0, 0, 1, 0, -leading], line))
        break
      case 'Tj':
        show(str(ops.at(-1)))
        break
      case "'":
      case '"':
        moveTo(mul([1, 0, 0, 1, 0, -leading], line))
        show(str(ops.at(-1)))
        break
      case 'TJ': {
        const list = ops.at(-1)
        if (!Array.isArray(list)) return fail('TJ without an array')
        // numbers are kerning; Excel writes spaces as characters
        show(list.map((v) => (typeof v === 'number' ? '' : str(v))).join(''))
        break
      }
      case 'BI':
        return fail('inline image in a content stream')
    }
    ops = []
  }

  // tokens
  const arrays: Operand[][] = []
  const push = (v: Operand) => void (arrays.length ? arrays.at(-1)! : ops).push(v)
  const DELIM = /[\s/<>[\]()%]/
  for (let i = 0; i < s.length;) {
    const c = s[i]!
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') i++
    else if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++
    } else if (c === '(') {
      const lit = literalString(s, i + 1)
      push({ bytes: lit.bytes })
      i = lit.end
    } else if (c === '<' && s[i + 1] === '<') {
      // a property dictionary (marked content): no use here
      let nest = 0
      for (; i < s.length; i++) {
        if (s.startsWith('<<', i)) (nest++, i++)
        else if (s.startsWith('>>', i)) {
          i++
          if (--nest === 0) break
        } else if (s[i] === '(') i = literalString(s, i + 1).end - 1
      }
      i++
      push('<<>>')
    } else if (c === '<') {
      const end = s.indexOf('>', i)
      if (end === -1) return fail('unterminated hex string')
      push({ bytes: hexString(s.slice(i + 1, end)) })
      i = end + 1
    } else if (c === '[') {
      arrays.push([])
      i++
    } else if (c === ']') {
      const done = arrays.pop()
      if (!done) return fail('stray "]" in a content stream')
      push(done)
      i++
    } else if (c === '>' || c === ')') {
      return fail(`stray "${c}" in a content stream`)
    } else {
      let j = i + 1
      while (j < s.length && !DELIM.test(s[j]!)) j++
      const word = s.slice(i, j)
      i = j
      if (c === '/') push(word)
      else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(Number(word))
      else if (arrays.length) push(word)
      else operator(word)
    }
  }
  return runs
}
