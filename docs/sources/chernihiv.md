# Chernihivoblenergo (Чернігівська) — research notes

Researched 2026-11-05 (~23:40 Europe/Kyiv). ГПВ was **active** on 05.11 and announced for 06.11.

## TL;DR

- **Domains**: `energy.cn.ua` (37.52.15.98) and `www.energy.cn.ua` (.99) **time out** on 80/443 from here. They are probably the legacy portal and/or geo/firewall-restricted (UNVERIFIED). The live official site is **`https://chernihivoblenergo.com.ua`** (Apache, no WAF). The outage tool is an iframe from **`https://interruptions.energy.cn.ua/interruptions`** (CNAME webhook.energy.cn.ua → 94.131.247.142), which is reachable.
- **Machine-readable schedule exists but is captcha-gated**: `POST /api/info_schedule_part` requires a **Cloudflare Turnstile token**. With no token it returns `400 {"error":"No captcha"}`; with a bad one, `403 {"error":"Captcha failed"}`. ⇒ **Plain fetch cannot get the schedule.** The old token-less `POST /api/info_schedule` now returns an HTML 404 (and per OlegVapnik/svitlo it previously always returned `aData:null`).
- **Only token-free official schedule = a JPEG**: `https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg` ("Години застосування ГПВ" button on /blackouts). It's a 1200×2036 ~1.2 MB poster with 12 group cards listing `HH:MM - HH:MM` off intervals for one date. It's overwritten in place (Last-Modified tells you when; 05.11 05:59 UTC, EXIF 2026-11-04 20:39). It's OCR-able (clean typeset digits), but OCR is outside "no headless browser/captcha" scope; decide in the SDK whether to support it.
- **Address search**: the city → street → house autocomplete is **token-free**, but house → queue (`info_disable_house`, `number_queue`) is **Turnstile-gated**. ⇒ No address→group without captcha.
- Group naming: `1.1`..`6.2` (12 groups; image and JS use `queue_cc` like `1.1`; old code used `1/1`).

## Endpoints (base `https://interruptions.energy.cn.ua`)

Send `Referer: https://interruptions.energy.cn.ua/interruptions`. JSON. CORS headers `*` are on the parent site.

| Purpose              | Method / path                                                               | Captcha? | Notes                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| city autocomplete    | `GET /api/info_disable/?nq=city&q=<≥3 chars>`                               | no       | `{"status":"200","list":[[7410100000,"м.Чернігів (Чернігівська Область/М.Чернігів)"]]}` — id is the KOATUU code                                            |
| street autocomplete  | `GET /api/info_disable/?nq=street&q=<≥3 chars>&c=<cityId>`                  | no       | `list:[[13449,"вулиця Миру"],…]`                                                                                                                           |
| house autocomplete   | `GET /api/info_disable/?nq=house&q=<prefix>&s=<streetId>`                   | no       | `list:[[houseId,"12","62Z…,62Z…"]]` — **3rd field is the comma-separated EIC codes of the meters in the building (personal data; redacted in the sample)** |
| outages at house     | `POST /api/info_disable_house` `{param:houseId, token}`                     | **yes**  | returns `list:[[label, start, end]]` per the JS (UNVERIFIED)                                                                                               |
| queue by account/EIC | `POST /api/number_queue/` `{search_param, token}`                           | **yes**  |                                                                                                                                                            |
| outages by account   | `POST /api/info_disable` `{person_accnt, eic, token}`                       | **yes**  |                                                                                                                                                            |
| **ГПВ schedule**     | `POST /api/info_schedule_part` `{queue:"1.1", curr_dt:"YYYY-MM-DD", token}` | **yes**  | see format below                                                                                                                                           |
| legacy schedule      | `POST /api/info_schedule` `{queue, curr_dt}`                                | no       | now **404 HTML**                                                                                                                                           |

```
curl -s -G 'https://interruptions.energy.cn.ua/api/info_disable/' --data-urlencode nq=city --data-urlencode q=Черніг
curl -s -X POST -H 'Content-Type: application/json' -d '{"queue":"1.1","curr_dt":"2026-11-05","token":null}' https://interruptions.energy.cn.ua/api/info_schedule_part   # → 400 No captcha
```

### `info_schedule_part` response format (UNVERIFIED — from `interruptions.js` only, no real sample obtained)

```
{ "status": "...", "aData": [ { "time_from": "00:00", "time_to": "02:30", "queue": "<stateKey>" }, ... ],
  "aState": { "<stateKey>": { "color": "#...", "name": "<legend text>" } } }
```

Each `aData` row is a time segment whose `queue` field is a key into `aState` (legend: off / on / maybe — names UNVERIFIED). Conversion: segments whose state means "off" become `{start,end,kind:'off'}` in Europe/Kyiv on `curr_dt`. The UI asks for tomorrow only after 23:00. No captured real sample, and no public repo has a fixture of it (searched: OlegVapnik/svitlo, zenki-deve/Chernihiv-Svitlo-Bot, mrkaktuz/outages-data).

## Image fallback (`schedule_groups.jpg`)

- Title `ГРАФІК ПОГОДИННИХ ВІДКЛЮЧЕНЬ DD.MM.YYYY`, then 12 cards. Each card is `N.M` followed by 1–3 lines `HH:MM - HH:MM`, where `00:00` as an end means midnight/24:00. Only "off" intervals; no "maybe".
- 05.11.2026 content (transcribed from the saved image, matches the aggregator): 1.1 00:00-02:30, 09:30-16:30, 20:00-00:00; 2.1 06:00-13:00, 16:30-22:00; 2.2 08:00-13:00, 16:30-23:30; 3.2 02:30-06:00, 09:30-16:30, 20:00-00:00; 4.1 02:30-09:30, 13:00-20:00, 23:30-00:00; 5.1 02:30-09:30, 13:00-20:00; 6.1 00:00-02:30, 06:00-13:00, 16:30-22:00; 6.2 00:00-02:30, 08:00-13:00, 16:30-23:30. 1.2 = 1.1, 3.1 = 1.1, 4.2 = 4.1, 5.2 = 5.1.
- Only one date at a time; tomorrow's replaces today's (UNVERIFIED timing).
- Telegram channel `https://t.me/s/chernigivoblenergo` (public HTML preview, plain fetch 200) posts text announcements ("6 листопада в області діятиме ГПВ") **without** the intervals (the image is attached). It's useful only as an "is ГПВ active" signal.

## Freshness / failure modes

- Image: `Last-Modified` header and the date in the image title.
- `energy.cn.ua` unreachable (connect timeout). Don't use that host. `chernigivoblenergo.com.ua` (91.201.232.16) also timed out.
- Turnstile sitekey is loaded via `challenges.cloudflare.com/turnstile/v0/api.js`; there are also commented-out reCAPTCHA keys. Policy: no captcha solving ⇒ the SDK can't use the JSON API unless the operator opens it.

## Saved files

- `interruptions-iframe-page.html`, `interruptions.js` — official iframe page and its JS (endpoint and format source of truth).
- `api-info_disable-city.json`, `api-info_disable-city-nizhyn.json`, `api-info_disable-street.json`, `api-info_disable-house.redacted.json` — token-free autocomplete (EICs replaced with `62Z_REDACTED`).
- `api-info_schedule_part-no-captcha.400.json`, `api-info_schedule_part-bad-captcha.403.json` — failure bodies.
- `gpv-image-2026-11-05.downscaled.jpg` — official schedule poster for 05.11.2026, downscaled to 1000 px tall (the original is 1200×2036, 1.2 MB).
- `aggregator-yaroslav2901-Chernihivoblenergo.json` — **populated example** from yaroslav2901/OE_OUTAGE_DATA (third-party, no license), `fact.data["1793829600"]` = 05.11.2026 with GPV1.1..6.2 hour slots (`yes|no|first|second`). Its upstream is unknown (likely the image or the captcha API).

## Reference repos

- OlegVapnik/svitlo (no license) — documents the Turnstile gating and the `info_schedule` stub; uses Cloudflare Browser Rendering. Also `/power_outages` + `/api/list_acc` for emergency lists (not ГПВ).
- zenki-deve/Chernihiv-Svitlo-Bot (no license) — calls the endpoints with `token: None`. That **no longer works**.
- mrkaktuz/outages-data (license NOASSERTION) — AGENTS.md notes the Turnstile gating.
