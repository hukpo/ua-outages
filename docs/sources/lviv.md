# Lviv — ПрАТ «Львівобленерго» (LOE)

Researched 2026-11-05. Status: **no active ГПВ** (Today/Tomorrow `rawHtml` empty; last schedule 17.10.2026).

## Official pages

- Schedule + address lookup SPA: https://poweron.loe.lviv.ua/ (React, bundle `/static/js/main.<hash>.js`)
- Main site: https://loe.lviv.ua/

## Plain fetch

Works. Node 22 `fetch()` with no custom headers → 200 on both hosts. Cloudflare in front (`cf-cache-status: HIT`,
`cache-control: public, max-age=3600, s-maxage=7200`) — responses may be up to ~1–2 h stale at the edge. No WAF challenge observed. No rate limit observed by us (≈20 requests), but OlegVapnik/svitlo reports **HTTP 429** on `power-api` when crawling many streets even at 1 req/2 s — cache the address directory and back off on 429.

## 1. Schedule source — `api.loe.lviv.ua` (API Platform / Symfony, JSON-LD)

```
curl 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'
```

- **Response shape is not stable**: usually Hydra (`{"hydra:member":[menu]}`), but a cached plain-array variant
  (`[menu]`) was also served (it seems to depend on CF cache/`jsonld` param; `&jsonld=1` + `Accept: application/json` returned the array). Parser must accept both:
  `const menu = Array.isArray(body) ? body[0] : body['hydra:member'][0]`.
- Full response is ~1.5–3 MB (whole archive since 07.2024 is inlined). Nothing smaller found; fetch it and pick items.
- `menu.menuItems[]` — top-level items by `name`: `"Today"` (orders 0), `"Tomorrow"` (orders 1), `"Arhiv"` (orders 2).
  The SPA uses `menuItems[0]` as today and `menuItems[2]` as tomorrow — **positional, but order in JSON is Today, Arhiv, Tomorrow**; match by `name`, not index.
- Each item: `imageUrl` (PNG, relative to `https://api.loe.lviv.ua`), `slug` (mobile PNG path, ab-used field), `description` (free text, used for cancellations), `rawHtml`, `rawMobileHtml` (same text).
- `Arhiv.children[]` — every published version, `name: "Графік передано HH:MM DD.MM.YYYY"`. Items before 30.10.2025 are image-only; from 30.10.2025 on they carry `rawHtml` too. Useful as historical fixtures.

### rawHtml format (526 archive items analysed — only these line shapes exist)

```html
<div>
  <p><b>Графік погодинних відключень на 17.10.2026</b></p>
  <p><b>Інформація станом на 18:56 17.10.2026</b></p>
  <p>Група 1.1. Електроенергії немає з 20:00 до 22:00.</p>
  <p>Група 4.2. Електроенергії немає з 10:00 до 12:00, з 20:00 до 22:00.</p>
  <p>Група 6.2. Електроенергія є.</p>
</div>
```

- Date of the schedule = `на DD.MM.YYYY` in the first `<b>` (can be tomorrow relative to publish time — 103 such cases). Do **not** derive date from Today/Tomorrow slot.
- Updated-at = `Інформація станом на HH:MM DD.MM.YYYY` (Europe/Kyiv local).
- Per group: regex `Група (\d\.\d)\.\s*(Електроенергії немає (.*)|Електроенергія є)\.` then `з (\d\d:\d\d) до (\d\d:\d\d)` repeated. `24:00` occurs as end → map to next-day 00:00. Half hours (`04:30`) occur.
- All intervals are `kind: "off"`; LOE never publishes "maybe" intervals in this feed.
- Group `<b>` wrapping varies historically (`<p><b>Група 1.1.</b> ...`) — strip tags before regex. See BlackPencil-69/loe-outage-monitor tests for more variants.
- Cancellation: `rawHtml` empty and `description` = "Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на DD.MM.YYYY ..." (archive id 372). Treat as "schedule cancelled → no outages" for that date.
- No active schedule: Today/Tomorrow `rawHtml == ""` and `imageUrl == ""`.

## 2. Address → group — `power-api.loe.lviv.ua` (different host!)

Base `https://power-api.loe.lviv.ua/api`, all GET, no auth. Some endpoints return Hydra, some (streets) a plain array — handle both.

1. Hromadas: `GET /pw_otgs?pagination=false` → `{id, code (KATOTTG), name}` (85 items, e.g. id 28 "Львівська").
2. Settlements: `GET /pw_cities?pagination=false&otg.id=28` → `{id, name, codeOtg, otg}` (Львів = 693). Without `otg.id` returns all (~380 KB).
3. Streets: `GET /pw_streets?pagination=false&city.id=693` → `[{id, city, name}]` (1656 streets for Lviv; names like "Хмельницького Б.", no street type).
4. Houses + groups: `GET /pw_accounts?pagination=false&city.id=693&street.id=12564&buildingName=171`
   → `hydra:member[] {id, buildingName, chergGpv, chergGav, chergAchr, chergGvsp, chergSgav, disconnectionTask, planedReplaceCounter}`.
   - **One row per customer account** (157 rows for one building). Without `buildingName` you get the whole street (6074 rows, 1.8 MB) — use it once to build the house list (distinct `buildingName`) then filter.
   - `chergGpv` = ГПВ group ("5.1") or `"Не входить"` (not included). A building can map to **several groups** (e.g. building 115 → 2.1 and 5.1; 35 of 314 buildings on that street). Return the distinct set; the SPA just takes the first.
   - Other `cherg*` = other emergency schedules (ГАВ, АЧР, ГВСП, СГАВ) — not needed.
   - Also `GET /pw_accounts?acc=<10-digit account>&city.id=&street.id=&building.name=` (by personal account) — not used, avoid personal data.
5. Last DB sync: `GET /options?option_key=successful_last_synk` → `member[0].date` ISO with offset.
6. Unplanned/emergency outages per street: `GET /pw_accidents?page=1&otg.id=&city.id=&street.id=` (empty now).

## Group naming

`1.1 … 6.2` (12 groups), identical to the national scheme.

## Failure modes

- Big payload; CF edge caching means up to 1–2 h staleness (UNVERIFIED how often origin updates).
- Hydra vs array shape flips.
- Image-only publications (pre-10.2025) — if LOE regresses to images, text parsing yields nothing; detect `imageUrl != "" && rawHtml == ""` and surface "image-only".

## Files

- `menus-photo-grafic.current-trimmed.json` — current (empty Today/Tomorrow), array shape, archive trimmed to 8 items: image-only (248), cancellation (372), first text (547), tomorrow-dated (1095), last four of 17.10.2026 incl. "Електроенергія є" (1105–1108).
- `menus-photo-grafic.hydra-variant.trimmed.json` — same in Hydra shape, archive trimmed to 2.
- `archive-item-1108.populated.json` — **HISTORICAL** populated item (17.10.2026) to use as a populated "Today" fixture.
- `power-api.*.json` — address lookup chain (trimmed; `_trimmed` key added by us).

## References

- https://github.com/BlackPencil-69/loe-outage-monitor (MIT) — Python parser of the same rawHtml, with tests.
