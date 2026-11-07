/**
 * Builds site/public/map.json (oblast outlines as SVG paths) from Natural Earth admin-1
 * (public domain). Run once; the output is committed.
 *   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
 *   node site/scripts/build-map.mjs ne_10m_admin_1_states_provinces.geojson
 * Regions are picked by their UA-xx ISO code, so Crimea and Sevastopol are included.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ISO = {
  'UA-30': 'kyiv',
  'UA-32': 'kyiv-region',
  'UA-12': 'dnipro',
  'UA-51': 'odesa',
  'UA-14': 'donetsk',
  'UA-46': 'lviv',
  'UA-26': 'ivano-frankivsk',
  'UA-21': 'zakarpattia',
  'UA-61': 'ternopil',
  'UA-56': 'rivne',
  'UA-07': 'volyn',
  'UA-77': 'chernivtsi',
  'UA-68': 'khmelnytskyi',
  'UA-74': 'chernihiv',
  'UA-18': 'zhytomyr',
  'UA-71': 'cherkasy',
  'UA-35': 'kirovohrad',
  'UA-59': 'sumy',
  'UA-63': 'kharkiv',
  'UA-53': 'poltava',
  'UA-23': 'zaporizhzhia',
  'UA-48': 'mykolaiv',
  'UA-05': 'vinnytsia',
  'UA-65': 'kherson',
  'UA-09': 'luhansk',
  'UA-43': 'crimea',
  'UA-40': 'sevastopol',
}
const g = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const feats = g.features.filter((f) => ISO[f.properties.iso_3166_2])
const K = Math.cos((48.5 * Math.PI) / 180)
let minX = Infinity,
  minY = Infinity,
  maxX = -Infinity,
  maxY = -Infinity
const rings = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates)
for (const f of feats)
  for (const poly of rings(f.geometry))
    for (const [lon, lat] of poly[0]) {
      minX = Math.min(minX, lon * K)
      maxX = Math.max(maxX, lon * K)
      minY = Math.min(minY, -lat)
      maxY = Math.max(maxY, -lat)
    }
const W = 1000
const s = W / (maxX - minX)
const H = Math.ceil((maxY - minY) * s)
const proj = ([lon, lat]) => [(lon * K - minX) * s, (-lat - minY) * s]

function simplify(pts, eps) {
  if (pts.length < 3) return pts
  const [a, b] = [pts[0], pts[pts.length - 1]]
  let max = 0,
    idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]
    const dx = b[0] - a[0],
      dy = b[1] - a[1]
    const d = Math.abs(dy * x - dx * y + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(dx, dy) || 1)
    if (d > max) {
      max = d
      idx = i
    }
  }
  if (max <= eps) return [a, b]
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)]
}
const regions = {}
for (const f of feats) {
  const id = ISO[f.properties.iso_3166_2]
  let d = ''
  let cx = 0,
    cy = 0,
    n = 0
  for (const poly of rings(f.geometry)) {
    // a closed ring starts and ends on the same point: simplify its two halves
    const ring = poly[0].map(proj)
    const mid = Math.floor(ring.length / 2)
    const pts = [...simplify(ring.slice(0, mid + 1), 0.6).slice(0, -1), ...simplify(ring.slice(mid), 0.6)]
    if (pts.length < 4) continue
    d += 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z'
    for (const [x, y] of pts) {
      cx += x
      cy += y
      n++
    }
  }
  regions[id] = { name: f.properties.name_uk, d, cx: +(cx / n).toFixed(1), cy: +(cy / n).toFixed(1) }
}
writeFileSync(
  new URL('../public/map.json', import.meta.url),
  JSON.stringify({ width: W, height: H, regions }),
)
console.log(W, H, Object.keys(regions).length, JSON.stringify(regions).length)
