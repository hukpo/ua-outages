import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postRegion } from '../src/ai/regions.js'
import { AiRuntime } from '../src/ai/runtime.js'
import type { ImageInput, ImageReading } from '../src/ai/types.js'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import { DEFAULT_MAX_BODY_BYTES, Http, type FetchLike } from '../src/http.js'
import { BodyTooLarge, httpsFetchWithCa } from '../src/https-fetch.js'
import { decodeJpeg } from '../src/image/jpeg.js'
import { decodePng, MAX_IMAGE_PIXELS, type RgbaImage } from '../src/image/png.js'
import { MAX_PAGES, openPdf } from '../src/pdf/text.js'
import { gpvCellsToSlots, parseGpvDays } from '../src/providers/gpv.js'
import { archivePictures, readSitePictures } from '../src/providers/image-schedule.js'
import { STANDARD_GROUPS } from '../src/schedule.js'
import { mykolaivProvider, parseActive } from '../src/providers/mykolaiv.js'
import { parseGpvFragment, poltavaProvider } from '../src/providers/poltava.js'
import { powerOnAddressSearch, type PowerOnBuilding } from '../src/providers/poweron.js'
import type { ProviderContext } from '../src/providers/provider.js'
import { parseDisconnections } from '../src/providers/rivne.js'
import { parseUzPage } from '../src/providers/uz.js'
import { volynProvider } from '../src/providers/volyn.js'
import { addSheet, type ZoeDirectory } from '../src/providers/zaporizhzhia-addresses.js'
import { zaporizhzhiaProvider } from '../src/providers/zaporizhzhia.js'
import { zhytomyrProvider } from '../src/providers/zhytomyr.js'
import type { ProviderInfo, Street } from '../src/types.js'
import { expectUnpublished, fakeImage, fixture, fixtureBytes, intervalsOf, mockFetch } from './helpers.js'

// Regressions for the robustness and parsing defects an independent review of 0.4.3 found.
// The rule they share: input the SDK does not understand is an error or `unknown`, never a
// plausible schedule and never "power on".

const parse = expect.objectContaining({ code: 'parse' })
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000

afterEach(() => vi.restoreAllMocks())

describe('Poltava: a cell or a page that is not understood', () => {
  const NOW = new Date('2026-11-05T23:40:00+02:00')
  const html = fixture('poltava/dynamicgpv-info-2026-11-05.trimmed.html')

  it('reports a cell state nobody has seen instead of reading it as power on', () => {
    expect(() => parseGpvFragment(html.replace(/gpv-s[123]\b/g, 'gpv-s4'), NOW)).toThrow(parse)
    expect(() => parseGpvFragment(html.replace('gpv-c gpv-s2', 'gpv-c gpv-s9'), NOW)).toThrow(/gpv-s9/)
  })

  it('reports a cell with no state at all', () => {
    expect(() => parseGpvFragment(html.replace('gpv-c gpv-s1"', 'gpv-c gpv-past"'), NOW)).toThrow(parse)
    expect(() => parseGpvFragment(html.replace('class="gpv-c gpv-s1"', 'class="gpv-c"'), NOW)).toThrow(parse)
  })

  it('lists the twelve groups as unknown when the page has no day block', () => {
    expectUnpublished(parseGpvFragment('<p>Відключення не застосовуються</p>', NOW), 12)
    expectUnpublished(parseGpvFragment('', NOW), 12)
    // day blocks without a table in any of them
    const bare = html.replace(/<table[^>]*class="gpv-table"[\s\S]*?<\/table>/g, '')
    expectUnpublished(parseGpvFragment(bare, NOW), 12)
  })
})

describe('Mykolaiv: a row that is not understood', () => {
  const NOW = new Date('2026-11-05T23:30:00+02:00')
  const slots = JSON.parse(fixture('mykolaiv/time-series.json'))
  const queues = JSON.parse(fixture('mykolaiv/outage-queue-by-type-3.json'))
  const active = () => JSON.parse(fixture('mykolaiv/schedule-active-2026-11-05.json'))
  const queueId = (name: string) => queues.find((q: { name: string }) => q.name.trim() === name).id

  it('reports an unknown slot type instead of dropping the row', () => {
    const days = active()
    days[0].series.find((r: { type: string }) => r.type === 'OFF').type = 'LIKELY_OFF'
    expect(() => parseActive(slots, queues, days, NOW)).toThrow(/LIKELY_OFF/)
    expect(() => parseActive(slots, queues, days, NOW)).toThrow(parse)
  })

  it('reports a row for a time slot that is not in the list', () => {
    const days = active()
    days[0].series.find((r: { type: string }) => r.type === 'OFF').time_series_id = 4711
    expect(() => parseActive(slots, queues, days, NOW)).toThrow(parse)
  })

  it('reads ENABLE, the type the operator shows for power, as no outage', () => {
    const days = active()
    const before = parseActive(slots, queues, active(), NOW)
    // one more row, for a slot of 2.2 that has none: nothing changes
    days[0].series.push({ time_series_id: 1, outage_queue_id: queueId('2.2'), type: 'ENABLE' })
    expect(parseActive(slots, queues, days, NOW).schedules['2.2']).toEqual(before.schedules['2.2'])
  })

  it('leaves the rows of other schedules (ГАВ queues) alone', () => {
    const days = active()
    days[0].series.push({ time_series_id: 1, outage_queue_id: 99_999, type: 'SOMETHING_ELSE' })
    expect(parseActive(slots, queues, days, NOW).groups).toHaveLength(12)
  })
})

describe('Rivne: a date cell that is not exactly DD.MM.YYYY', () => {
  const NOW = new Date('2026-11-05T12:00:00+02:00')
  const html = fixture('rivne/disconnections.current-2026-11-05.fragment.html')
  const dates = [...html.matchAll(/>(\d{2}\.\d{2}\.\d{4})<\/span>/g)].map((m) => m[1]!)

  it('reads a date with a weekday after it like the bare date', () => {
    expect(dates.length).toBeGreaterThan(0)
    const plain = parseDisconnections(html, NOW)
    const noted = parseDisconnections(html.replace(/>(\d{2}\.\d{2}\.\d{4})<\/span>/g, '>$1 (вт)</span>'), NOW)
    expect(noted.groups).toHaveLength(12)
    expect(noted.schedules).toEqual(plain.schedules)
  })

  it('reports a row it cannot date instead of returning no groups', () => {
    const odd = html.replace(/>(\d{2})\.(\d{2})\.(\d{4})<\/span>/g, '>$1 листопада $3</span>')
    expect(() => parseDisconnections(odd, NOW)).toThrow(parse)
    const impossible = html.replace(/>\d{2}\.\d{2}\.(\d{4})<\/span>/g, '>31.02.$1</span>')
    expect(() => parseDisconnections(impossible, NOW)).toThrow(/not a date/)
    const wordy = html.replace(/>\d{2}\.\d{2}\.\d{4}<\/span>/g, '>сьогодні</span>')
    expect(() => parseDisconnections(wordy, NOW)).toThrow(parse)
  })

  it('lists the header groups as unknown when no row is under the header', () => {
    const start = html.indexOf('id="fetched-data-container"')
    const rows = [...html.slice(start).matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)]
    // everything after the "Підчерга" row is cut
    const header = rows.find((r) => r[0].includes('Підчерга'))!
    const cut = html.slice(0, start + header.index + header[0].length) + '</tbody></table>'
    expectUnpublished(parseDisconnections(cut, NOW), 12)
  })
})

describe('GPV: a day that is not a full grid', () => {
  const midnight = String(Date.parse('2026-11-15T00:00:00+02:00') / 1000)
  const full = (n: number, over: Record<string, string> = {}) => ({
    ...Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 'yes'])),
    ...over,
  })
  const read = (cells: Record<string, string>) =>
    parseGpvDays('dnipro', { [midnight]: { 'GPV1.1': cells } })['1.1']![0]!

  it('reports two cells keyed 1 and 48 instead of a day without outages', () => {
    expect(() => read({ '1': 'yes', '48': 'no' })).toThrow(parse)
    expect(() => gpvCellsToSlots({ '1': 'yes', '48': 'no' })).toThrow(/24- or 48-cell/)
  })

  it('reports a missing cell, an extra one and a key outside the day', () => {
    const missing = full(24)
    delete (missing as Record<string, string>)['7']
    expect(() => read(missing)).toThrow(parse)
    expect(() => read(full(25))).toThrow(parse)
    const shifted = full(24)
    delete (shifted as Record<string, string>)['24']
    expect(() => read({ ...shifted, '0': 'no' })).toThrow(parse)
    expect(() => read({ ...shifted, '01': 'no' })).toThrow(parse)
  })

  it('still reads hourly and half-hourly days, the last half hour included', () => {
    expect(read(full(24, { '24': 'no' })).intervals).toEqual([
      { from: '2026-11-15T23:00:00+02:00', to: '2026-11-16T00:00:00+02:00', kind: 'off' },
    ])
    expect(read(full(48, { '48': 'no' })).intervals).toEqual([
      { from: '2026-11-15T23:30:00+02:00', to: '2026-11-16T00:00:00+02:00', kind: 'off' },
    ])
    expect(read(full(24))).toMatchObject({ status: 'scheduled', intervals: [] })
  })
})

describe('Railway: a cell that is not fully understood', () => {
  const NOW = new Date('2026-11-08T14:00:00+02:00')
  const spans = (cell: string, second = 'Без ГПВ') =>
    `<p>Споживачі, приєднані до мереж</p><p>8 листопада</p><table>
      <tr><td>Години відключення</td><td>00-00 12-00</td><td>12-00 24-00</td></tr>
      <tr><td>№ черги ГПВ (підчерги)</td><td>${cell}</td><td>${second}</td></tr>
    </table><p>Перелік адрес</p>`
  const off = (html: string) => {
    const s = parseUzPage(html, NOW, 'uz-kyiv')
    return s.groups.filter((g) => s.schedules[g]![0]!.intervals.length)
  }

  it('reads the lists it knows', () => {
    expect(off(spans('3(1,2) 4(2)\n\n 6'))).toEqual(['3.1', '3.2', '4.2', '6.1', '6.2'])
    expect(off(spans('1 ( 1 , 2 )', 'Без застосування ГПВ'))).toEqual(['1.1', '1.2'])
    expect(off(spans('-', '5(1)'))).toEqual(['5.1'])
  })

  it('lists a queue whose bracket cannot be read as unknown, and reads the others', () => {
    // each of these used to switch off a subqueue by guess; "1(,2)" stood on the Poltava page on 17.11.2026
    for (const cell of ['3(1.2)', '3(1;2)', '3(,2)', '3(1,2,3)', '3(3)', '3()']) {
      const s = parseUzPage(spans(`${cell} 5(1)`, '4(2)'), NOW, 'uz-kyiv')
      const day = (g: string) => s.schedules[g]![0]!
      expect(day('3.1'), cell).toEqual({ date: '2026-11-08', status: 'unknown', intervals: [] })
      expect(day('3.2'), cell).toEqual({ date: '2026-11-08', status: 'unknown', intervals: [] })
      expect(day('5.1').intervals, cell).toHaveLength(1)
      expect(day('4.2').intervals, cell).toHaveLength(1)
      expect(day('1.1'), cell).toMatchObject({ status: 'scheduled', intervals: [] })
    }
    // unknown wins over a span where the same queue is written clearly
    const mixed = parseUzPage(spans('3(1.2)', '3(1)'), NOW, 'uz-kyiv')
    expect(mixed.schedules['3.1']![0]).toMatchObject({ status: 'unknown', intervals: [] })
  })

  it('reports a cell it cannot read as queues at all', () => {
    for (const cell of ['1.1, 2.1', '3(1,2', '7(1)', '3(1,2) та 4', '3(1)(2)', '12', 'черга 3'])
      expect(() => parseUzPage(spans(cell), NOW, 'uz-kyiv'), cell).toThrow(parse)
  })

  it('reports a queue cell without its time span, and a span without its cell', () => {
    const html = spans('1(1)').replace('<td>Без ГПВ</td>', '')
    expect(() => parseUzPage(html, NOW, 'uz-kyiv')).toThrow(parse)
  })

  const columns = (times: string) =>
    `<p>Споживачі, приєднані до мереж</p><p>8 листопада</p><table>
      <tr><td>1:1: черга</td><td>1:2: черга</td></tr>${times}
    </table><p>Перелік адрес</p>`

  it('reports a table of queues with no times row instead of a day without outages', () => {
    expect(() => parseUzPage(columns(''), NOW, 'uz-dnipro')).toThrow(parse)
    expect(() => parseUzPage(columns('<tr><td></td><td></td></tr>'), NOW, 'uz-dnipro')).toThrow(parse)
    expect(() => parseUzPage(columns('<tr><td>03.30-07.00</td></tr>'), NOW, 'uz-dnipro')).toThrow(parse)
  })

  it('reports times it cannot read whole, and reads a dash as no outage', () => {
    expect(() =>
      parseUzPage(columns('<tr><td>03.30-07.00</td><td>після 18</td></tr>'), NOW, 'uz-dnipro'),
    ).toThrow(parse)
    expect(off(columns('<tr><td>03.30-07.00 10.30-17.30</td><td>-</td></tr>'))).toEqual(['1.1'])
  })
})

// --- pictures ---

/** A white picture with a black block: something that decodes */
function picture(width = 300, height = 200): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(255)
  for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) data.set([20, 20, 20], (y * width + x) * 4)
  return { width, height, data }
}

/** An RGB PNG of the image (the decoder doesn't check CRCs) */
function encodePng(img: RgbaImage): Uint8Array {
  const raw = Buffer.alloc((img.width * 3 + 1) * img.height)
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const o = y * (img.width * 3 + 1) + 1 + x * 3
      const i = (y * img.width + x) * 4
      raw[o] = img.data[i]!
      raw[o + 1] = img.data[i + 1]!
      raw[o + 2] = img.data[i + 2]!
    }
  return pngFile(img.width, img.height, 2, deflateSync(raw))
}

function pngFile(width: number, height: number, colorType: number, idat: Uint8Array): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    out.set(body, 8)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ]),
  )
}

describe('shared image reader: the newest picture of a date cannot be read', () => {
  const at = new Date('2026-11-15T10:00:00+02:00')
  const good = encodePng(picture())
  const dates = [
    {
      date: '2026-11-15',
      images: [
        { path: '/new.png', at },
        { path: '/old.png', at: new Date(at.getTime() - HOUR) },
      ],
    },
  ]
  /** Every queue of Volyn, 1.1 off 08:00-10:00 */
  const schedule = postRegion('volyn').queues.map((queue) => ({
    queue,
    intervals: queue === '1.1' ? intervalsOf('08:00-10:00') : [],
  }))
  const read = (
    newest: Uint8Array,
    answer: (input: ImageInput) => Partial<ImageReading> | undefined = () => ({
      date: '2026-11-15',
      schedule,
    }),
  ) => {
    const { fetch, calls } = mockFetch([
      { match: '/new.png', body: newest },
      { match: '/old.png', body: good },
    ])
    const image = fakeImage(answer)
    const ctx: ProviderContext = {
      http: new Http({ fetch }),
      now: () => at,
      ai: new AiRuntime({ imageProcessor: image }),
    }
    const pictures = archivePictures(ctx, 'volyn', dates, (p) => `https://example.ua${p}`)
    return { calls, image, days: readSitePictures(ctx, 'volyn', pictures, { groups: STANDARD_GROUPS }) }
  }
  const isNew = (input: ImageInput) => input.url.endsWith('/new.png')

  const off = (start: number, end: number) => [{ start: start * 60, end: end * 60, kind: 'off' }]

  it('reads the newest when it can (the control)', async () => {
    const { days, calls } = read(good)
    const day = (await days).get('2026-11-15')!
    expect(day.at).toBe(Date.parse('2026-11-15T10:00:00+02:00'))
    expect(day.groups['1.1']).toEqual(off(8, 10))
    expect(day.unread).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('the newest does not decode: the older picture stands, flagged (read again in 10 min)', async () => {
    const { days, calls, image } = read(good.subarray(0, 200))
    const day = (await days).get('2026-11-15')!
    expect(day.unread).toMatchObject({ code: 'parse', details: { url: 'https://example.ua/new.png' } })
    expect(day.at).toBe(Date.parse('2026-11-15T09:00:00+02:00'))
    expect(calls.map((c) => c.url)).toEqual(['https://example.ua/new.png', 'https://example.ua/old.png'])
    expect(image.calls).toHaveLength(1)
  })

  it('the reading of the newest fails validation: the older stands, flagged', async () => {
    // an hour that doesn't exist, and a schedule without every queue
    for (const bad of [
      [{ queue: '1.1', intervals: intervalsOf('23:00-25:00') }, ...schedule.slice(1)],
      schedule.slice(1),
    ]) {
      const { days } = read(good, (input) =>
        isNew(input) ? { date: '2026-11-15', schedule: bad } : { date: '2026-11-15', schedule },
      )
      const day = (await days).get('2026-11-15')!
      expect(day.unread).toMatchObject({ code: 'parse', details: { url: 'https://example.ua/new.png' } })
      expect(day.groups['1.1']).toEqual(off(8, 10))
    }
  })

  it('the newest names another date: flagged, never shown as this one', async () => {
    const { days } = read(good, (input) =>
      isNew(input) ? { date: '2026-11-16', schedule } : { date: '2026-11-15', schedule },
    )
    const day = (await days).get('2026-11-15')!
    expect(day.unread?.message).toMatch(/listed for 2026-11-15 says 2026-11-16/)
    expect((await days).get('2026-11-16')).toBeUndefined()
  })

  it('still skips a picture that is not a schedule (a text announcement) for the older one', async () => {
    // the real announcement Khmelnytskyi posted over its table
    const { days, calls, image } = read(
      fixtureBytes('khmelnytskyi/announcement-2026-10-17-1658.png'),
      (input) => (isNew(input) ? undefined : { date: '2026-11-15', schedule }),
    )
    const day = (await days).get('2026-11-15')!
    expect(day.at).toBe(Date.parse('2026-11-15T09:00:00+02:00'))
    expect(day.unread).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(image.calls.map((c) => c.url)).toEqual([
      'https://example.ua/new.png',
      'https://example.ua/old.png',
    ])
  })

  it('no picture of the date is a schedule: the date is not known, flagged', async () => {
    const day = (await read(good, () => undefined).days).get('2026-11-15')!
    expect(day.unread?.message).toMatch(/none of the 2 picture\(s\) for 2026-11-15/)
    expect(Object.keys(day.groups)).toHaveLength(0)
  })
})

// --- addresses ---

describe('house numbers that differ only by a separator', () => {
  it('Zaporizhzhia: "1/1" and "11" on one street are two houses', async () => {
    const dir: ZoeDirectory = { cities: new Map() }
    const head = ['Громада', 'Населений пункт', 'Вулиця', 'Будинки']
    addSheet(dir, { id: 'a', gid: null, group: '1.1', city: false }, [
      head,
      ['Тестова ТГ', 'с. Тестове', 'вул. Садова', '1/1|12-А'],
    ])
    addSheet(dir, { id: 'b', gid: null, group: '2.2', city: false }, [
      head,
      ['Тестова ТГ', 'с. Тестове', 'вул. Садова', '11|12а'],
    ])
    const street = [...[...dir.cities.values()][0]!.streets.values()][0]!
    const groups = Object.fromEntries(
      [...street.houses.values()].map((h) => [h.house.number, [...h.groups].sort()]),
    )
    expect(groups).toEqual({ '1/1': ['1.1'], '11': ['2.2'], '12А': ['1.1', '2.2'] })
  })

  it('Zaporizhzhia: answers each of them with its own group through the client', async () => {
    const F = 'zaporizhzhia/addresses'
    const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const head = ['Громада', 'Населений пункт', 'Вулиця', 'Будинки']
    const sheets = [
      csv([head, ['Тестова ТГ', 'с. Тестове', 'вул. Садова', '1/1']]),
      csv([head, ['Тестова ТГ', 'с. Тестове', 'вул. Садова', '11']]),
    ]
    let n = 0
    const { fetch } = mockFetch([
      {
        match: encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підч') + '/',
        body: fixture(`${F}/page-city.html`),
      },
      {
        match: encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підче') + '/',
        body: fixture(`${F}/page-area.html`),
      },
      // the first two sheets asked for hold the two houses; the rest are empty
      {
        match: /docs\.google\.com\/spreadsheets\/d\/[\w-]+\/gviz/,
        body: () => sheets[n++] ?? fixture(`${F}/area-1.1.csv`),
      },
    ])
    const c = new OutageClient({ fetch, cacheTtlMs: 0, providers: [zaporizhzhiaProvider()] })
    // the sheets of the city come first: both rows are filed under Zaporizhzhia itself
    const address = { city: 'Запоріжжя', street: 'Садова' }
    const a = await c.findGroup('zaporizhzhia', { ...address, house: '1/1' })
    const b = await c.findGroup('zaporizhzhia', { ...address, house: '11' })
    expect(a.otherGroups).toBeUndefined()
    expect(b.otherGroups).toBeUndefined()
    expect(a.group).not.toBe(b.group)
  })

  const INFO: ProviderInfo = {
    id: 'lviv',
    name: 'L',
    operator: 'o',
    website: 'w',
    capabilities: { schedule: true, addressSearch: true },
  }
  const street: Street = { id: '7', name: 'вул. Садова', cityId: '1' }
  const ctx: ProviderContext = {
    http: new Http({ fetch: async () => new Response('[]') }),
    now: () => new Date(),
  }

  it('PowerOn: a building kept as "11" does not answer for "1/1"', async () => {
    const list: PowerOnBuilding[] = [
      { number: '11', groups: ['2.2'] },
      { number: '1/1', groups: ['1.1'] },
    ]
    const asked: string[] = []
    const search = powerOnAddressSearch({
      info: INFO,
      label: 'Test',
      api: 'https://example.ua/api',
      streetBuildings: async () => list,
      findBuilding: async (_ctx, _street, house) => {
        asked.push(house)
        return list.filter((b) => b.number === house)
      },
    })
    // "11" is now kept for the street, the street as a whole is not
    expect(await search.searchHouses(ctx, street, '11')).toEqual([{ id: '11', number: '11', streetId: '7' }])
    expect(await search.searchHouses(ctx, street, '1/1')).toEqual([
      { id: '1/1', number: '1/1', streetId: '7' },
    ])
    expect(asked).toEqual(['11', '1/1'])
    // and the same spelling differences as before still match
    expect(await search.searchHouses(ctx, street, '№ 11')).toEqual([
      { id: '11', number: '11', streetId: '7' },
    ])
  })

  it('PowerOn: groupOf never takes the other house for a number it was not given exactly', async () => {
    const search = powerOnAddressSearch({
      info: INFO,
      label: 'Test',
      api: 'https://example.ua/api',
      streetBuildings: async () => [{ number: '11', groups: ['2.2'] }],
    })
    await expect(
      search.groupOf(ctx, { id: '1/1', number: '1/1', streetId: '7' }, street),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect((await search.groupOf(ctx, { id: '11', number: '11', streetId: '7' }, street)).group).toBe('2.2')
  })
})

// --- resource limits ---

describe('decoders: a header that claims more than the file can hold', () => {
  const rss = () => process.memoryUsage().rss

  it('PNG: refuses a picture over the pixel limit before inflating anything', () => {
    // 40 000 × 40 000 of zeros deflates to a few MB; the header alone is enough to refuse
    const before = rss()
    expect(() => decodePng(pngFile(40_000, 40_000, 6, deflateSync(Buffer.alloc(1024))))).toThrow(/MP limit/)
    expect(MAX_IMAGE_PIXELS).toBeLessThanOrEqual(40_000_000)
    expect(rss() - before).toBeLessThan(200 * 1024 * 1024)
  })

  it('PNG: never inflates more than its size needs', () => {
    // a 10×10 picture whose data inflates to 300 MB
    const bomb = deflateSync(Buffer.alloc(300 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(1024 * 1024)
    const before = rss()
    expect(() => decodePng(pngFile(10, 10, 6, bomb))).toThrow(/inflates to more/)
    expect(rss() - before).toBeLessThan(200 * 1024 * 1024)
  })

  it('PNG: still reports truncated data', () => {
    expect(() => decodePng(pngFile(10, 10, 6, deflateSync(Buffer.alloc(40))))).toThrow(/truncated/)
  })

  /** The fixture with the size in its SOF0 header replaced */
  const jpeg = (width: number, height: number) => {
    const bytes = fixtureBytes('image/sample-444.jpg').slice()
    const sof = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xc0)
    expect(sof).toBeGreaterThan(0)
    bytes.set([height >> 8, height & 255, width >> 8, width & 255], sof + 5)
    return bytes
  }

  it('JPEG: refuses patched dimensions before allocating for them', () => {
    const before = rss()
    const started = Date.now()
    expect(() => decodeJpeg(jpeg(65_535, 65_535))).toThrow(/MP limit/)
    // under the pixel limit, but more blocks than the file has bits for
    expect(() => decodeJpeg(jpeg(4000, 4000))).toThrow(/cannot fit/)
    expect(() => decodeJpeg(jpeg(0, 45))).toThrow(/without a size/)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(rss() - before).toBeLessThan(100 * 1024 * 1024)
  })

  const latin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
  const pdf = (objects: string[]) =>
    latin1(['%PDF-1.5', ...objects, 'trailer\n<</Size 9/Root 1 0 R>>\n%%EOF\n'].join('\n'))

  it('PDF: refuses a page tree whose /Kids repeat a node', () => {
    // 18 levels, each listing the next one twice: 262 144 pages from 1 KB
    const levels = 18
    const nodes = Array.from(
      { length: levels },
      (_, i) => `${i + 2} 0 obj\n<</Type/Pages/Kids[ ${i + 3} 0 R ${i + 3} 0 R]>>\nendobj`,
    )
    const file = pdf([
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj',
      ...nodes,
      `${levels + 2} 0 obj\n<</Type/Page/MediaBox[0 0 10 10]>>\nendobj`,
    ])
    expect(file.length).toBeLessThan(2048)
    const started = Date.now()
    expect(() => openPdf(file)).toThrow(/twice/)
    expect(() => openPdf(file)).toThrow(parse)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('PDF: refuses a page tree that loops back on itself', () => {
    const file = pdf([
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj',
      '2 0 obj\n<</Type/Pages/Kids[ 3 0 R]>>\nendobj',
      '3 0 obj\n<</Type/Pages/Kids[ 2 0 R]>>\nendobj',
    ])
    expect(() => openPdf(file)).toThrow(parse)
  })

  it('PDF: has a page budget, and reads an ordinary flat tree', () => {
    const kids = Array.from({ length: 300 }, (_, i) => `${i + 3} 0 R`).join(' ')
    const file = pdf([
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj',
      `2 0 obj\n<</Type/Pages/Kids[ ${kids}]>>\nendobj`,
      ...Array.from({ length: 300 }, (_, i) => `${i + 3} 0 obj\n<</Type/Page>>\nendobj`),
    ])
    expect(openPdf(file).pageCount).toBe(300)
    expect(MAX_PAGES).toBeGreaterThanOrEqual(5000)
  })

  it('PDF: never inflates a stream past its budget', () => {
    const bomb = deflateSync(Buffer.alloc(80 * 1024 * 1024)).toString('latin1')
    const file = pdf([
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj',
      '2 0 obj\n<</Type/Pages/Kids[ 3 0 R]>>\nendobj',
      '3 0 obj\n<</Type/Page/Contents 4 0 R>>\nendobj',
      `4 0 obj\n<</Filter/FlateDecode/Length ${bomb.length}>>\nstream\r\n${bomb}\r\nendstream\nendobj`,
    ])
    expect(file.length).toBeLessThan(200 * 1024)
    const doc = openPdf(file)
    expect(() => doc.page(0)).toThrow(/inflates to more than 64 MB/)
    expect(() => doc.page(0)).toThrow(parse)
  })
})

describe('HTTP: a body larger than the cap', () => {
  const big = 'x'.repeat(5000)

  it('is a too-large error for text, JSON and bytes, with and without a declared length', async () => {
    for (const headers of [{ 'content-length': '5000' }, undefined]) {
      const fetch: FetchLike = async () => new Response(big, { headers })
      const h = new Http({ fetch, maxBodyBytes: 1000 })
      for (const read of [
        h.text('https://example.ua/x', { region: 'lviv' }),
        h.json('https://example.ua/x', { region: 'lviv' }),
        h.bytes('https://example.ua/x', { region: 'lviv' }),
      ]) {
        const err = await (read as Promise<unknown>).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(OutageError)
        expect(err).toMatchObject({ code: 'too-large', details: { region: 'lviv', status: 200 } })
        expect((err as OutageError).message).toBe('example.ua sent more than 1000 bytes')
      }
    }
  })

  it('stops reading an endless body at the cap instead of buffering it', async () => {
    let sent = 0
    let cancelled = false
    const fetch: FetchLike = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            sent += 1024
            c.enqueue(new Uint8Array(1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    const calls = vi.fn(fetch)
    await expect(
      new Http({ fetch: calls, maxBodyBytes: 10_000 }).bytes('https://example.ua/x'),
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(sent).toBeLessThan(20_000)
    expect(cancelled).toBe(true)
    // not asked again: a retry would only download it again
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('reads a body of exactly the cap, and has a generous default', async () => {
    const fetch: FetchLike = async () => new Response(big)
    expect(await new Http({ fetch, maxBodyBytes: 5000 }).text('https://example.ua/x')).toBe(big)
    expect(await new Http({ fetch }).text('https://example.ua/x')).toBe(big)
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024 * 1024)
  })

  it('decodes text as before: UTF-8 without its byte order mark, or the named charset', async () => {
    const utf8: FetchLike = async () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0xd1, 0x97]))
    expect(await new Http({ fetch: utf8 }).text('https://example.ua/x')).toBe('ї')
    const cp1251: FetchLike = async () => new Response(new Uint8Array([0xbf]))
    expect(await new Http({ fetch: cp1251 }).text('https://example.ua/x', { encoding: 'windows-1251' })).toBe(
      'ї',
    )
  })

  it('is an option of the client', async () => {
    const provider = volynProvider()
    const fetch: FetchLike = async () => new Response(big)
    const c = new OutageClient({ fetch, cacheTtlMs: 0, maxBodyBytes: 100, providers: [provider] })
    await expect(
      c.findGroup('volyn', { city: 'Луцьк', street: 'Винниченка', house: '8' }),
    ).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('HTTP: timeoutMs with a fetch that ignores the signal', () => {
  it('ends the request when no answer comes', async () => {
    const fetch: FetchLike = () => new Promise(() => {})
    const started = Date.now()
    const err = await new Http({ fetch, retries: 0, timeoutMs: 30 })
      .text('https://example.ua/x')
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'network', message: 'example.ua did not answer in 30 ms' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('counts every attempt: a retry gets its own timeout and the call still ends', async () => {
    const fetch = vi.fn<FetchLike>(() => new Promise(() => {}))
    await expect(
      new Http({ fetch, retries: 2, timeoutMs: 20 }).text('https://example.ua/x'),
    ).rejects.toMatchObject({
      code: 'network',
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('ends a body that never finishes', async () => {
    const fetch: FetchLike = async () => new Response(new ReadableStream({ start() {} }))
    for (const read of [
      new Http({ fetch, retries: 0, timeoutMs: 30 }).text('https://example.ua/x'),
      new Http({ fetch, retries: 0, timeoutMs: 30 }).bytes('https://example.ua/x'),
    ])
      await expect(read).rejects.toMatchObject({
        code: 'network',
        message: 'example.ua did not finish answering in 30 ms',
      })
  })

  it('ends the body of an error status too', async () => {
    const fetch: FetchLike = async () => new Response(new ReadableStream({ start() {} }), { status: 404 })
    await expect(
      new Http({ fetch, retries: 0, timeoutMs: 30 }).text('https://example.ua/x'),
    ).rejects.toMatchObject({ code: 'http', details: { status: 404 } })
  })
})

describe('the fetch for servers with an incomplete certificate chain', () => {
  let server: Server | ReturnType<typeof createTcpServer> | undefined
  afterEach(() => server?.close())
  // the same code over plain HTTP: node:http's `request` takes the same arguments
  const viaHttp = (max?: number) => httpsFetchWithCa([], max, httpRequest as never)
  const listen = (s: Server | ReturnType<typeof createTcpServer>) =>
    new Promise<string>((resolve) => {
      server = s
      s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`))
    })

  it('sends a URLSearchParams body (it used to be dropped) and a string one', async () => {
    const seen: { type?: string; body: string }[] = []
    const url = await listen(
      createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          seen.push({ type: req.headers['content-type'], body })
          res.end('ok')
        })
      }),
    )
    const res = await viaHttp()(url, { method: 'POST', body: new URLSearchParams({ a: 'ї', b: '1 2' }) })
    expect(await res.text()).toBe('ok')
    await viaHttp()(url, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    await viaHttp()(url, {
      method: 'POST',
      body: new URLSearchParams({ a: '1' }),
      headers: { 'content-type': 'text/x-own' },
    })
    expect(seen).toEqual([
      { type: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'a=%D1%97&b=1+2' },
      { type: 'application/json', body: '{"a":1}' },
      { type: 'text/x-own', body: 'a=1' },
    ])
  })

  it('refuses a body it cannot send instead of dropping it', async () => {
    const url = await listen(createServer((_req, res) => res.end('ok')))
    await expect(viaHttp()(url, { method: 'POST', body: new Blob(['x']) })).rejects.toThrow(
      /unsupported request body/,
    )
  })

  it('rejects for a status no Response can carry, instead of throwing in a socket handler', async () => {
    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)
    try {
      const url = await listen(
        createTcpServer((socket) => {
          socket.once('data', () => socket.end('HTTP/1.1 999 Odd\r\nContent-Length: 2\r\n\r\nno'))
        }),
      )
      await expect(viaHttp()(url)).rejects.toThrow(/status 999/)
      await tick(30)
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', uncaught)
    }
  })

  it('answers a status without a body (204, 205, 304)', async () => {
    const url = await listen(
      createServer((req, res) => {
        res.statusCode = Number(req.url!.slice(1))
        res.end()
      }),
    )
    for (const status of [204, 205, 304]) expect((await viaHttp()(`${url}${status}`)).status).toBe(status)
  })

  it('stops at the cap, by the declared length and by what arrives', async () => {
    const url = await listen(
      createServer((req, res) => {
        if (req.url === '/declared') res.setHeader('Content-Length', '5000')
        res.end('x'.repeat(5000))
      }),
    )
    for (const path of ['declared', 'chunked']) {
      const err = await viaHttp(1000)(`${url}${path}`).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BodyTooLarge)
      expect((err as BodyTooLarge).limit).toBe(1000)
    }
    expect(await (await viaHttp(5000)(`${url}chunked`)).text()).toHaveLength(5000)
  })
})

// --- caches ---

/** A fetch that answers after a moment unless its request is aborted first */
function slowFetch(answer: (url: string, init?: RequestInit) => string | Uint8Array) {
  const calls: string[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push(url)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(answer(url, init) as BodyInit)), 15)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal!.reason)
      })
    })
  }
  return { fetch, calls }
}

/** Two callers of one shared list: the first cancels mid-load, the second must still be served */
async function firstCallerLeaves<T>(
  fetch: FetchLike,
  call: (ctx: ProviderContext) => Promise<T>,
): Promise<T> {
  const http = new Http({ fetch, retries: 0 })
  const first = new AbortController()
  const a = call({ http: http.withSignal(first.signal), now: () => new Date(), signal: first.signal })
  const b = call({ http, now: () => new Date() })
  await tick(2)
  first.abort()
  await expect(a).rejects.toMatchObject({ name: 'AbortError' })
  return b
}

describe('lists several calls share: one caller leaving does not fail the others', () => {
  it('Poltava settlements', async () => {
    const { fetch } = slowFetch((url, init) =>
      url.endsWith('poe.pl.ua/')
        ? fixture('poltava/home-trimmed.html')
        : String(init?.body).includes('123')
          ? fixture('poltava/search-city-filial-123.json')
          : '[]',
    )
    const p = poltavaProvider()
    expect((await firstCallerLeaves(fetch, (ctx) => p.searchCities!(ctx, ''))).length).toBeGreaterThan(0)
  })

  it('Mykolaiv settlements', async () => {
    const { fetch } = slowFetch((url) =>
      url.endsWith('/addr/filii')
        ? fixture('mykolaiv/addr-filii.json')
        : url.endsWith('/filii/15/ns')
          ? fixture('mykolaiv/addr-filii-15-ns.json')
          : '[]',
    )
    const p = mykolaivProvider()
    expect((await firstCallerLeaves(fetch, (ctx) => p.searchCities!(ctx, ''))).length).toBeGreaterThan(0)
  })

  it('Zhytomyr settlements', async () => {
    const page = (name: string) => fixtureBytes(`zhytomyr/${name}`)
    const { fetch } = slowFetch((_url, init) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
      if (!init?.body) return page('schedule-2026-11-05.cp1251.html')
      return form.rem_id === '7'
        ? page('search-step1-rem7-settlements.cp1251.html')
        : '<select name="naspunkt_id"></select>'
    })
    const p = zhytomyrProvider()
    expect((await firstCallerLeaves(fetch, (ctx) => p.searchCities!(ctx, ''))).length).toBeGreaterThan(0)
  })

  it('PowerOn settlements and streets', async () => {
    const { fetch } = slowFetch((url) =>
      url.includes('pw_cities') ? fixture('lviv/pw_cities.json') : fixture('lviv/pw_streets.city-693.json'),
    )
    const search = powerOnAddressSearch({
      info: {
        id: 'lviv',
        name: 'L',
        operator: 'o',
        website: 'w',
        capabilities: { schedule: true, addressSearch: true },
      },
      label: 'Test',
      api: 'https://example.ua/api',
      streetBuildings: async () => [],
    })
    expect((await firstCallerLeaves(fetch, (ctx) => search.searchCities(ctx, ''))).length).toBeGreaterThan(0)
    const city = { id: '693', name: 'Львів' }
    expect(
      (await firstCallerLeaves(fetch, (ctx) => search.searchStreets(ctx, '', city))).length,
    ).toBeGreaterThan(0)
  })
})

describe('address caches expire', () => {
  const ctxOf = (fetch: FetchLike): ProviderContext => ({ http: new Http({ fetch }), now: () => new Date() })
  /** Moves `Date.now()` forward without touching timers */
  const clock = () => {
    const real = Date.now
    let ahead = 0
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead)
    return (ms: number) => (ahead += ms)
  }

  it('PowerOn: settlements and streets are asked again after a day, buildings after six hours', async () => {
    const forward = clock()
    const { fetch, calls } = mockFetch([
      { match: 'pw_cities', body: fixture('lviv/pw_cities.json') },
      { match: 'pw_streets', body: fixture('lviv/pw_streets.city-693.json') },
    ])
    let group = '1.1'
    let loads = 0
    const search = powerOnAddressSearch({
      info: {
        id: 'lviv',
        name: 'L',
        operator: 'o',
        website: 'w',
        capabilities: { schedule: true, addressSearch: true },
      },
      label: 'Test',
      api: 'https://example.ua/api',
      streetBuildings: async () => (loads++, [{ number: '5', groups: [group] }]),
    })
    const ctx = ctxOf(fetch)
    const city = { id: '693', name: 'Львів' }
    const street: Street = { id: '7', name: 'вул. Садова', cityId: '693' }
    const house = { id: '5', number: '5', streetId: '7' }
    const all = async () => {
      await search.searchCities(ctx, '')
      await search.searchStreets(ctx, '', city)
      return (await search.groupOf(ctx, house, street)).group
    }
    expect(await all()).toBe('1.1')
    expect(await all()).toBe('1.1')
    expect([calls.length, loads]).toEqual([2, 1])

    // the operator moves the building to another group
    group = '4.2'
    forward(5 * HOUR)
    expect(await all()).toBe('1.1')
    forward(2 * HOUR)
    expect(await all()).toBe('4.2')
    expect([calls.length, loads]).toEqual([2, 2])

    forward(18 * HOUR)
    await all()
    expect(calls.length).toBe(4)
  })

  it('PowerOn: an empty settlement list is not kept as the list', async () => {
    let body = '[]'
    const fetch: FetchLike = async () => new Response(body)
    const search = powerOnAddressSearch({
      info: {
        id: 'lviv',
        name: 'L',
        operator: 'o',
        website: 'w',
        capabilities: { schedule: true, addressSearch: true },
      },
      label: 'Test',
      api: 'https://example.ua/api',
      streetBuildings: async () => [],
    })
    await expect(search.searchCities(ctxOf(fetch), '')).rejects.toMatchObject({ code: 'parse' })
    body = fixture('lviv/pw_cities.json')
    expect((await search.searchCities(ctxOf(fetch), '')).length).toBeGreaterThan(0)
  })

  it('Poltava, Mykolaiv: the settlement list is asked again after a day', async () => {
    const forward = clock()
    const poltava = mockFetch([
      { match: /poe\.pl\.ua\/$/, body: fixture('poltava/home-trimmed.html') },
      { match: 'search-disconnection-cabinet', body: fixture('poltava/search-city-filial-123.json') },
    ])
    const mykolaiv = mockFetch([
      { match: '/addr/filii/15/ns', body: fixture('mykolaiv/addr-filii-15-ns.json') },
      { match: /\/addr\/filii\/\d+\/ns$/, body: '[]' },
      { match: '/addr/filii', body: fixture('mykolaiv/addr-filii.json') },
    ])
    const p = poltavaProvider()
    const m = mykolaivProvider()
    const both = async () => {
      await p.searchCities!(ctxOf(poltava.fetch), '')
      await m.searchCities!(ctxOf(mykolaiv.fetch), '')
      return [poltava.calls.length, mykolaiv.calls.length]
    }
    const once = await both()
    expect(await both()).toEqual(once)
    forward(23 * HOUR)
    expect(await both()).toEqual(once)
    forward(2 * HOUR)
    expect(await both()).toEqual(once.map((n) => n * 2))
  })

  it('Zhytomyr: the settlement list after a day, the groups of a house after six hours', async () => {
    const forward = clock()
    const page = (name: string) => fixtureBytes(`zhytomyr/${name}`)
    const asked = { settlements: 0, houses: 0 }
    const fetch: FetchLike = async (_url, init) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
      if (!init?.body) return new Response(page('schedule-2026-11-05.cp1251.html'))
      if (form.vulica_id)
        return (asked.houses++, new Response(page('search-step3-kyivska-all-houses.cp1251.html')))
      if (form.naspunkt_id) return new Response(page('search-step2-zhytomyr-streets.cp1251.html'))
      asked.settlements++
      return new Response(
        form.rem_id === '7'
          ? page('search-step1-rem7-settlements.cp1251.html')
          : '<select name="naspunkt_id"></select>',
      )
    }
    const p = zhytomyrProvider()
    const ctx = ctxOf(fetch)
    const cities = await p.searchCities!(ctx, '')
    const perLoad = asked.settlements
    const city = cities.find((c) => c.name.includes('Житомир'))!
    const street = (await p.searchStreets!(ctx, 'Київська', city)).find((s) => /Київська/.test(s.name))!
    const house = (await p.searchHouses!(ctx, street, '5')).find((h) => h.number === '5')!
    await p.groupOf!(ctx, house, street, city)
    await p.searchCities!(ctx, '')
    expect(asked).toEqual({ settlements: perLoad, houses: 1 })

    forward(7 * HOUR)
    await p.groupOf!(ctx, house, street, city)
    expect(asked.houses).toBe(2)
    await p.groupOf!(ctx, house, street, city)
    expect(asked.houses).toBe(2)

    forward(18 * HOUR)
    await p.searchCities!(ctx, '')
    expect(asked.settlements).toBe(perLoad * 2)
  })

  it('Volyn: a newer answer replaces the kept one, and an old one is asked again', async () => {
    const forward = clock()
    const original = fixture('volyn/cherga-lutsk-vynnychenka.trimmed.html')
    const moved = original.replace(/>4\.2<\/td>/g, '>6.1</td>')
    expect(moved).not.toBe(original)
    let body = original
    let asked = 0
    const fetch: FetchLike = async () => (asked++, new Response(body))
    const p = volynProvider()
    const ctx = ctxOf(fetch)
    const city = { id: '', name: 'Луцьк' }
    const pick = async () =>
      (await p.searchStreets!(ctx, 'Винниченка', city)).find((s) => /Винниченка/.test(s.name))!
    const groupOf = async (street: Street) => {
      const house = (await p.searchHouses!(ctx, street)).find((h) => h.number === '8')!
      return (await p.groupOf!(ctx, house, street, city)).group
    }
    const street = await pick()
    expect(await groupOf(street)).toBe('4.2')
    expect(asked).toBe(1)

    // the same street searched again after the operator moved it: the new answer is the one kept
    body = moved
    expect(await groupOf(await pick())).toBe('6.1')
    expect(asked).toBe(2)

    // and what is kept is asked again once it is six hours old
    body = original
    forward(5 * HOUR)
    expect(await groupOf(street)).toBe('6.1')
    forward(2 * HOUR)
    expect(await groupOf(street)).toBe('4.2')
    expect(asked).toBe(3)
  })
})
