# Kirovohradoblenergo (Кіровоградська область) — research notes

Researched 2026-11-05. Domain: **kiroe.com.ua**, behind Cloudflare. GPV was active on 5 Nov 2026, so the sample is populated.

## TL;DR

- **Schedule:** an official JSON endpoint gives a per-queue half-hour grid for the **current day only**: `POST /electricity-blackout/actual-gpv-graphs`. Tomorrow and the change times come from the operator's Telegram channel; see "Two channels" below.
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

**Date:** the response has **no date or timestamp field**. It flips to the new day at or shortly after midnight (still 16.11 at 23:45, already 17.11 at 00:25 on 17.11.2026) and is never pre-filled for tomorrow (`?date=`, a `date` field and guessed paths all return today's grid). The SDK dates it by the Telegram list it shows, see "Two channels". The JS has no tomorrow endpoint. The fixture was fetched 2026-11-05 at about 23:37 Kyiv time and matches the 5 Nov forecast (2→3→2 queues).

When GPV is not active, the frontend expects `data` to be empty/falsy and shows "Відключень не заплановано", but we have no sample yet (UNVERIFIED). The `data:[]` empty shape (wrong or missing token) looks the same, so the SDK must tell the two apart by validating the session first, e.g. check that `/city/{id}` returns rows.

**Freshness:** `last_modify` on city/street/house rows (e.g. `2026-11-05 22:48:22`, Kyiv) shows when the address DB was synced. There's no freshness field for the schedule.

**Groups:** `1.1`..`6.2`.

## Two channels: the site for today, Telegram for tomorrow and for every change time

Measured 2026-11-17 (`research/freshness/CHANNELS-B.md`), implemented in `src/providers/kirovohrad.ts` and
`src/providers/kirovohrad-telegram.ts`.

| channel                                    | has                                                                                                | lacks                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| site grid (`/actual-gpv-graphs`)           | today, with the "possible" half hours                                                              | tomorrow (never before midnight), any date, any change time |
| Telegram `t.me/s/SvitloKropyvnytskyiMisto` | the list for tomorrow 20:38–23:35 the evening before (13 of 13 days), every change, a time on each | the "possible" half hours                                   |

### The channel's posts

Posted by the dispatcher's system, as text (plus a picture of the same table):

- first publication: `17.11.2026 за розпорядженням НЕК "Укренерго" буде діяти наступний графік погодинних відключень (ГПВ):`, then `Черга 1.1: 08-10, 16-18, 20-22` per group. The change time is the post time.
- change: `На 17.11.2026 за розпорядженням НЕК "Укренерго" внесено зміни до графіка погодинних відключень (ГПВ) станом на 23:56 16.11.2026:` and the list. The change time is the `станом на` stamp (the post follows within a minute; a stamp more than an hour from the post is ignored in favour of the post time).
- cancellation: `15.11.2026 за наказом НЕК "Укренерго" ГПВ та ГОП скасовано до окремого розпорядження.` Nobody is off from then on; lists already posted for later days are void until a new one comes (16.11's came 17 minutes later).
- emptied list, seen only in a district channel (`t.me/SvitloHolovanivskohoRayonu/1792`): `На 15.11.2026 за розпорядженням НЕК "Укренерго" скасовано графік погодинних відключень (ГПВ) станом на 20:00 15.11.2026:`. Read as a cancellation of that day.
- until the morning of 05.11.2026 the wording was `05.11.2026 - Графік погодинних відключень` / `Зміни на 08:56 05.11.2026 до графіка погодинних відключень`, with the date after `"Укренерго"`. Both are read.

Rules, read off 92 lists of 26.10–16.11.2026:

- every list states the whole day as ordered at that moment and replaces the one before. A group it leaves out has no outages (post 1816 lists ten groups, 1820 six). Past hours may be gone from a later list.
- hours without minutes (`14-16`), half hours as `00-01:30`, `22-23`.
- no "possible" half hours: tomorrow, read from the channel, has `off` intervals only; they appear when the day becomes today on the site.
- СГАВ notices (`16.11.26 в 16:27 застосовано СГАВ`), forecasts and ГОП orders are not lists and are skipped (the emergency reader has the first).
- a list or cancellation posted since yesterday that can't be read exactly (odd hours, a group outside 1.1–6.2, a date that isn't the post's day or the two after, a ГПВ cancellation in unknown words) fails the whole channel with `parse`; the site then stands alone.

### Does one channel stand for the oblast?

The site lists 21 district channels and says the lists go to all of them automatically. Checked on 2026-11-17 for six of them
(`SvitloOleksandriyskohoRaionu`, `SvitloSvitlovodskohoRaionu`, `znamelektro`, `rem_ng`, `novomyrhorod1`, `SvitloHolovanivskohoRayonu`):
every ГПВ list on their newest preview page (15–18 each, 14.11 08:38 – 16.11 23:56) is identical, group by group, to the city
channel's list of the same moment, posted within 2 minutes of it. One difference: the Holovanivsk channel has the emptied list of
15.11 20:00 (post 1792, 20:07) that the city channel lacks; the city got the cancellation at 20:24 only. The other 14 channels
were not read. The site's grid is one grid for the whole company and equalled the channel's list both times it was saved.

So the region result is the company-wide ГПВ by group, read from the city channel. A district channel would do as well; none is
read as a fallback yet.

### Merge

Both are read on every call (`mergeSources`); each day comes from the one that published it last.

The grid has no date or time of its own, so it is given the date and time of the channel's list it shows: its `off` half hours
equal the list's hours exactly (05.11.2026 23:37 grid = post 1755; 17.11.2026 00:43 grid = post 1828; the grid only adds a
"possible" half hour on each side of a block).

| the grid's `off` half hours equal                         | the grid is                                       | who supplies the day                                                                           |
| --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| the channel's current list for today                      | today, published when that list was               | the site (a tie goes to it): same outages, plus the "possible" half hours                      |
| an earlier list for today, since replaced or cancelled    | today, published when that earlier list was       | the channel: it is newer. The site is marked `disagrees`                                       |
| a list for yesterday (and none for today)                 | yesterday's: the site hasn't moved to the new day | the channel for today; the site's day is returned as yesterday                                 |
| none of them, 01:00 or later                              | today, no publication time                        | the channel when it has today (a dated list beats an undated grid; `disagrees`), else the site |
| none of them, 00:00–00:59 (also when the channel is down) | not dated: it may be yesterday's                  | the channel when it has today, else nobody (`unknown`)                                         |

Why the channel wins when they differ: its list carries a date and the operator's time; a grid that matches no list can't be
shown to be today's or current. The price is the "possible" half hours for that day.

- **After "скасовано до окремого розпорядження"** (since 0.4.4). A cancellation has no hours, so it equals a blank grid, and a blank grid equals every blank day. Until 0.4.3 the next day's blank grid matched "yesterday's cancellation" and was filed under yesterday: no day for today, and the region read `behind` all day. Now: while that order is the channel's last word up to today (no list for today, none since for an earlier day) a blank grid is today's, published when the order was, at any hour. And a grid is never dated yesterday by a cancellation alone: with only a one-day cancellation ("скасовано графік … станом на 20:00") behind it, a blank grid follows the last two rows of the table. The order is read only while its post is inside the channel window (back to noon two days before); after that the blank grid is today's with no publication time. The channel itself still supplies no day for today from that order. What the grid really shows after a cancellation is still not verified (below): a grid that keeps the old hours is dated by the list it equals, as before.
- Tomorrow is always the channel's.
- `updatedAt` is the change time of the newest list in the result: the `станом на` stamp or the post time.
- A cancellation newer than the list the grid shows wins: every group gets `no-outages` for that day.
- Channel down: today from the site with `updatedAt: null`, no tomorrow, `sources[1].ok = false`. Site down or its session rejected: the channel's lists, `sources[0].ok = false`. Both down: the site's error.
- The 12 groups are always listed; an empty grid with nothing in the channel leaves them `unknown`.

Not verified: the minute the grid moves to the new day (it had by 00:25 on 17.11 and hadn't at 23:45 on 16.11), hence the hour of doubt; what the grid shows after a cancellation; a grid for a list with odd minutes.

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
- `blackout-actual-gpv-graphs.2026-11-17T0043.json`: the grid 43 minutes after midnight (= post 1828).
- `telegram-SvitloKropyvnytskyiMisto-1813-1828.trimmed.html`, `…-1747-1755.trimmed.html`, `telegram-SvitloHolovanivskohoRayonu-1791-1793.trimmed.html`: channel preview pages cut down to the posts named (test fixtures).

## Reference repos

- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license declared): lists these endpoints but marks them "waf, не обходити". We found the WAF needs only a Referer and a non-curl UA, no challenge bypass.
- No other public scrapers found (`gh search code actual-gpv-graphs`).
