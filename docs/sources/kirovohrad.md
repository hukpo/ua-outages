# Kirovohradoblenergo (Кіровоградська область) — research notes

Researched 2026-11-05. Domain: **kiroe.com.ua**, behind Cloudflare. GPV was active on 5 Nov 2026, so the sample is populated.

## TL;DR

- **Schedule:** an official JSON endpoint gives a per-queue half-hour grid for the **current day only**: `POST /electricity-blackout/actual-gpv-graphs`.
- **Address → queue:** official JSON endpoints: office (ОТГ) → city → street → house. The house list already includes `chergGpv` (e.g. `"5.1"`).
- **Plain fetch works.** You need:
  1. a `Referer: https://kiroe.com.ua/electricity-blackout` header on the AJAX POSTs (without it Cloudflare returns 403 "Just a moment...");
  2. a non-curl User-Agent (curl's default `curl/x.y` gets 403 even on the HTML page; `node`, `Mozilla/5.0` and `ua-outages/0.1` all pass);
  3. a PHP session cookie plus `token` from the page HTML, for real data. Without them you get HTTP 200 with `{"success":true,"data":[]}`.

  None of this needs a challenge solver, headless browser or captcha. The page loads reCAPTCHA v3, but only for the feedback forms. These endpoints don't need it.

## Official pages

- Schedule + address lookup: https://kiroe.com.ua/electricity-blackout ("Графік відключень")
- Planned / emergency outages per ОТГ: https://kiroe.com.ua/energy/plan/{areaId}, https://kiroe.com.ua/energy/emergency (HTML; not researched in depth)
- Daily forecast posts with only the _number of queues_ per period: https://kiroe.com.ua/warning/outage-forecast-november-6-2026 (slug pattern `outage-forecast-<month>-<d>-<yyyy>`; UNVERIFIED for other dates). These posts say _how many_ queues are off, not _which_. They work as a "GPV planned tomorrow" signal only.
- Info post: https://kiroe.com.ua/news/grafiki-pogodinnih-vidklyuchen (the winter schedules apply 2026-10-01 → 2027-04-01, and some addresses changed queue)

## Session bootstrap

```
GET https://kiroe.com.ua/electricity-blackout        (any non-curl UA)
  → Set-Cookie: <32-hex-name>=<php session>; path=/   (+ __cf_bm, not required)
  → HTML contains:  BlackoutManager.config = { baseUrl: "https://kiroe.com.ua/electricity-blackout", ajaxToken: "<32 hex>" ... }
  → <select id="fn_office"> with 51 <option value="{officeId}">{ОТГ name}</option>
```

The token changes per session. Extract it with `/ajaxToken:\s*"([a-f0-9]+)"/`. Token lifetime is UNVERIFIED. To be safe, re-bootstrap whenever you get `data: []` or a 403.

## Endpoints

All are `POST`. The body is `application/x-www-form-urlencoded`, `ajax=1&token=<ajaxToken>`. The frontend appends `?t=<Date.now()>`, which is optional. Send these headers:

- `Referer: https://kiroe.com.ua/electricity-blackout` (required)
- `Cookie: <session cookie>`
- `X-Requested-With: XMLHttpRequest` (optional)

GET also works for `/city/{id}` (verified once).

| path                                                         | returns (`{success:true, data: ...}`)                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `/actual-gpv-graphs`                                         | `{"1.1":{"times":{"00:00":"0","00:30":"0",...,"23:30":"0"}}, ... "6.2":{...}}` (48 half-hour slots × 12 queues) |
| `/city/{officeId}`                                           | `[{id,OfficeId,CityId,CityName,CityType,is_updated,visible,created,last_modify}]`                               |
| `/street/{cityId}`                                           | `[{id,CityId,StreetId,StreetName,StreetType,...,last_modify}]` (869 streets for Кропивницький, about 210 KB)    |
| `/house/{streetId}`                                          | `[{id,CityId,StreetId,HouseId,HouseName,chergGpv,...,StreetName,CityName}]`                                     |
| `/get-house-info/{id}`                                       | a single house object; `id` is the row `id`, not `HouseId`                                                      |
| `/get-house-message` (body adds `cityId,streetId,HouseName`) | `{message:"Застосування ГПВ"}`, a free-text status per house                                                    |

Example:

```bash
UA='ua-outages/0.1'; B=https://kiroe.com.ua/electricity-blackout
curl -s -A "$UA" -c jar $B -o page.html
T=$(grep -oE 'ajaxToken: "[a-f0-9]{32}"' page.html | grep -oE '[a-f0-9]{32}')
curl -s -A "$UA" -b jar -H "Referer: $B" -d "ajax=1&token=$T" "$B/actual-gpv-graphs"
```

We verified this with plain Node 24 `fetch` too: `getSetCookie()`, drop `__cf_bm`, and send the session cookie only.

## Schedule format → `{start,end,kind}`

`times["HH:MM"]` is the state of the half hour starting at HH:MM:

- `"0"`: power on
- `"1"`: off
- `"10"`: "Можливе відключення", i.e. possible off. In practice it is the transition half hour on each side of a block, e.g. `?####?`.

Map `1` to `off` and `10` to `maybe`. Merge adjacent slots of the same kind. The last slot ends at 24:00, which is D+1 00:00 Europe/Kyiv.

The official renderer collapses each hour into one cell, treating `0+10` as on and `1+10` as off. Keep the half-hour resolution instead.

**Date:** the response has **no date or timestamp field**. It is "today" in Europe/Kyiv at fetch time. UNVERIFIED: whether it flips at midnight, and whether it is ever pre-filled for tomorrow. The JS has no tomorrow endpoint. The fixture was fetched 2026-11-05 at about 23:37 Kyiv time and matches the 5 Nov forecast (2→3→2 queues).

When GPV is not active, the frontend expects `data` to be empty/falsy and shows "Відключень не заплановано", but we have no sample yet (UNVERIFIED). The `data:[]` empty shape (wrong or missing token) looks the same, so the SDK must tell the two apart by validating the session first, e.g. check that `/city/{id}` returns rows.

**Freshness:** `last_modify` on city/street/house rows (e.g. `2026-11-05 22:48:22`, Kyiv) shows when the address DB was synced. There's no freshness field for the schedule.

**Groups:** `1.1`..`6.2`.

## Address search flow

office (ОТГ id from the page `<select>`, or a hardcoded list of 51) → `/city/{officeId}` → `/street/{cityId}` (filter client-side) → `/house/{streetId}` → `chergGpv`. That gives 3 API calls after bootstrap. Display names: `CityType` is often `""`. `StreetName` already contains the prefix ("вул. ..."), and `StreetType` is empty.

## Rate limits / failure modes

- Cloudflare: 403 HTML "Just a moment..." if the Referer is missing on POSTs or the UA is curl's default. No 429 was seen in about 30 requests (UNVERIFIED under load).
- `__cf_bm` expires after about 30 minutes, but it isn't needed.
- Session expired or bad token → `200 {"success":true,"data":[]}`. That's a silent failure, so re-bootstrap.
- The frontend also handles 404 (not found) and 503 (maintenance).

## Saved files

- `blackout-actual-gpv-graphs.2026-11-05.json`: populated grid, 12 queues, uses `0/1/10`.
- `blackout-city-86.json`: Кропивницька ОТГ cities.
- `blackout-street-1471.TRIMMED.json`: streets of Кропивницький. The first 150 plus street 14592; the original count is in `_TRIMMED_FROM`.
- `blackout-house-14592.json`: houses on вул. Велика Перспективна, with `chergGpv`.
- `blackout-get-house-info-96451.json`, `blackout-get-house-message.json`
- `blackout-page-offices.html`: excerpt of the office `<select>` and the config block (token redacted).
- `warning-outage-forecast-november-{5,6}-2026.excerpt.html`: forecast posts that give only the number of queues.

## Reference repos

- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license declared): lists these endpoints but marks them "waf, не обходити". We found the WAF needs only a Referer and a non-curl UA, no challenge bypass.
- No other public scrapers found (`gh search code actual-gpv-graphs`).
