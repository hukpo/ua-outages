// Світло: a static page over data/now.json and data/history.json, built every 15 min by
// site/scripts/build-data.ts with the ua-outages SDK. No framework, no build step.

const $ = (id) => document.getElementById(id)
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches

// --- Kyiv time ---

const kyivFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
function kyivParts(d) {
  const p = {}
  for (const { type, value } of kyivFmt.formatToParts(d)) p[type] = Number(value)
  return p
}
function kyivNow(d = new Date()) {
  const p = kyivParts(d)
  const pad = (n) => String(n).padStart(2, '0')
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, min: p.hour * 60 + p.minute + p.second / 60 }
}
function offsetMin(d) {
  const p = kyivParts(d)
  return Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d / 1000) * 1000) / 60000,
  )
}
/** The instant at `min` minutes past Kyiv midnight of `day` */
function instant(day, min) {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, min)
  let t = guess - offsetMin(new Date(guess)) * 60000
  t = guess - offsetMin(new Date(t)) * 60000
  return new Date(t)
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const hhmm = (min) => {
  const m = Math.round(min)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const MONTHS = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
]
const humanDay = (day) => `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`
function dayName(day) {
  const today = kyivNow().date
  if (day === today) return 'сьогодні'
  if (day === addDays(today, 1)) return 'завтра'
  if (day === addDays(today, -1)) return 'вчора'
  return humanDay(day)
}
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h} год ${String(m).padStart(2, '0')} хв` : `${m} хв ${String(sec).padStart(2, '0')} с`
}
/** Ukrainian plural: one (1, 21), few (2–4, 22–24), many (the rest) */
function plural(n, one, few, many) {
  const d = n % 10
  const t = n % 100
  if (d === 1 && t !== 11) return one
  if (d >= 2 && d <= 4 && (t < 12 || t > 14)) return few
  return many
}
const hoursText = (h) => `${h.toLocaleString('uk-UA', { maximumFractionDigits: 1 })} год`

// --- data ---

let DATA = null
let HISTORY = { days: {} }
const REGIONS = new Map()

/** Map shapes → data regions. Dnipropetrovsk has two operators. */
const SHAPE_REGIONS = { dnipro: ['dnipro', 'dnipro-cek'] }
const shapeRegions = (shape) => SHAPE_REGIONS[shape] ?? (REGIONS.has(shape) ? [shape] : [])
const NOT_COVERED = {
  vinnytsia: 'Вінницяобленерго ховає графік за перевіркою на бота',
  kherson: 'Херсонобленерго не публікує графік у відкритому вигляді',
  luhansk: 'Тимчасово окупована територія',
  crimea: 'Тимчасово окупована територія',
  sevastopol: 'Тимчасово окупована територія',
}

/** A group's day: {s, i: [[start, end, kind]]} or undefined */
const dayOf = (region, group, date) =>
  REGIONS.get(region)?.days?.[date]?.[group] ?? HISTORY.days[date]?.[region]?.[group]

/** 'on' | 'off' | 'maybe' | 'unknown' */
/** The source works but announces no outages at all (no schedule in force) */
const noSchedule = (region) => {
  const r = REGIONS.get(region)
  return !!r?.ok && !r.groups.length
}
/** Stand-in group for the lights of a region with no schedule */
const ANY = '*'

function stateAt(region, group, date, min) {
  if (group === ANY) return noSchedule(region) ? 'on' : 'unknown'
  const d = dayOf(region, group, date)
  if (!d || d.s === 'u' || d.s === 'e') return 'unknown'
  for (const [a, b, k] of d.i) if (min >= a && min < b) return k ? 'maybe' : 'off'
  return 'on'
}

/** Off/maybe intervals of a group for one day, [[a, b, kind]] */
const intervalsOf = (region, group, date) => dayOf(region, group, date)?.i ?? []

function regionShare(region, date, min) {
  const r = REGIONS.get(region)
  if (noSchedule(region)) return { off: 0, maybe: 0, offCount: 0, known: 0, none: true }
  if (!r?.ok) return null
  let off = 0
  let maybe = 0
  let known = 0
  for (const g of r.groups) {
    const s = stateAt(region, g, date, min)
    if (s === 'unknown') continue
    known++
    if (s === 'off') off++
    if (s === 'maybe') maybe++
  }
  return known ? { off: off / known, maybe: maybe / known, offCount: off, known } : null
}

function nationalShare(date, min) {
  let off = 0
  let maybe = 0
  let n = 0
  for (const r of REGIONS.values()) {
    const s = regionShare(r.id, date, min)
    if (!s) continue
    off += s.off
    maybe += s.maybe
    n++
  }
  return n ? { off: off / n, maybe: maybe / n, regions: n } : null
}

// --- view state ---

const view = { date: null, min: 0, live: true, playing: false, hover: null, selected: null }

// --- the map ---

const canvas = $('map-canvas')
const ctx = canvas.getContext('2d')
let MAP = null
let dots = [] // {x, y, shape, region, group, b (shown), t (target), k (speed), seed}
let shapes = [] // {id, path, name}

function mulberry(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildDots() {
  const rnd = mulberry(20261107)
  const probe = document.createElement('canvas').getContext('2d')
  dots = []
  shapes = Object.entries(MAP.regions).map(([id, r]) => ({ id, name: r.name, path: new Path2D(r.d), d: r.d }))
  // Kyiv city last, so its dense lights sit on top of the region around it
  shapes.sort((a, b) => (a.id === 'kyiv') - (b.id === 'kyiv'))
  for (const s of shapes) {
    const nums = s.d.match(/-?\d+(\.\d+)?/g).map(Number)
    const xs = nums.filter((_, i) => i % 2 === 0)
    const ys = nums.filter((_, i) => i % 2 === 1)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const step = s.id === 'kyiv' ? 1.9 : 4.6
    const pool = []
    for (const region of shapeRegions(s.id))
      if (noSchedule(region)) pool.push([region, ANY])
      else for (const g of REGIONS.get(region)?.groups ?? []) pool.push([region, g])
    for (let y = y0; y < y1; y += step)
      for (let x = x0; x < x1; x += step) {
        const px = x + (rnd() - 0.5) * step * 0.7
        const py = y + (rnd() - 0.5) * step * 0.7
        if (!probe.isPointInPath(s.path, px, py)) continue
        // other regions' lights don't spill into Kyiv city
        if (s.id === 'kyiv-region' && probe.isPointInPath(shapes.find((q) => q.id === 'kyiv').path, px, py))
          continue
        const [region, group] = pool.length ? pool[Math.floor(rnd() * pool.length)] : [null, null]
        dots.push({
          x: px,
          y: py,
          shape: s.id,
          region,
          group,
          b: 0,
          t: 0,
          k: 0.06 + rnd() * 0.16,
          seed: rnd() * 1000,
        })
      }
  }
}

let scale = 1
function resizeCanvas() {
  const w = canvas.clientWidth
  const dpr = Math.min(2, devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(((w * MAP.height) / MAP.width) * dpr)
  scale = canvas.width / MAP.width
  draw(true)
}

const STATE_TARGET = { on: 1, off: 0, maybe: 0.45, unknown: -1 }
function updateTargets() {
  for (const d of dots) d.t = d.region ? STATE_TARGET[stateAt(d.region, d.group, view.date, view.min)] : -1
}

// colours of a dot by brightness level: -1 no data, 0 off … 1 lit
const LEVELS = 12
const lampRGB = [255, 207, 90]
const offRGB = [42, 53, 80]
const levelColor = (l) => {
  const f = l / (LEVELS - 1)
  return `rgb(${offRGB.map((c, i) => Math.round(c + (lampRGB[i] - c) * f)).join(',')})`
}
const LEVEL_COLORS = Array.from({ length: LEVELS }, (_, l) => levelColor(l))

let lastFrame = 0
function draw(force = false) {
  if (!MAP) return
  const time = performance.now()
  let moving = false
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#0a0e18'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  for (const s of shapes) {
    ctx.fillStyle = s.id === view.hover || s.id === view.selected ? '#18213a' : '#0f1524'
    ctx.fill(s.path)
  }
  ctx.strokeStyle = '#0a0e18'
  ctx.lineWidth = 1.2
  for (const s of shapes) ctx.stroke(s.path)

  const buckets = Array.from({ length: LEVELS }, () => [])
  const none = []
  const maybe = []
  for (const d of dots) {
    if (d.t === -1) {
      none.push(d)
      continue
    }
    let target = d.t
    if (target === STATE_TARGET.maybe && !REDUCED)
      target = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(time / 260 + d.seed))
    if (REDUCED || force === 'snap') d.b = target
    else {
      const diff = target - d.b
      if (Math.abs(diff) > 0.01) {
        d.b += diff * d.k
        moving = true
      } else d.b = target
    }
    if (d.t === STATE_TARGET.maybe) maybe.push(d)
    else buckets[Math.max(0, Math.min(LEVELS - 1, Math.round(d.b * (LEVELS - 1))))].push(d)
  }
  // at least ~1.7 css px per light, so a phone-sized map still reads as lights
  const minSize = (1.7 * Math.min(2, devicePixelRatio || 1)) / scale
  const size = Math.max(2.5, minSize)
  const kyivSize = Math.max(1.4, minSize * 0.6)
  const rect = (d) => {
    const s = d.shape === 'kyiv' ? kyivSize : size
    ctx.rect(d.x - s / 2, d.y - s / 2, s, s)
  }
  ctx.fillStyle = '#232a3a'
  ctx.beginPath()
  for (const d of none) rect(d)
  ctx.fill()
  buckets.forEach((list, l) => {
    if (!list.length) return
    ctx.fillStyle = LEVEL_COLORS[l]
    ctx.beginPath()
    for (const d of list) rect(d)
    ctx.fill()
  })
  if (maybe.length) {
    for (const d of maybe) {
      ctx.globalAlpha = 0.35 + 0.65 * d.b
      ctx.fillStyle = '#d29a35'
      ctx.fillRect(d.x - size / 2, d.y - size / 2, size, size)
    }
    ctx.globalAlpha = 1
    moving = true
  }
  lastFrame = time
  return moving
}

let animating = false
function animate() {
  if (animating) return
  animating = true
  const tick = () => {
    const moving = draw()
    if (view.playing) {
      view.min += 2.5
      if (view.min >= 1440) {
        view.min = 0
        const days = availableDays()
        const next = days[days.indexOf(view.date) + 1]
        if (next) {
          view.date = next
          onTimeChange()
        } else stopPlay()
      } else onTimeChange(false)
    }
    if (moving || view.playing) requestAnimationFrame(tick)
    else animating = false
  }
  requestAnimationFrame(tick)
}

function shapeAt(ev) {
  const r = canvas.getBoundingClientRect()
  const x = ((ev.clientX - r.left) / r.width) * MAP.width
  const y = ((ev.clientY - r.top) / r.height) * MAP.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // Kyiv city first: it sits inside Kyiv region
  const order = [...shapes].sort((a, b) => (b.id === 'kyiv') - (a.id === 'kyiv'))
  return order.find((s) => ctx.isPointInPath(s.path, x, y))?.id ?? null
}

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType !== 'mouse') return
  const id = shapeAt(ev)
  if (id !== view.hover) {
    view.hover = id
    renderRegionCard()
    draw()
  }
})
canvas.addEventListener('pointerleave', () => {
  view.hover = null
  renderRegionCard()
  draw()
})
canvas.addEventListener('click', (ev) => {
  const id = shapeAt(ev)
  view.selected = id === view.selected ? null : id
  renderRegionCard()
  draw()
})

function stripHTML(region, group, date, nowMin) {
  const d = dayOf(region, group, date)
  if (!d || d.s === 'u' || d.s === 'e')
    return `<div class="strip"><i class="none" style="left:0;width:100%"></i></div>`
  const parts = d.i
    .map(
      ([a, b, k]) =>
        `<i class="${k ? 'maybe' : ''}" style="left:${(a / 14.4).toFixed(2)}%;width:${((b - a) / 14.4).toFixed(2)}%"></i>`,
    )
    .join('')
  const marker = nowMin == null ? '' : `<b style="left:calc(${(nowMin / 14.4).toFixed(2)}% - 1px)"></b>`
  return `<div class="strip">${parts}${marker}</div>`
}

function renderRegionCard() {
  const card = $('region-card')
  const shape = view.hover ?? view.selected
  if (!shape) {
    card.hidden = true
    return
  }
  card.hidden = false
  const name = MAP.regions[shape]?.name ?? ''
  const ids = shapeRegions(shape)
  if (!ids.length) {
    card.innerHTML = `<h3>${name}</h3><p class="hint">${NOT_COVERED[shape] ?? 'Немає даних'}</p>`
    return
  }
  let html = `<h3>${name}</h3>`
  for (const id of ids) {
    const r = REGIONS.get(id)
    const share = regionShare(id, view.date, view.min)
    if (ids.length > 1) html += `<p class="hint">${r.operator}</p>`
    if (!r.ok) {
      html += `<p class="hint">Зараз не вдалося отримати графік: ${escapeHTML(friendlyError(r.message))}</p>`
      continue
    }
    if (!share) {
      html += `<p class="hint">На ${dayName(view.date)} графік ще не опубліковано.</p>`
      continue
    }
    if (share.none) {
      html += `<p>Відключень за графіком не оголошено: ${escapeHTML(r.operator)} зараз не публікує графіка.</p>`
      continue
    }
    html += `<p>${share.offCount} з ${share.known} черг без світла о ${hhmm(view.min)}</p>`
    if (r.stale)
      html += `<p class="hint">Сайт обленерго зараз не відповідає, тож це графік, отриманий ${new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(new Date(r.fetchedAt))}.</p>`
    const groups = r.groups.length > 12 ? r.groups.slice(0, 12) : r.groups
    html += `<div class="mini-strips">${groups.map((g) => `<span>${g}</span>${stripHTML(id, g, view.date, view.min)}`).join('')}</div>`
    if (r.groups.length > 12) html += `<p class="hint">і ще ${r.groups.length - 12} черг</p>`
    html += `<p><a href="#/${id}/${r.groups[0]}" data-pick="${id}">Обрати свою чергу тут</a></p>`
  }
  card.innerHTML = html
}

const escapeHTML = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function friendlyError(msg = '') {
  if (/bot/i.test(msg)) return 'сайт обленерго перевіряє, чи ви не бот, і не віддає графік програмам'
  if (/only as an image/i.test(msg)) return 'обленерго публікує графік лише картинкою за адресою'
  if (/timeout|timed out/i.test(msg)) return 'сайт обленерго не відповів вчасно'
  if (/403|Cannot reach/i.test(msg)) return 'сайт обленерго не відповідає серверам за кордоном'
  return 'сайт обленерго відповів не так, як очікувалось'
}

// --- timeline ---

function availableDays() {
  const today = kyivNow().date
  const days = new Set([today])
  for (const r of REGIONS.values()) for (const d of Object.keys(r.days ?? {})) if (d >= today) days.add(d)
  return [...days].sort().slice(0, 3)
}

function renderDayButtons() {
  const box = $('day-buttons')
  box.innerHTML = availableDays()
    .map(
      (d) =>
        `<button type="button" class="ghost" data-day="${d}" aria-pressed="${d === view.date}">${dayName(d)[0].toUpperCase() + dayName(d).slice(1)}</button>`,
    )
    .join('')
}
$('day-buttons').addEventListener('click', (ev) => {
  const day = ev.target.closest('[data-day]')?.dataset.day
  if (!day) return
  view.date = day
  view.live = false
  if (day !== kyivNow().date && view.min === 0) view.min = 18 * 60
  onTimeChange()
})

function renderCurve() {
  const svg = $('curve-svg')
  const pts = []
  const maybePts = []
  for (let m = 0; m <= 1440; m += 10) {
    const s = nationalShare(view.date, Math.min(m, 1439))
    pts.push([m, s ? s.off : 0])
    maybePts.push([m, s ? s.off + s.maybe : 0])
  }
  const y = (v) => (120 - v * 114).toFixed(1)
  const area = (ps) => `M0,120 ${ps.map(([x, v]) => `L${x},${y(v)}`).join(' ')} L1440,120Z`
  const hours = Array.from({ length: 23 }, (_, i) => (i + 1) * 60)
  svg.innerHTML =
    hours.map((h) => `<rect x="${h - 0.5}" y="0" width="1" height="120" fill="#121a2b"/>`).join('') +
    `<path d="${area(maybePts)}" fill="#6b5424"/>` +
    `<path d="${area(pts)}" fill="var(--curve)"/>` +
    `<rect id="curve-now" x="${view.min - 2}" y="0" width="4" height="120" fill="var(--lamp)"/>`
  $('curve-caption').textContent =
    `Частка черг без світла протягом доби (${dayName(view.date)}), у середньому по областях з даними. Тягніть, щоб перемотати.`
}

function onTimeChange(full = true) {
  const share = nationalShare(view.date, view.min)
  const pct = share ? Math.round(share.off * 100) : null
  $('stat-share').textContent = pct == null ? '—' : `${pct}%`
  const when = view.live ? 'зараз' : `${dayName(view.date)} о ${hhmm(view.min)}`
  $('stat-text').textContent =
    pct == null
      ? 'На цей час графіків ще немає.'
      : `черг ${view.live ? 'зараз ' : ''}без світла за графіком${view.live ? '' : `, ${when}`}. Дані з ${share.regions} ${plural(share.regions, 'області', 'областей', 'областей')}.`
  $('clock').textContent = hhmm(view.min)
  $('scrub').value = String(Math.round(view.min))
  $('live').hidden = view.live
  const now = $('curve-now')
  if (now) now.setAttribute('x', String(view.min - 2))
  if (full) {
    renderDayButtons()
    renderCurve()
  }
  updateTargets()
  renderRegionCard()
  animate()
}

$('scrub').addEventListener('input', (ev) => {
  stopPlay()
  view.live = false
  view.min = Number(ev.target.value)
  onTimeChange(false)
})
$('live').addEventListener('click', () => goLive())
$('play').addEventListener('click', () => (view.playing ? stopPlay() : startPlay()))

function startPlay() {
  view.playing = true
  view.live = false
  $('play').setAttribute('aria-pressed', 'true')
  $('play').textContent = 'Зупинити'
  if (view.min > 1400) view.min = 0
  animate()
}
function stopPlay() {
  if (!view.playing) return
  view.playing = false
  $('play').setAttribute('aria-pressed', 'false')
  $('play').textContent = 'Прокрутити добу'
  onTimeChange()
}
function goLive() {
  stopPlay()
  const n = kyivNow()
  view.date = n.date
  view.min = n.min
  view.live = true
  onTimeChange()
}

// --- places ---

const STORE = 'svitlo.places.v1'
let places = []
try {
  places = JSON.parse(localStorage.getItem(STORE) || '[]')
} catch {
  places = []
}
const savePlaces = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(places))
  } catch {}
}
let current = null // {region, group}

const regionSelect = $('pick-region')
const groupSelect = $('pick-group')

function fillRegionSelect() {
  const rs = [...REGIONS.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'))
  regionSelect.innerHTML = rs
    .map(
      (r) =>
        `<option value="${r.id}" ${r.ok && r.groups.length ? '' : 'disabled'}>${r.name}${r.ok && r.groups.length ? '' : r.ok ? ' (відключень не оголошено)' : ' (немає даних)'}</option>`,
    )
    .join('')
}
function fillGroupSelect(region, group) {
  const r = REGIONS.get(region)
  groupSelect.innerHTML = (r?.groups ?? []).map((g) => `<option value="${g}">${g}</option>`).join('')
  if (group && r?.groups.includes(group)) groupSelect.value = group
}

function setCurrent(region, group, { scroll = false, updateHash = true } = {}) {
  const r = REGIONS.get(region)
  if (!r?.ok || !r.groups.length) return
  if (!r.groups.includes(group)) group = r.groups[0]
  current = { region, group }
  regionSelect.value = region
  fillGroupSelect(region, group)
  if (updateHash) history.replaceState(null, '', `#/${region}/${group}`)
  try {
    localStorage.setItem('svitlo.current', JSON.stringify(current))
  } catch {}
  $('pick-hint').innerHTML =
    `Не знаєте своєї черги? Знайдіть адресу на <a href="${r.website}" target="_blank" rel="noopener">сайті ${escapeHTML(r.operator)}</a>.`
  renderMe()
  renderPlaces()
  renderTogether()
  renderHistory()
  if (scroll) $('me').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' })
}

regionSelect.addEventListener('change', () => setCurrent(regionSelect.value, null))
groupSelect.addEventListener('change', () => setCurrent(regionSelect.value, groupSelect.value))
$('pick').addEventListener('submit', (ev) => ev.preventDefault())

$('save-place').addEventListener('submit', (ev) => {
  ev.preventDefault()
  if (!current) return
  const name =
    $('place-name').value.trim() ||
    `${REGIONS.get(current.region).name.replace(' область', '')} ${current.group}`
  places = places.filter((p) => !(p.region === current.region && p.group === current.group))
  places.push({ name, ...current })
  savePlaces()
  $('place-name').value = ''
  renderPlaces()
  renderTogether()
})

function renderPlaces() {
  const list = $('places')
  if (!places.length) {
    list.innerHTML = `<li class="hint">Поки порожньо. Збережіть поточну чергу.</li>`
    return
  }
  list.innerHTML = places
    .map((p, i) => {
      const cur = current && p.region === current.region && p.group === current.group
      return `<li><button type="button" class="open" data-open="${i}" aria-current="${cur}">${escapeHTML(p.name)} · ${p.group}</button><button type="button" class="remove" data-remove="${i}" aria-label="Видалити ${escapeHTML(p.name)}">×</button></li>`
    })
    .join('')
}
$('places').addEventListener('click', (ev) => {
  const open = ev.target.closest('[data-open]')
  const remove = ev.target.closest('[data-remove]')
  if (open) {
    const p = places[Number(open.dataset.open)]
    setCurrent(p.region, p.group)
  } else if (remove) {
    places.splice(Number(remove.dataset.remove), 1)
    savePlaces()
    renderPlaces()
    renderTogether()
  }
})

// --- my group ---

/** Off/maybe periods from now on, merged across midnight: [{from: Date, to: Date, kind}] */
function periods(region, group) {
  const out = []
  const today = kyivNow().date
  for (let i = -1; i < 3; i++) {
    const day = addDays(today, i)
    for (const [a, b, k] of intervalsOf(region, group, day)) {
      const from = instant(day, a)
      const to = instant(day, b)
      const last = out[out.length - 1]
      if (last && last.kind === k && last.to.getTime() === from.getTime()) last.to = to
      else out.push({ from, to, kind: k })
    }
  }
  return out
}

function knownUntil(region, group) {
  let last = null
  const today = kyivNow().date
  for (let i = 0; i < 3; i++) {
    const day = addDays(today, i)
    const d = dayOf(region, group, day)
    if (d && d.s !== 'u' && d.s !== 'e') last = day
  }
  return last ? instant(addDays(last, 1), 0) : null
}

function renderMe() {
  if (!current) return
  const { region, group } = current
  const r = REGIONS.get(region)
  const now = new Date()
  const n = kyivNow(now)
  const state = stateAt(region, group, n.date, n.min)
  const box = $('me-status')
  box.classList.toggle('is-on', state === 'on')
  const ps = periods(region, group)
  const active = ps.find((p) => p.from <= now && p.to > now)
  const next = ps.find((p) => p.from > now && p.kind === 0)
  const until = knownUntil(region, group)
  const words = {
    on: 'Світло є',
    off: 'Світла немає',
    maybe: 'Можливе відключення',
    unknown: 'Графіка немає',
  }
  $('state').textContent = words[state]
  let line = ''
  if (state === 'off' || state === 'maybe')
    line = `за графіком до ${hhmm(kyivNow(active.to).min)} · ще ${duration(active.to - now)}`
  else if (state === 'on' && next)
    line = `вимкнуть о ${hhmm(kyivNow(next.from).min)}${kyivNow(next.from).date !== n.date ? ` ${dayName(kyivNow(next.from).date)}` : ''} · через ${duration(next.from - now)}`
  else if (state === 'on' && until)
    line = `за графіком без відключень до кінця ${until - now > 36 * 3600e3 ? 'завтрашнього дня' : 'доби'}`
  else line = `${r.operator} ще не опублікувало графік на цей час`
  $('countdown').textContent = `${r.name}, черга ${group}: ${line}`
  renderDial(region, group, n)
  const items = ps.filter((p) => p.to > now).slice(0, 6)
  $('upcoming').innerHTML = items.length
    ? items
        .map((p) => {
          const a = kyivNow(p.from)
          const b = kyivNow(p.to)
          return `<li>${hhmm(a.min)}–${b.min === 0 ? '24:00' : hhmm(b.min)}<span>${dayName(a.date)}${p.kind ? ', можливе' : ''}</span></li>`
        })
        .join('')
    : `<li>Немає запланованих<span>на відомі дні</span></li>`
  const base = new URL('.', location.href)
  const cal = new URL(`cal/${region}/${group}.ics`, base)
  $('cal-apple').href = cal.href.replace(/^https?:/, 'webcal:')
  $('cal-google').href =
    `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(cal.href.replace(/^https?:/, 'webcal:'))}`
  document.title = `${words[state]} · черга ${group} · Світло`
}

function renderDial(region, group, n) {
  const svg = $('dial')
  const R = 92
  const arc = (a, b, r) => {
    const p = (m) => {
      const ang = (m / 1440) * Math.PI * 2 - Math.PI / 2
      return [(Math.cos(ang) * r).toFixed(2), (Math.sin(ang) * r).toFixed(2)]
    }
    const [x0, y0] = p(a)
    const [x1, y1] = p(Math.min(b, 1439.9))
    return `M${x0},${y0} A${r},${r} 0 ${b - a > 720 ? 1 : 0} 1 ${x1},${y1}`
  }
  const on = getComputedStyle($('me-status')).color
  const d = dayOf(region, group, n.date)
  const known = d && d.s !== 'u' && d.s !== 'e'
  let html = `<circle r="${R}" fill="none" stroke="${known ? 'var(--lamp)' : '#2b3242'}" stroke-width="16"/>`
  if ($('me-status').classList.contains('is-on'))
    html = `<circle r="${R}" fill="none" stroke="#fff3cf" stroke-width="16"/>`
  for (const [a, b, k] of known ? d.i : [])
    html += `<path d="${arc(a, b, R)}" fill="none" stroke="${k ? 'var(--maybe)' : $('me-status').classList.contains('is-on') ? '#1a1405' : 'var(--off)'}" stroke-width="16"/>`
  for (let h = 0; h < 24; h += 6) {
    const ang = (h / 24) * Math.PI * 2 - Math.PI / 2
    html += `<text x="${(Math.cos(ang) * 66).toFixed(1)}" y="${(Math.sin(ang) * 66 + 5).toFixed(1)}" text-anchor="middle" font-size="14" fill="${on}" opacity="0.7">${String(h).padStart(2, '0')}</text>`
  }
  const ang = (n.min / 1440) * Math.PI * 2 - Math.PI / 2
  html += `<line x1="0" y1="0" x2="${(Math.cos(ang) * (R + 12)).toFixed(1)}" y2="${(Math.sin(ang) * (R + 12)).toFixed(1)}" stroke="${on}" stroke-width="3" stroke-linecap="round"/><circle r="5" fill="${on}"/>`
  svg.innerHTML = html
  svg.setAttribute(
    'aria-label',
    `Доба по колу: ${known ? d.i.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(', ') || 'без відключень' : 'графіка немає'}`,
  )
}

$('share').addEventListener('click', async () => {
  if (!current) return
  const url = new URL(`#/${current.region}/${current.group}`, location.href).href
  try {
    if (navigator.share) await navigator.share({ title: `Черга ${current.group} · Світло`, url })
    else {
      await navigator.clipboard.writeText(url)
      $('action-hint').textContent = 'Посилання скопійовано.'
    }
  } catch {}
})

let notifyTimer = null
$('notify').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    $('action-hint').textContent =
      'Цей браузер не вміє показувати сповіщення. Підпишіться на календар: він нагадає за 15 хвилин.'
    return
  }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    $('action-hint').textContent = 'Сповіщення заборонені в налаштуваннях браузера.'
    return
  }
  scheduleNotify()
})
function scheduleNotify() {
  clearTimeout(notifyTimer)
  if (!current) return
  const now = new Date()
  const next = periods(current.region, current.group).find((p) => p.kind === 0 && p.from - 15 * 60e3 > now)
  if (!next) {
    $('action-hint').textContent = 'Найближчих відключень у відомому графіку немає.'
    return
  }
  const at = new Date(next.from - 15 * 60e3)
  notifyTimer = setTimeout(
    () => {
      new Notification('Через 15 хвилин вимкнуть світло', {
        body: `Черга ${current.group}, з ${hhmm(kyivNow(next.from).min)}`,
      })
      scheduleNotify()
    },
    Math.min(at - now, 2 ** 31 - 1),
  )
  $('action-hint').textContent =
    `Нагадаю о ${hhmm(kyivNow(at).min)}, поки ця сторінка відкрита. Щоб нагадування приходили завжди, підпишіться на календар.`
}

// --- together ---

function renderTogether() {
  const body = $('together-body')
  const list = [...places]
  if (current && !list.some((p) => p.region === current.region && p.group === current.group))
    list.unshift({ name: 'Обрана черга', ...current })
  if (list.length < 2) {
    body.innerHTML = `<div class="empty-block"><p class="windows">Потрібно хоча б дві адреси.</p><p>Оберіть чергу в розділі «Моя черга», натисніть «Зберегти», потім оберіть іншу.</p><a class="button" href="#me">Додати адресу</a></div>`
    return
  }
  const today = kyivNow().date
  const nowMin = kyivNow().min
  let html = ''
  for (const day of [today, addDays(today, 1)]) {
    const known = list.every((p) => {
      const d = dayOf(p.region, p.group, day)
      return d && d.s !== 'u' && d.s !== 'e'
    })
    if (!known && day !== today) continue
    // minutes when every place has power
    const all = []
    let start = null
    for (let m = 0; m <= 1440; m += 5) {
      const ok = m < 1440 && known && list.every((p) => stateAt(p.region, p.group, day, m) === 'on')
      if (ok && start === null) start = m
      if (!ok && start !== null) {
        all.push([start, m])
        start = null
      }
    }
    const future = day === today ? all.filter(([, b]) => b > nowMin) : all
    const text = !known
      ? 'Не для всіх адрес є графік.'
      : future.length
        ? future
            .map(
              ([a, b]) =>
                `${hhmm(day === today ? Math.max(a, Math.floor(nowMin / 5) * 5) : a)}–${b === 1440 ? '24:00' : hhmm(b)}`,
            )
            .join(', ')
        : 'Спільних годин зі світлом немає.'
    html += `<div class="windows-day"><h3>${dayName(day)[0].toUpperCase() + dayName(day).slice(1)}</h3><div><p class="windows">${text}</p><div class="rows">`
    for (const p of list)
      html += `<span>${escapeHTML(p.name)} · ${p.group}</span>${stripHTML(p.region, p.group, day, day === today ? nowMin : null)}`
    html += `<span>Світло всюди</span><div class="strip all">${all.map(([a, b]) => `<i style="left:${a / 14.4}%;width:${(b - a) / 14.4}%"></i>`).join('')}</div>`
    html += `<span></span><div class="hours">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span>${String(h).padStart(2, '0')}</span>`).join('')}</div>`
    html += `</div></div></div>`
  }
  body.innerHTML = html
}

// --- history ---

function offHours(region, group, day) {
  const d = HISTORY.days[day]?.[region]?.[group] ?? REGIONS.get(region)?.days?.[day]?.[group]
  if (!d || d.s === 'u' || d.s === 'e') return null
  return d.i.filter(([, , k]) => !k).reduce((s, [a, b]) => s + b - a, 0) / 60
}

function renderHistory() {
  const today = kyivNow().date
  const days = Object.keys(HISTORY.days).sort()
  const first = days[0] ?? today
  if (current) {
    const { region, group } = current
    const cells = []
    const weeks = 10
    // start on a Monday, `weeks` weeks back
    const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7
    const start = addDays(today, -dow - (weeks - 1) * 7)
    let week = 0
    let weekDays = 0
    let total = 0
    let n = 0
    for (let i = 0; i < weeks * 7; i++) {
      const day = addDays(start, i)
      if (day > addDays(today, 1)) {
        cells.push(`<span style="visibility:hidden"></span>`)
        continue
      }
      const h = offHours(region, group, day)
      if (h != null && day <= today && day > addDays(today, -7)) {
        week += h
        weekDays++
      }
      if (h != null) {
        total += h
        n++
      }
      const f = h == null ? null : Math.min(1, h / 16)
      const deep = [61, 74, 107]
      const color =
        f == null ? '#111726' : `rgb(${lampRGB.map((c, k) => Math.round(c + (deep[k] - c) * f)).join(',')})`
      cells.push(
        `<span style="background:${color}" title="${humanDay(day)}: ${h == null ? 'немає даних' : hoursText(h) + ' без світла'}"></span>`,
      )
    }
    $('heat').innerHTML = cells.join('')
    $('heat').setAttribute('aria-label', `Години без світла по днях для черги ${group}`)
    $('history-summary').textContent = weekDays
      ? weekDays === 1
        ? `Черга ${group}: ${hoursText(week)} без світла сьогодні за графіком.`
        : `Черга ${group}: ${hoursText(week)} без світла за останні ${weekDays} ${weekDays < 5 ? 'дні' : 'днів'}, у середньому ${hoursText(week / weekDays)} на добу.`
      : `Для черги ${group} архів ще порожній.`
    $('heat-hint').textContent =
      `Кожна клітинка — доба, тиждень у стовпчику. Що темніша, то довше без світла. Архів веде цей сайт з ${humanDay(first)}${first.slice(0, 4) !== today.slice(0, 4) ? ' ' + first.slice(0, 4) : ''}.`
  }
  const rank = []
  for (const r of REGIONS.values()) {
    let sum = 0
    let count = 0
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, -i)
      for (const g of r.groups.length ? r.groups : Object.keys(HISTORY.days[day]?.[r.id] ?? {})) {
        const h = offHours(r.id, g, day)
        if (h != null) {
          sum += h
          count++
        }
      }
    }
    if (count) rank.push({ name: r.name, h: sum / count })
  }
  rank.sort((a, b) => b.h - a.h)
  const max = Math.max(1, ...rank.map((r) => r.h))
  $('rank').innerHTML = rank
    .map(
      (r) =>
        `<li><span>${r.name.replace(' область', '')}</span><b>${hoursText(r.h)}</b><div class="bar-fill"><i style="width:${((r.h / max) * 100).toFixed(1)}%"></i></div></li>`,
    )
    .join('')
}

// --- sources ---

function renderSources() {
  const rows = [...REGIONS.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'))
  const fmt = (iso) =>
    new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  let html = rows
    .map((r) => {
      const has = r.ok && r.groups.length
      const state = !r.ok
        ? `<span class="dot bad"></span>${friendlyError(r.message)}`
        : r.stale
          ? `<span class="dot quiet"></span>${friendlyError(r.message)}; показано графік, отриманий ${fmt(r.fetchedAt)}`
          : has
            ? `<span class="dot"></span>працює, ${r.groups.length} черг${r.relayed ? ', дані зібрано з України' : ''}`
            : `<span class="dot"></span>працює, відключень не оголошено`
      return `<tr><td>${r.name}</td><td><a href="${r.website}" target="_blank" rel="noopener">${escapeHTML(r.operator)}</a></td><td>${state}</td><td>${r.updatedAt ? fmt(r.updatedAt) : '—'}</td></tr>`
    })
    .join('')
  for (const [id, why] of Object.entries(NOT_COVERED))
    if (!REGIONS.has(id) && MAP?.regions[id])
      html += `<tr><td>${MAP.regions[id].name}</td><td>—</td><td><span class="dot quiet"></span>${why}</td><td>—</td></tr>`
  $('sources-body').innerHTML = html
  $('generated').textContent = `Дані зібрано ${fmt(DATA.generatedAt)} за київським часом.`
}

// --- entrance motion ---

function reveal() {
  const items = document.querySelectorAll('main > section:not(.hero) > *, .footer > *')
  if (REDUCED || !('IntersectionObserver' in window)) return
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io.unobserve(e.target)
        }
    },
    { rootMargin: '0px 0px -10% 0px' },
  )
  items.forEach((el) => {
    const i = [...el.parentElement.children].indexOf(el)
    el.style.setProperty('--delay', `${i * 80}ms`)
    el.classList.add('reveal')
    io.observe(el)
  })
}

// --- start ---

function fromHash() {
  const m = /^#\/([\w-]+)\/([\w.]+)$/.exec(location.hash)
  return m ? { region: m[1], group: decodeURIComponent(m[2]) } : null
}
addEventListener('hashchange', () => {
  const h = fromHash()
  if (h) setCurrent(h.region, h.group, { scroll: true, updateHash: false })
})
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-pick]')
  if (!a) return
  ev.preventDefault()
  const r = REGIONS.get(a.dataset.pick)
  setCurrent(r.id, r.groups[0], { scroll: true })
})

async function load() {
  const [now, map, hist] = await Promise.all([
    fetch('data/now.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('map.json').then((r) => r.json()),
    fetch('data/history.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : { days: {} }))
      .catch(() => ({ days: {} })),
  ])
  DATA = now
  MAP = map
  HISTORY = hist
  REGIONS.clear()
  for (const r of now.regions) REGIONS.set(r.id, r)
}

async function start() {
  try {
    await load()
  } catch (e) {
    $('stat-text').textContent = 'Не вдалося завантажити графіки. Оновіть сторінку.'
    return
  }
  buildDots()
  const n = kyivNow()
  view.date = n.date
  view.min = n.min
  resizeCanvas()
  onTimeChange()
  draw('snap')
  // start dark, then let the lights come on
  if (!REDUCED) {
    for (const d of dots) d.b = 0
    animate()
  }
  fillRegionSelect()
  renderSources()
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('svitlo.current') || 'null')
    } catch {
      return null
    }
  })()
  const first = fromHash() ?? saved ?? places[0] ?? { region: 'kyiv', group: REGIONS.get('kyiv')?.groups[0] }
  setCurrent(first.region, first.group, { updateHash: !!fromHash() })
  reveal()
  new ResizeObserver(() => resizeCanvas()).observe(canvas)
  // tick: the countdown every second, the live map every minute, fresh data every 5 minutes
  let lastMinute = Math.floor(n.min)
  setInterval(() => {
    renderMe()
    const k = kyivNow()
    if (view.live && Math.floor(k.min) !== lastMinute) {
      lastMinute = Math.floor(k.min)
      view.date = k.date
      view.min = k.min
      onTimeChange(false)
    }
  }, 1000)
  setInterval(async () => {
    try {
      await load()
      renderSources()
      renderTogether()
      renderHistory()
      if (view.live) goLive()
    } catch {}
  }, 5 * 60e3)
}

start()
