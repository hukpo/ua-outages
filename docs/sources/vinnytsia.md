# Vinnytsiaoblenerho (АТ «Вінницяобленерго», Вінницька обл.) — research notes

Researched 2026-11-05, again 2026-11-17 (last section). **Verdict: there is no official machine-readable daily GPV source you can get with plain fetch.**
The live per-address schedule tool sits behind a Cloudflare managed challenge. What plain fetch can reach:
(a) a rotating "орієнтовний" weekly table, shown as an image (per черга, not per підчерга), (b) an address→підчерга
directory as a PDF, (c) news posts that say "ГПВ will apply on date X" without any per-group hours.

## Domains

- `www.voe.com.ua` / `voe.com.ua`: Drupal 9/10 site. Plain fetch works (200), no WAF challenge seen.
- `disconnection.voe.com.ua`: the "Чому немає світла?" / online GPV by address tool. **Every path returns 403 with Cloudflare "Just a moment..."**
  (`cf-mitigated: challenge`), whether from curl with a browser UA or from Node `fetch` with the default UA. Paths tried: `/`, `/robots.txt`, `/api`,
  `/disconnection/detailed`, `/disconnection/detailed/autocomplete/read_city?q=...`. Sample: `disconnection.voe.com.ua.403-cf-challenge.html`.
- `https://www.voe.com.ua/disconnection/detailed` → 301 to `https://disconnection.voe.com.ua/`. The old autocomplete paths on `www`
  (`/disconnection/detailed/autocomplete/read_city`) now return 404, and the POST form returns 404.
- `vn.e-svitlo.com.ua`: personal cabinet. `show_only_disconnections?eic=` → 303 to `/user/login`, so it needs an account login. **Out of scope.**
- Telegram bot `@pat_voe_bot`, Viber `chats.viber.com/patvoe`: official channels. Bots are not fetchable.

## 1. Live per-address schedule — disconnection.voe.com.ua (BLOCKED)

How the tool worked when it was unprotected, reconstructed from community code (MarKisses/tg-voe-bot `app/services/fetcher.py` + `parser.py`,
2pasha/lighter `app/services/voe_client.py`). **UNVERIFIED today because of the challenge.**

- `GET /disconnection/detailed/autocomplete/read_city?q=<text>` → Drupal autocomplete JSON `[{value,label}]`. The label may hold
  `<div class="change_api_autocomplit" data-id="...">`.
- `GET /disconnection/detailed/autocomplete/read_street/{cityId}?q=`
- `GET /disconnection/detailed/autocomplete/read_house/{streetId}?q=`
- `POST /disconnection/detailed?ajax_form=1&_wrapper_format=drupal_ajax` (form body `search_type=0&city_id&street_id&house_id&form_id=disconnection_detailed_search_form`)
  → Drupal AJAX command array. The `insert` command's `data` is HTML containing:
  - `div.disconnection-detailed-table p` texts: first = `"6.2 черга"` (the group), then status text.
  - `div.disconnection-detailed-table-container > div.day_col`: day labels (today, tomorrow).
  - `div.disconnection-detailed-table-cell.cell`: 24 cells per day, with full/half "fill" classes for off/maybe and 30-min halves.
  - The site also offers lookup by EIC and особовий рахунок (account number; personal data).
- MarKisses/tg-voe-bot gets through via **FlareSolverr (headless browser)**, which confirms that plain fetch can't. 2pasha/lighter treats it as
  "live blocked" and falls back to other sources.
- The SDK should detect the block as: status 403 + `cf-mitigated: challenge` header, or body containing `Just a moment...`.

## 2. Official rotation forecast (image) — www.voe.com.ua (plain fetch OK)

- Page: `GET https://www.voe.com.ua/informatsiya-pro-cherhy-hrafika-pohodynnykh-vidklyuchen-hpv-1`
- The table is a **base64 PNG inlined in the page body** (`<div class="node page page-7894 ..."> ... <img src="data:image/png;base64,...">`,
  the first `data:image/png` in the HTML, about 49KB base64). Saved decoded as `official-rotation-forecast-2026-10-26_to_11-15.png`.
- Content: 3 weekly blocks ("Години можливого застосування ГПВ із 26 жовтня по 01 листопада", "02–08 листопада", "09–15 листопада").
  Rows: **1..6 черга only (not x.1/x.2)**. Columns: 12 two-hour slots (0–2 … 22–24), each split into two 1-hour cells.
  Colours: blue `#00B0F0`-ish = possible outage when the level is 0.5–2 черги; yellow = possible at 2.5–4 черги; white = power on.
- Meaning: this is the _possible_ window per черга, depending on the level Ukrenergo sets. **It is not today's actual schedule.**
  Map it to `kind:"maybe"` only. Both x.1 and x.2 inherit the черга row. Weeks repeat with a shifting pattern; whether
  the rotation can be extrapolated is UNVERIFIED.
- Image-only, so the SDK would need pixel sampling (fixed grid; the cell centres can be hard-coded from this 777×858 layout, but the layout can change).
- Freshness: none, apart from the date ranges in the image titles. The image is replaced in place.

## 3. Address → group directory (PDF) — plain fetch OK

- `GET https://www.voe.com.ua/sites/default/files/2026-09/gpv-2026-2027-na-sayt.pdf` (436KB, 34 pages, generated from Excel 22.09.2026,
  valid "з 1 жовтня 2026 по 1 квітня 2027"). Linked from the page in §2 as "ГПВ ВОЕ 2026-2027 … Завантажити".
  The URL changes each season, so take it from the page's `href` matching `/sites/default/files/.*\.pdf`.
- Text is extractable (`pdftotext -layout`; sample `gpv-2026-2027-address-directory.pdftotext-layout.txt`, trimmed).
  Structure: section `СО "ВМЕМ"` / `СО "ВЦЕМ"` / `СО "ВСЕМ"` / РЕМ… → header `N черга` → rows `"1.1  <free text: streets + house ranges>"`.
  A row's text wraps across lines, and the підчерга code sits at the vertical middle of the wrapped block (sometimes on an otherwise empty line).
- The house lists are free text ("вул. Соборна 1,6-17,15а,19-27"), mixed with legal entities ("ТОВ ...", "ЗОШ№17") and villages ("с. Уладівське (вул. ...)").
  Matching is fuzzy: workable for a best-effort "which підчерга?" but not exact (overlaps and duplicate addresses in different groups are likely).
- 2pasha/lighter builds `data/voe_addresses.json` (1.2MB) from this same PDF. That repo has no license.
- No official structured address API without the CF challenge.

## 4. News "Введення ГПВ" — plain fetch OK (signal only)

- `GET https://www.voe.com.ua/news` → links `/news/vvedennya-hpv-<n>` titled "Введення ГПВ" (and `zaprovadzhennya-hop-<n>` for ГОП, industrial).
- The body says when GPV applies ("Дата та час відключень - 06.11.26. Будуть застосовані з 00:00 - 24:00"), **with no per-group hours**.
  Sample: `news-vvedennya-hpv-123.2026-11-05.txt`.
- The homepage "Стан енергосистеми" block (`.accident-info img[data-description]`) carries a status text, e.g. "вимушено запроваджені графіки погодинних
  відключень … Прогнозований період: 00:00-23:59". Useful as an "active today" flag.

## Populated examples (THIRD-PARTY, not official)

- `thirdparty-vn-progr-bezsvitla-Vinnytsiaoblenerho.json`: current (fact.update 05.11.2026 23:40), from vn-progr/gpv-voe-vinnytsia,
  which scrapes **bezsvitla.com.ua** (a third-party site), not VOE. Format = yaroslav2901 OE_OUTAGE_DATA style
  (`fact.data[dayTs]["GPV1.1"]["1".."24"] = yes|no|first|second`, where slot N = hour N-1..N). Shows GPV1.1 off 02–04, 08–10, 15–16, 20–22 today.
- `thirdparty-olnet93-esvitlo-2025-12-Vinnytsiaoblenerho.json`: Dec 2025 data from olnet93/gpv-voe-vinnytsia, which logs into
  **vn.e-svitlo.com.ua with an account + cloudscraper** and calls `/account_household/show_only_disconnections?eic=<EIC per queue>`. Excluded for us
  (needs credentials, uses WAF bypass).
- yaroslav2901/OE_OUTAGE_DATA has **no** Vinnytsia file.

## Converting to {start,end,kind}

- From the rotation image: for each черга row, each 1-hour cell that is coloured → `{start:H:00,end:H+1:00,kind:"maybe"}`, merging adjacent cells. Apply to both x.1 and x.2
  for each date in the block's date range (Europe/Kyiv).
- From the yaroslav-style JSON (fixtures only): slot N covers [N-1:00, N:00). `no` = whole hour off, `first` = :00–:30 off, `second` = :30–:00 off,
  `maybe` = maybe. Merge adjacent pieces.

## Reference repos

| repo                                                   | what                                                                      | license |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------- |
| olnet93/gpv-voe-vinnytsia                              | e-svitlo login + cloudscraper                                             | none    |
| vn-progr/gpv-voe-vinnytsia                             | bezsvitla.com.ua HTML scrape                                              | none    |
| MarKisses/tg-voe-bot                                   | disconnection.voe.com.ua via FlareSolverr; documents the Drupal endpoints | none    |
| 2pasha/lighter                                         | PDF address index, GitHub mirror, Telegram bot image parsing              | none    |
| ripiuk/voe_disconnect, scorpp/voe-outage-calendar-sync | old (2024) Drupal-endpoint clients                                        | MIT     |
| kodexxx/voe-disconnections-lambda                      | AWS lambda + "voe-proxy-app"                                              | none    |

## Failure modes / gotchas

- The CF challenge on disconnection.voe.com.ua is the main blocker. Recommendation: mark Vinnytsia "schedule: unsupported (WAF)"; offer
  `maybe`-only data from the rotation image plus an "active today" flag from news/homepage, and fuzzy address→підчерга from the PDF.
- The rotation image covers черги 1–6, while the address directory uses підчерги 1.1–6.2.
- No rate limits seen on www.voe.com.ua (a handful of requests).

## Status 2026-11-17: what the SDK does

Checked again from a Ukrainian residential address with the SDK's default User-Agent. Still no official channel with the hours
per queue that a plain request can read. The SDK reads nothing by default (`capabilities.schedule` false, `unsupported`); with
`unofficialSources: true` it reads one community mirror and marks it `official: false` (`src/providers/vinnytsia.ts`).

### Official channels, and why each is closed

| Channel                                                                        | What it has                                                                                                                                                                            | 2026-11-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disconnection.voe.com.ua` (schedule by address, EIC or account)               | today and tomorrow, 24 cells per day                                                                                                                                                   | every route 403 `cf-mitigated: challenge`, "Just a moment...": `/`, `/disconnection/detailed`, the autocomplete, `POST …?ajax_form=1&_wrapper_format=drupal_ajax` with `X-Requested-With`. No unchallenged route (unlike dtek-krem's `/ua/ajax`)                                                                                                                                                                                                                                                                                                    |
| `vn.e-svitlo.com.ua` (cabinet; the service the Sumy provider reads)            | a consumer's schedule                                                                                                                                                                  | `POST /ip_cabinet/restfull_api/improvise/api_main/get_user_disconnections_image_api.json`, `cherga=<queue>&mobile_v=true`: 200 `{"error": {"no_data": true, "cherga_n": "За даною адресою графіки не застосовуються", "err": "object of type 'NoneType' has no len()"}}` for `1.1`, `1`, `11`, `1/1`, `Черга 1.1`, at 13:28 while ГПВ was in force. With `a=290637` (the branch id in the cabinet's URLs): "Ви не увійшли до кабінету". The by-queue table Sumy has is not filled for Vinnytsia; the cabinet shows the schedule per EIC after login |
| Telegram                                                                       | `@pat_voe_bot` (a bot); `t.me/+IdXSOUC…` from the site's header: a private channel with grid-status notices                                                                            | not readable by HTTP. Public `@vinoblenergo` (named in the operator's news of 11.09.2024) holds two posts from 01.12.2024                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Viber                                                                          | `chats.viber.com/patvoe` (a bot)                                                                                                                                                       | not readable by HTTP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Facebook `facebook.com/vinoblenergo`                                           | the hours per queue as text ("Черга 1.1: 🔴 06:00 – 08:00; 12:00 – 14:00; 18:00 – 20:00"); local news reprint it                                                                       | posts are not in the page or the page plugin without a login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `www.voe.com.ua/news`                                                          | "Введення ГПВ", "Зміни по ГПВ": "Дата та час відключень - 17.11.2026. Будуть застосовані з 06:00 - 24:00"                                                                              | plain fetch works; no hours per queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `www.voe.com.ua/informatsiya-pro-cherhy-hrafika-pohodynnykh-vidklyuchen-hpv-1` | a table of _possible_ hours per queue 1–6 (no subqueues) for three weeks, inline PNG; `gpv-2026-2027-na-sayt.pdf` (34 pages, 28.09.2026): streets and houses per subqueue as free text | plain fetch works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The table is not the schedule. For 17.11 the hours the operator announced fit inside its coloured cells; for 16.11 queue 3.1 was
off 04:00–08:00, 10:00–14:00, 16:00–20:00 and 22:00–24:00, partly in cells the table leaves white.

Regional administration and council channels (`@VinnytsiaODA`, `@vinrada`) post no hours per queue.

### The mirror (opt-in)

`https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json`, the same shape as the DTEK
pages' `fact`: `fact.data[<unix midnight>]["GPV1.1"]["1".."24"]` = `yes` / `no` / `first` / `second` …, plus `lastUpdated` (unix
seconds of the mirror's run) and `lastUpdateStatus.ok`.

- Chain: operator's site → bezsvitla.com.ua (third party; "Ми не є офіційним джерелом") → `scripts/parser.py` in the repository
  (12 queue pages and their `/grafik-na-zavtra`, hours rounded to half an hour) → the file. The repository has no licence.
- `fact.update` is the time of the mirror's run, so the SDK gives `updatedAt: null`.
- Tomorrow is all `yes` until the operator publishes it, so a day with no outage in any queue is read as `unknown`.
- Refused with `parse`: `lastUpdated` older than 3 hours, `lastUpdateStatus.ok === false`, no `fact`.
  The older mirror olnet93/gpv-voe-vinnytsia (cabinet login with EIC codes) stopped on 14.12.2025 and still serves that day.
- 17.11.2026 14:25: 12 queues, e.g. 2.1 off 06:00–08:00 and 18:00–20:00. Several queues had fewer hours than the operator's
  morning post (2.2: only 18:00–20:00 against 06:00–08:00, 12:00–14:00, 18:00–20:00). Not established which was current
  after the day's changes.

### Not done

- Address lookup from the operator's PDF (official, open; free text like Rivne's).
- A reader for `disconnection.voe.com.ua` behind a caller's own allowlisted `fetch`: the response format is known only from
  community code, never seen here.
