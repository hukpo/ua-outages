# DTEK Odesa Grids (dtek-oem.com.ua) — and the shared DTEK site protocol

Researched 2026-11-05 (~23:30 Europe/Kyiv). Status: **works with plain Node `fetch`** (page + embedded JSON + AJAX address lookup),
from one Ukrainian residential IP. The other DTEK sites (kem, krem, dnem, dem) served Incapsula challenges at the same
moment — see their NOTES.md. Imperva decisions are per-site/IP/time, so oem may get blocked too: the SDK must detect it.

The same Yii2 frontend (`/src/js/static/discon-schedule.js`) and protocol is used on all DTEK sites
(`www.dtek-{kem,krem,dnem,dem,oem}.com.ua`; `www.dtek-zem.com.ua` does **not resolve** in DNS).

## 1. Schedule page — `GET https://www.dtek-oem.com.ua/ua/shutdowns`

```
curl -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \
     -H 'Accept: text/html' -H 'Accept-Language: uk-UA,uk;q=0.9' https://www.dtek-oem.com.ua/ua/shutdowns
```

200, ~930 KB HTML. Sets cookies: `dtek-oem` (Yii session), `_language`, `_csrf-dtek-oem` (Yii CSRF cookie), `visid_incap_*`, `incap_ses_*`.
Even the good page contains `<script src="/_Incapsula_Resource?SWJIYLWA=...">` → **do not use the presence of
`_Incapsula_Resource` alone as a block signal**; use "no `DisconSchedule.fact` / no `csrf-token` meta and body < ~5 KB".

Head contains:

```html
<meta name="ajaxUrl" content="/ua/ajax" />
<meta name="csrf-param" content="_csrf-dtek-oem" />
<meta name="csrf-token" content="..." />
<!-- needed for POST /ua/ajax -->
```

One inline `<script>` (one line per assignment) contains:

```
DisconSchedule.streets = {...}            // { "<city>": ["<street>", ...] }  909 cities / 14 312 streets, ~300 KB
DisconSchedule.preset = {...}             // weekly template (see §3)
DisconSchedule.showCurOutage = true       // UI flags (also showCurSchedule, showTableSchedule, showTablePlan,
...                                       //   showTableFact, showUserGroup) — booleans
DisconSchedule.currentWeekDayIndex = 4    // 1=Mon … 7=Sun (Thursday 2026-11-05 → 4)
DisconSchedule.fact = {...}               // actual today/tomorrow schedule (see §3)
```

Extraction: regex `DisconSchedule\.(\w+)\s*=\s*` then a JSON parser starting at the match end (values are valid JSON;
the object is followed by `\n` or `</script>`). Files: `shutdowns.trimmed.html` (real markup; streets trimmed, preset/fact verbatim,
CSRF redacted), `disconschedule.preset.json`, `disconschedule.fact.json` (extracted, verbatim).

## 2. AJAX — `POST https://www.dtek-oem.com.ua/ua/ajax`

`application/x-www-form-urlencoded`, jQuery `$.post` style. Required:

- Cookies from the page GET — at least `_csrf-dtek-oem` (+ session `dtek-oem`). Incap cookies were **not** required (tested).
- Header `X-CSRF-Token: <meta csrf-token>` (Yii's `yii.js` adds it to every non-GET jQuery request).
- Recommended: `X-Requested-With: XMLHttpRequest`, `Referer: …/ua/shutdowns`, `Accept: application/json, text/javascript, */*; q=0.01`.
- Without token/cookie → **400** `text/html` `Bad Request (#400): Не вдалося перевірити передані дані.`
  (same body is returned by kem/dnem `/ua/ajax` — i.e. the AJAX endpoint itself is NOT behind the Incapsula challenge there,
  only the HTML pages are; but a CSRF token can only be obtained from an HTML page).

Responses are `application/json`; `{"result": false, ...}` = failure/no-change.

| method              | form fields                                                                                                                                                                                                                                          | response                                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getStreets`        | `method=getStreets` (nothing else)                                                                                                                                                                                                                   | `{result:true, streets:{city:[street...]}}` — whole region, ~270 KB. Same as `DisconSchedule.streets`. → `ajax-getStreets.trimmed.json`                                                                                                                                                                 |
| `getHomeNum`        | `method=getHomeNum`, `data[0][name]=city`, `data[0][value]=м. Одеса`, `data[1][name]=street`, `data[1][value]=вул. Варненська`, optional `data[2][name]=updateFact`, `data[2][value]=05.11.2026 21:31` (the page also sends `house_num`; not needed) | see below → `ajax-getHomeNum-odesa-varnenska.json`                                                                                                                                                                                                                                                      |
| `checkDisconUpdate` | `method=checkDisconUpdate`, `update=<DD.MM.YYYY HH:MM>`                                                                                                                                                                                              | if server's `fact.update` is newer: `{result:true, fact, preset, showTableSchedule, showUserGroup}` (`ajax-checkDisconUpdate.json`, sent `update=01.01.2000 00:00`); else `{"result":false}` (`ajax-checkDisconUpdate-nochange.json`). **Lightweight way to poll the schedule (33 KB vs 930 KB page).** |
| `getCekText`        | `method=getCekText`                                                                                                                                                                                                                                  | not tested                                                                                                                                                                                                                                                                                              |

`getHomeNum` response (`fact`/`preset` were **not** included today, with or without `updateFact`):

```jsonc
{ "result": true,
  "data": { "<house number>": {
      "sub_type": "Стабілізаційне відключення (Згідно графіку погодинних відключень)" | "",
      "start_date": "19:31 05.11.2026" | "",   // current outage window for this house, "HH:MM DD.MM.YYYY" Kyiv local
      "end_date":   "01:30 06.11.2026" | "",
      "type": "2" | "",                         // reference: "1" planned works, "2" other/stabilisation (UNVERIFIED)
      "sub_type_reason": ["GPV2.2"],            // group(s); [] = not in any group; 2+ = multi-group house
      "voluntarily": null, "cek": null } },
  "showCurOutageParam": true, "showCurSchedule": true, "showTableSchedule": true, "showTablePlan": false,
  "showTableFact": true, "showUserGroup": true, "updateTimestamp": "23:18 05.11.2026" }
```

House keys are free-form (`"7/корп.2"`, `"б/н"`, `"5/2"`, `"7б"`); 110 houses on this street, 4 of them in two groups
(e.g. `["GPV3.1","GPV4.1"]`). Unknown street → `{"result":false,"text":"Error"}` (`ajax-getHomeNum-unknown-street.json`).
From the site JS: if a city has streets `[""]` (no streets) the page calls getHomeNum with empty street and gets a single key `"-"` (UNVERIFIED live).

## 3. Schedule JSON (`preset`, `fact`)

`preset`:

- `days` {"1":"Понеділок",…,"7":"Неділя"}, `days_mini`, `sch_names` {"GPV1.1":"Черга 1.1", … "GPV6.2"}
- `time_zone` {"1": ["00-01","00:00","01:00"], …, "24": ["23-24","23:00","24:00"]} → **24 hourly slots** (not 30-min; the shed-crypto README/const say 30-min — that's wrong for current data)
- `time_type` legend: `yes` Світло є · `no` Світла немає · `maybe` Можливо відключення · `first` не буде перші 30 хв · `second` не буде другі 30 хв · `mfirst` можливо не буде перші 30 хв · `msecond` можливо не буде другі 30 хв
- `data`: `{ "GPV1.1": { "1".."7" (weekday, 1=Mon): { "1".."24": value } } }` — weekly "probable" template. Today only yes/maybe/mfirst/msecond.
- `updateFact`: "05.11.2026 21:31"
- Empty schedule is encoded as `[]` instead of `{}` (site JS checks `.data.length==0`) — handle both.

`fact`:

- `today`: 1793829600 = unix ts of **local midnight Europe/Kyiv** (2026-11-04T22:00Z)
- `update`: "05.11.2026 21:31" (DD.MM.YYYY HH:MM, Kyiv local) — **freshness field**
- `data`: `{ "<unix ts of local midnight>": { "GPV1.1": { "1".."24": value } } }` — today + tomorrow (when published).
  Today only yes/no/first/second observed.
  Gotcha: compute tomorrow's key from the date in Europe/Kyiv, not `today + 86400` (DST days are 23/25 h).

**Group naming:** `GPV<queue>.<sub>` → strip `GPV` → `1.1`…`6.2` (12 groups on oem).

**Mapping slot → intervals** (slot key n, hour h = n-1, local date D):
`no` → off [h:00, h+1:00) · `first` → off [h:00, h:30) · `second` → off [h:30, h+1:00) ·
`maybe` → maybe [h:00,h+1:00) · `mfirst` → maybe [h:00,h:30) · `msecond` → maybe [h:30,h+1:00) · `yes` → nothing.
Merge adjacent same-kind intervals. Use `fact` for concrete dates; `preset` only as a weekly "possible" fallback.

## Address search flow

1. GET page → keep cookies + csrf token + `DisconSchedule.streets` (city list & street list are local — no request per keystroke).
2. User picks city (key of `streets`), then street (item of `streets[city]`).
3. POST `getHomeNum` (city, street) → pick house key → `sub_type_reason` → group(s).

## Rate limits / WAF observed

~10 requests over a few minutes: no throttling. Imperva Incapsula in front of every DTEK site. No `429` seen.

## References

- https://github.com/shed-crypto/dtek-blackout-client — **MIT**. Python; uses `curl_cffi` with `impersonate="chrome120"`
  (TLS fingerprint impersonation) + optional Playwright+stealth `browser_auth.py` to get cookies/CSRF when challenged.
  Supports kem, krem, dnem, dem, oem, zem. Fixtures in `tests/fixtures/home_num_response.json`.
- https://github.com/groove-max/ha-dtek-monitor — **PolyForm Noncommercial 1.0.0 (NOT open-source-compatible; don't copy code)**.
  oem only; also `curl_cffi` Chrome impersonation, with the comment "aiohttp is served the Incapsula interstitial instead of the real shutdowns page".
  Sends `X-Csrf-Token` from page meta.
  Both reference projects resort to TLS impersonation / headless browsers — i.e. a plain-HTTP SDK should expect DTEK sites to be unreliable.
