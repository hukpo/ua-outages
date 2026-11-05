# Mykolaiv — АТ «Миколаївобленерго»

Verified 2026-11-05 ~23:30 Kyiv. GPV was active (schedules for 05.11 and 06.11 published).

## URLs

- Official GPV site (Vue 2 SPA): https://off.energy.mk.ua/ (bundle `/js/app.js`, ~11 KB, lists every endpoint)
- Company site / works feed: https://www.energy.mk.ua/
- Behind Cloudflare (`server: cloudflare`, `cf-cache-status: HIT`, `cache-control: private, max-age=22`). Plain `curl` / Node 24 `fetch` with no special headers → 200. No cookies, no tokens, no captcha.

## Source type

Clean JSON REST API (Laravel-style). Best source of the five eastern/southern regions.

### Endpoints (all `GET`, base `https://off.energy.mk.ua`, `Accept: application/json` optional)

| Path                                 | Fixture                                  | Meaning                                                                                                                                             |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/schedule/time-series`          | `time-series.json`                       | 48 rows `{id, start:"HH:MM:SS", end}`; id 1 = 00:00–00:30 … 48 = 23:30–24:00. Static; cache it.                                                     |
| `/api/v2/schedule/active`            | `schedule-active-2026-11-05.json`        | Array of days `{id, from, to, series[]}`. `from`/`to` are UTC ISO (`2026-11-04T22:00:00.000000Z` = 05.11 00:00 Kyiv).                               |
| `/api/outage-queue/by-type/3`        | `outage-queue-by-type-3.json`            | ГПВ queues: `{id, name:"1.1".."6.2", type_id:3, enabled:0/1}`. ids are NOT contiguous (14,15,16,17,19,20,21,22,24,25,26,27).                        |
| `/api/outage-queue/by-type/1` / `2`  | `outage-queue-by-type-1.json`, `-2.json` | ГАВ (1..10, 1(Р)..10(Р)) and СГАВ (1..3) queues — emergency schedules, not GPV.                                                                     |
| `/api/addr/filii`                    | `addr-filii.json`                        | Districts `{idfilial, fullname}` (20 rows; 15 = Миколаївський РЕМ = city).                                                                          |
| `/api/addr/filii/{idfilial}/ns`      | `addr-filii-15-ns.json`                  | Settlements `{idnaspunkt, naznaspunkt}` (171 = м. Миколаїв).                                                                                        |
| `/api/addr/ns/{idnaspunkt}/street`   | `addr-ns-171-street.json`                | Streets `{idstreet, nazstreet}` (736 in Mykolaiv city).                                                                                             |
| `/api/addr/street/{idstreet}/dom`    | `addr-street-3057-dom.json`              | Houses `{iddom, nazdom}` (вул. Соборна).                                                                                                            |
| `/api/addr/dom/{iddom}/outage-queue` | `addr-dom-121142-outage-queue.json`      | `[{outage:{id,name,type_id,enabled}, outageType:{id,name}}]` — one entry per type the house belongs to. type 3 (ГПВ) → GPV group name e.g. `"2.2"`. |

Optional per-house works/emergency feed (different host):
`POST https://www.energy.mk.ua/outage/api/v1/outage` JSON body `{"page":1,"perPage":50,"from":<unix>,"to":<unix>,"house_id":<iddom>}` → Laravel paginator `{current_page,data:[{id,type:"GAO"|…,start_at,finish_at,reason,updated_at,created_at,addr}],total,…}`. Fixture `energy-mk-works-house-121142-2026-11-05.json`. Note `total:100` with only 4 rows in `data` on page 1 when `house_id` is set — server-side filtering is odd; UNVERIFIED semantics. Not needed for GPV.

```sh
curl -s https://off.energy.mk.ua/api/v2/schedule/active
curl -s https://off.energy.mk.ua/api/addr/dom/121142/outage-queue
```

## Converting to `{start,end,kind}` per group per date (Europe/Kyiv)

1. Load time-series → `slot[id] = start` (HH:MM). Index = h*2 + m/30.
2. For each day in `/active`: date = `from` converted to Europe/Kyiv (`from` is local midnight in UTC; it is 22:00Z in winter, 21:00Z in summer — never use the UTC date).
3. For each `series[]` row: queue = `outage_queue_id` (map via by-type/3 `id → name`), slot = `time_series_id`, `type`:
   - `OFF` → kind `off` (заплановане відключення)
   - `SURE_OFF` → kind `off` (актуальне; site never lets later rows overwrite SURE_OFF)
   - `PROBABLY_OFF` → kind `maybe` (електропостачання можливе / перемикання — appears as the 30-min slot before and after each OFF block)
   - `ENABLE` or **missing slot** → power on. The API only lists non-ENABLE slots (252 rows = 12 queues × 21).
4. Merge consecutive same-kind slots into intervals; slot 48 ends at 24:00.
5. Multiple day objects can share the same Kyiv date — the site concatenates their series (see app.js `map[label].series.concat`).
6. Day missing from `/active` → schedule not published (site shows today as all-on only after a successful fetch).

Sanity (06.11): `1.1 ...........?XXXXX?.......?XXXXX?.......?XXXXX?..`, `2.2 XXX?.......?XXXXX?...` (`X` off, `?` maybe).

`enabled:1` on a queue means "this queue is being switched off right now" (site blinks it); it's live status, not schedule.

## Address search

Available, no captcha: district (`filii`) → settlement (`ns`) → street → house (`dom`) → `outage-queue`. Pick the entry with `outageType.id == 3` (or `outage.type_id == 3`) → group name `"X.Y"`.
Gotchas (from svitlo-widget): some houses return `[]` — the widget then tries neighbour numbers (±2) and asks the user. Names have trailing spaces → `trim()`. A settlement can appear under only one district; searching by settlement name means scanning all 20 districts.

## Freshness

No explicit "updated at" for the schedule as a whole; use max `series[].updated_at` (or `created_at`) per day. Queues have `updated_at`.

## Rate limits / failure modes

- No rate limit seen. Cloudflare in front; the widget honours `Retry-After` on non-200 (suggests 429/503 do happen — UNVERIFIED).
- Empty `/active` array is valid (no GPV).
- Validate: time-series must have 48 unique half-hour slots; every `time_series_id` must exist.

## Reference repos

- https://github.com/serjace/svitlo-widget — Android widget; `Api.java`, `Schedule.java`, `AddAddressActivity.java`, `Works.java`, `Updater.java`. **No license file** (all rights reserved — read for reference only, don't copy code).
- https://github.com/OlegVapnik/svitlo `docs/osr-direct-sources.md` — lists the same endpoints as `verified`. No license.
