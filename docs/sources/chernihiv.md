# Chernihivoblenergo (Чернігівська) — research notes

Researched 2026-11-05 (~23:40 Europe/Kyiv). ГПВ was **active** on 05.11 and announced for 06.11.

## TL;DR

- **Domains**: `energy.cn.ua` (37.52.15.98) and `www.energy.cn.ua` (.99) **time out** on 80/443 from here. They are probably the legacy portal and/or geo/firewall-restricted (UNVERIFIED). The live official site is **`https://chernihivoblenergo.com.ua`** (Apache, no WAF). The outage tool is an iframe from **`https://interruptions.energy.cn.ua/interruptions`** (CNAME webhook.energy.cn.ua → 94.131.247.142), which is reachable.
- **Machine-readable schedule exists but is captcha-gated**: `POST /api/info_schedule_part` requires a **Cloudflare Turnstile token**. With no token it returns `400 {"error":"No captcha"}`; with a bad one, `403 {"error":"Captcha failed"}`. ⇒ **Plain fetch cannot get the schedule.** The old token-less `POST /api/info_schedule` now returns an HTML 404 (and per OlegVapnik/svitlo it previously always returned `aData:null`).
- **Only token-free official schedule = a JPEG**: `https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg` ("Години застосування ГПВ" button on /blackouts). It's a 1200×2036 ~1.2 MB poster with 12 group cards listing `HH:MM - HH:MM` off intervals for one date. It's overwritten in place (Last-Modified tells you when; 05.11 05:59 UTC, EXIF 2026-11-04 20:39). It's OCR-able (clean typeset digits), but OCR is outside "no headless browser/captcha" scope; decide in the SDK whether to support it.
- **Address search**: the city → street → house autocomplete is **token-free**, but house → queue (`info_disable_house`, `number_queue`) is **Turnstile-gated**. ⇒ No address→group from this API without the captcha; the SDK reads the operator's PDF list instead (see "Address lookup" below).
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
- Only one date at a time. The file switches to a day's poster in the **morning of that day** (`Last-Modified` 07:15, 07:59, 08:05 on the three days measured) and is not touched again that day.
- Telegram channel `https://t.me/s/chernigivoblenergo` (public HTML preview, plain fetch 200) posts the same poster for **tomorrow the evening before** ("6 листопада в області діятиме Графік погодинних відключень (ГПВ)", the image attached, 471×800), and every change during the day. See "How the SDK reads it".

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

- OlegVapnik/svitlo (no license) — documents the Turnstile gating and the `info_schedule` stub; uses Cloudflare Browser Rendering. Also `/power_outages` + `/api/list_acc`. Checked 2026-11-16: `list_acc` with `t=6` needs no token and returns today's ГПВ windows per street, as rows of town, street, houses, from, to, date and type ("Графік погодинних відключень (ГПВ)"). The rows name no group. Groups often share a window, so the group can't be worked out from them reliably.
- zenki-deve/Chernihiv-Svitlo-Bot (no license) — calls the endpoints with `token: None`. That **no longer works**.
- mrkaktuz/outages-data (license NOASSERTION) — AGENTS.md notes the Turnstile gating.

## How the SDK reads it (2026-11-17)

Two channels of the operator, merged with `mergeSources` (`src/providers/sources.ts`); `sources` in the result lists both.

| Source id                      | What                                                                          | Day it is for                    | `publishedAt`                                                        |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `site`                         | `…/files/other/schedule_groups.jpg`, 1200×2036                                | the date in the poster header    | time of the Telegram post with the same poster; else `Last-Modified` |
| `telegram:@chernigivoblenergo` | photos and texts of `https://t.me/s/chernigivoblenergo` since yesterday 12:00 | the date in each poster's header | time of the last post that changed that day                          |

**Which is first** (research/freshness/CHANNELS-A.md, 01–16.11.2026): Telegram gets tomorrow's poster the evening before, 20:22–23:18 on 16 of 16 days; the site switches at 07:15–08:05 of the day itself, 9.6–11.5 h later, and between midnight and that upload it still serves yesterday's poster. Changes during the day (22 posts on 9 of 16 days, one re-issued poster) appear on Telegram only.

**Merge rule**: per date, the channel with the newest `publishedAt` wins. So tomorrow comes from Telegram. The morning upload is the evening's poster as it was (16.11.2026: the cards of post 5718, though the channel had changed the day at 07:14), so it is not a new publication: a file showing a poster the channel posted for that date is as old as that post. Today then comes from the site (a tie goes to the first source; the same picture at full size) only while Telegram has posted no change since that poster; a change posted overnight or during the day keeps the day with Telegram, and the upload never undoes it. A site poster the channel doesn't have (or the channel unreadable) keeps the file's `Last-Modified`. A site poster dated before today gives no day at all. The result holds today and tomorrow whenever Telegram has tomorrow. One channel failing leaves the other's days and an `ok: false` entry in `sources`; both failing is an error.

`updatedAt` is the newest of: the time of the poster post (also for the site's copy of it; the file's `Last-Modified` only when the channel has no such poster), the time of the last "маємо зміни … на D" post for a day in the result.

### Telegram

- The preview page's `background-image` (471×800) is the largest copy a plain fetch gets: `…/<id>?embed=1&mode=tme` links the same file, `og:image` of the post page is 188×320 (checked 17.11.2026). CDN links expire, so pictures are fetched right after the page.
- A picture is a schedule poster when it is portrait and has the twelve orange cards. Of 60 photos of 25.10–16.11 that left 12 posters and 48 others, none wrong. The caption ("… діятиме Графік погодинних відключень", "значні зміни у Графіку погодинних") is only a cross-check: a post that says it carries the schedule and whose picture can't be loaded or isn't the poster fails the whole channel (`parse`). A poster nobody can see may be newer than every one that can, so an older one must not pass for current.
- The header date decides the day. It must be the day of the post or the next one and equal the day the caption names, otherwise `parse`.
- **"ОНОВЛЕНИЙ"** (a red stamp right of the date; 26.10 08:57 and 02.11 14:48): the re-issue lists only the rest of its day, from a round time shortly before the post (08:00, 14:30), with running outages cut to begin there. It is laid over the day's earlier poster: everything before that moment is kept, everything after replaced. Without an earlier poster in the window it stands alone, and the hours before it show no outages.
- **Changes in words** ("📊 … маємо зміни у Графіку погодинних відключень (ГПВ) на 16 листопада"). Applied only where the words are exact:
  - `З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2`: the outage is added.
  - `До 17:00 продовжується відключення для черг 4/1 та 4/2`: the last outage of the poster that begins before 17:00 now ends at 17:00, if it is running at the time of the post or still ahead (on 02.11 "До 17:00 продовжується … 6/1" at 11:20 was about the outage due at 12:00).
  - `З 07:15 починається відключення для …` and `З 22:00 відключаються …` give no end: not applied, and the groups the line names are `unknown` for that day from then on (since 0.4.4; see below). A later "продовжується" for the same group isn't applied either, since it may be about that outage.
  - `До 01:00 продовжується …` that fits no outage of the poster (15.11 00:11, an outage running over from the day before): the group is `unknown` too.
  - A post for two days ("на 3 та 4 листопада") doesn't say which line is for which day: not applied, and the groups its lines name are `unknown` on both days.
  - A line with a time and "черг" but no group that can be read: every group is `unknown`.
  - In every case the day's `publishedAt` (and so `updatedAt`) moves to the post's time and the post becomes the source's `url`.
  - **Why `unknown` (0.4.4).** Until 0.4.3 such a group kept the poster's hours while the day's `publishedAt` moved to the change post: an old schedule with a new time, which also beat the site's copy of the same poster. The outage the post announces is real and its end isn't given, so the poster's hours are known to be wrong and nothing exact can replace them. The group's day is `unknown` until the next poster ("ОНОВЛЕНИЙ" or tomorrow's) states it again, as `src/providers/cek-telegram.ts` does for ЦЕК. The other groups keep their hours; `assessFreshness` lists `partial`. On the saved posts: 14.11 by 18:30 seven of twelve groups (1/1, 1/2, 3/1, 3/2, 4/1, 4/2, 5/2), 16.11 by 10:30 four (2/1, 2/2, 5/1, 5/2).
- No cancellation wording has been seen; an unknown line changes nothing.

### The poster reader (`src/image/cards.ts`)

Baseline JPEG decoder (`src/image/jpeg.ts`), the twelve cards by colour, text lines by ink rows. No OCR and no splitting into glyphs: at 471 px the digits touch each other and the colons. A line is resampled to 24 px height and explained as a whole by a font model (`src/image/digit-model.ts`): a dynamic program lays "dd:dd-dd:dd" over it, picking every digit and position at once; each pixel is scored against the average picture of the character and its spread among the training samples. The model is built by `scripts/train-digits.ts` from the labelled posters in `test/fixtures/chernihiv/posters` (`labels.json`), one font per typography ("thin" until 05.11.2026, "bold" since).

Guards, any of which makes the poster a `parse` error:

- twelve cards; every text line of every card is a time range or the card is "відключень не прогнозується" as a whole (the old reader skipped a line it couldn't split and lost an outage on 14.11);
- the typography that explains all lines best reads the poster; one that explains them nearly as well must read the same;
- per line: its cost, each character's cost, each digit's margin over the runner-up (`LIMITS`), and no other vertical cut of the line that fits nearly as well may read something else (a cut half a pixel off turns a 6 into a 5 or an 8);
- times: hour ≤ 23, minutes 00/15/30/45 (only :00 and :30 occur on the 36 labelled posters), from < to with 00:00 as an end meaning 24:00, lines of a card ascending without overlap;
- the header date ("DD.MM.YYYY", or "D.MM.YYYY" as on 1.11.2026) read the same way; the site poster must be dated today or tomorrow and no later than the day after its upload.

Measured on the 36 labelled posters (`npx tsx scripts/train-digits.ts --check`; test/providers/chernihiv.test.ts asserts the same): none is read wrongly, the ones not read are refused.

| Posters                                                                 | Read exactly | Refused                                           |
| ----------------------------------------------------------------------- | ------------ | ------------------------------------------------- |
| Telegram 471×800, current typography (06.11–17.11)                      | 12 of 12     | 0                                                 |
| Telegram 471×800, earlier typography (26.10–05.11), incl. 2 "ОНОВЛЕНИЙ" | 11 of 12     | 1: a stray comma on the poster ("08:30 - 12:00,") |
| Site 1200×2036                                                          | 3 of 3       | 0                                                 |
| Downscaled 530×900                                                      | 1 of 1       | 0                                                 |
| October layout, 533×800                                                 | 7 of 7       | 0                                                 |
| October layout, 566×800 (digits 9 px tall)                              | 0 of 1       | 1: not confident                                  |

Other notes:

- TLS: the site sends only its leaf certificate (no Sectigo DV R36 intermediate). Browsers and curl fill it in, Node fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The SDK ships that public intermediate (`src/certs.ts`) and adds it to Node's roots for this request only.
- When the operator changes the font: label a few new posters in `labels.json` under a new typography name and rerun `scripts/train-digits.ts`. Until then the reader refuses them.
- Format history: until early 2026 the site URL served a coloured table (12 subgroup columns × 48 half-hours), as a progressive JPEG. The card reader reports `parse` ("expected 12 cards") on it.

### Failure modes

- Site unreachable (it reset every connection from the research machine for hours on 17.11.2026 after a burst of requests): Telegram alone gives today and tomorrow.
- Telegram unreachable or its markup changed: the site alone gives its day, i.e. nothing for today before the morning upload and never tomorrow.
- A poster in a new typography, or with a typo in a time: the channel that carries it fails with `parse`; the other one still answers.
- A change in words that can't be applied: the groups it names are `unknown` for that day until the next poster, the day has a newer `updatedAt` (until 0.4.3: the poster's times stayed).
- Telegram unreachable after such a change: the site's poster alone gives the day, with the hours the change made wrong; nothing on the site says so.

---

## Address lookup

`src/providers/chernihiv-addresses.ts` (`chernihivAddresses`), on the PDF reader in `src/pdf/text.ts`. Measured 2026-11-17.

- **Source**: `https://chernihivoblenergo.com.ua/files/other/Grafik_obmezhen.pdf`: one text PDF exported from Excel, 6 655 236 bytes, 186 pages, `Last-Modified: Wed, 07 Jan 2026 14:39:57 GMT`. Needs the Sectigo intermediate (`src/certs.ts`), like the poster.
- **How old it is**: the heading reads "Графік погодинного відключення … з 25.12.2025" and the button that linked it on `/blackouts` is **commented out** in the page HTML; the file is still served. Its groups matched the 17.11.2026 outage windows of 383 of 400 sampled Chernihiv houses (96%, `research/freshness/address/chernihiv/crosscheck-summary.txt`), so they are the groups in use, but rows for houses moved since are to be expected. `chernihivAddresses(…).addressSource(ctx)` returns `{ url, asOf: '2025-12-25', modified }` (not a `Provider` method).
- **Table**: `Черга/Підчерга | Дільниця | Населений пункт | Адреси`, one row per street and feeder: `3/2 | Чернігівські МЕМ | ЧЕРНІГІВ | Магістратська: 19`. 14 306 rows, 1 105 settlement names, 24 districts, 12 groups, 311 836 houses.
- **Reading a page**: the column positions come from the header row of page 1. Group, district and settlement are one text run per row; an address cell is one run per printed line, and the lines of one cell share the clip rectangle Excel gives the cell. The three counts must agree, every group must sit beside its address cell and every address must read `Street: …`, on every page; otherwise the whole file is a `parse` error.
- **Houses**: explicit lists only, no ranges. 99.2% of the 313 009 tokens are `12` or `12А`; the rest are fractions written with a backslash (`87\1`, `30Б/\15`, `68Б-\1` → shown as `87/1`…), `30Б к.30`, `1Б-Ж`. Three tokens don't start with a number (`В`, `Б`, `\22`) and are dropped. Matching ignores case, Latin look-alikes, spaces, dots and the dash before a letter; `87/1` is not `871`.
- **Street types are not in the file**: `Миру` is both вулиця Миру and проспект Миру. A number listed under one bare name in several groups comes back as `group` + `otherGroups` (663 houses, e.g. Чернігів, Миру, 213 → 1.1 and 4.1). A house that is in no row is `not-found`, never a neighbour's group.
- **Same-named villages**: a settlement is keyed by district + name and carries the district as `City.district` (136 names repeat, e.g. Городище in Менська, Коропська and Бахмацька дільниця); `findGroup` asks for `district` when the name alone is ambiguous. Stray filings are merged into the town they belong to: the city network and the network around it (ЧЕРНІГІВ: 764 rows under Чернігівські МЕМ, 20 under Чернігівський РЕМ), the pseudo-district `АТ ЧЕРНІГІВОБЛЕНЕРГО` (21 settlements), and 47 cases of one or two rows naming at most three houses beside ten times as many rows (БАХМАЧ: 216 rows and one under Борзнянська дільниця).
- **Cost**: parsing the whole file takes about 0.4 s (0.42 s on an M-series laptop), done a few pages at a time (longest event-loop stall 63 ms); the index keeps 11 MB of heap (the house lists stay as text and are split per lookup), peak heap during the parse about 50 MB.
- **Caching**: downloaded on the first lookup, shared by concurrent calls (one caller cancelling doesn't fail the others), kept 12 h, then revalidated with `If-Modified-Since` (a 304 keeps the index). If the server doesn't answer on a refresh the previous index is served and the server is asked again after 15 min; a failed first download is the answer for 1 min.
- **Rate limit**: after about 110 requests in 3 minutes on 16.11.2026 the host stopped completing TLS handshakes from the research machine and still refused it 5 hours later. One download per 12 h is far below that; a health check must not walk the site's street API.
- **Failure modes**: `network`/`http` when the file can't be fetched and there is no earlier index; `parse` when the file is no longer this table (header, column pairing, encryption, unreadable characters); `not-found` for an unknown settlement, street or house, with the closest names.
- **Not used**: `POST /api/list_acc` (today's windows per street, no group), the `interruptions.energy.cn.ua` autocomplete (its third field is the meters' EIC codes), `ГАВ-ЧОЕ.pdf` (same layout, emergency queues; not read yet).
- **Fixtures**: `test/fixtures/chernihiv/address/Grafik_obmezhen.9-pages.pdf` (pages 1, 5, 17, 28, 46, 99, 103, 116, 185 of the real file, embedded fonts and document author removed), `rows.trimmed.json` (rows of a few settlements as parsed from the whole file).
