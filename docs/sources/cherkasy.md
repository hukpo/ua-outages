# Cherkasyoblenergo (Черкаська область) — research notes

Researched 2026-11-05. GPV was active on 4, 5 and 6 Nov 2026, so the samples are live and populated.

## TL;DR

- **Schedule:** free-text HTML inside CMS news posts, delivered through a clean JSON CMS API (`www.cherkasyoblenergo.com/api/v1/...`). You parse `HH:MM - HH:MM` ranges per queue line. There is no structured per-group JSON.
- **Address → queue:** an official JSON-ish PHP API (`cabinet.cherkasyoblenergo.com/api_new/disconn.php`): department → city → street → house → account(s) → queue text "4 черга 1 підчерга".
- **Plain fetch:** the CMS API works as-is. The cabinet API is not behind a WAF, but its **TLS chain is incomplete**: Node fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The fix is to ship the Sectigo intermediate (included here). No captcha, no cookies.

## Official pages

- News listing: https://www.cherkasyoblenergo.com/news?lang=uk
- Example schedule post: https://www.cherkasyoblenergo.com/media/hrafik-pohodynnykh-vidklyuchen-hpv-na-5-lystopada?lang=uk
- Outage search (planned / emergency / "Графіки відключень" + queue lookup): https://www.cherkasyoblenergo.com/off
- Nuxt SPA. `runtimeConfig.public.apiBaseUrl = "/api"`. The `/off` page chunk is `/_nuxt/CEcoA7c4.js`, and the hashed name changes on redeploy.

## 1. Schedule source — CMS API (nginx, no WAF)

### List and find posts

```
GET https://www.cherkasyoblenergo.com/api/v1/posts/category/news?lang=uk&page=0&size=20
GET https://www.cherkasyoblenergo.com/api/v1/posts/search?q=ГПВ&lang=uk&page=0&size=10
GET https://www.cherkasyoblenergo.com/api/v1/posts/main?lang=uk            # homepage feed
```

The response is `{success, data:{content:[{id,title,slug,previewImage,category,tags,pinned,showOnMain,publishedAt,createdAt}], page,size,totalElements,totalPages,last}}`. `posts/main` returns `data` as a plain array.
`publishedAt` is a naive local timestamp (Europe/Kyiv), e.g. `2026-11-05T20:25:00`.

### Fetch one post

```
curl 'https://www.cherkasyoblenergo.com/api/v1/posts/hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada?lang=uk'
```

The response is `{success, data:{id,title,content(HTML),slug,previewImage,category,tags,attachments,pinned,showOnMain,viewsCount,publishedAt,createdAt,showAttachments}}`.

### Content format (see `api-post-*.json`)

```
<p>... 6 листопада з 00:00 до 24:00 у Черкаській області будуть застосовані графіки погодинних відключень (ГПВ).</p>
<p>Години відсутності електропостачання:</p>
<p>1.1 00:00 - 02:00, 07:00 - 10:00, 12:00 - 16:00, 18:00 - 22:00</p> ... <p>6.2 ...</p>
```

The HTML is messy. Hours are split across `<span>`s, and `&nbsp;` shows up mid-token, for example `00</span>:00 - 03:00`. Parse it like this:

1. Turn `</p>`, `<br>` and other block ends into `\n`.
2. Strip the tags and decode entities. Collapse whitespace, including `\xa0`.
3. Remove spaces around `:` (` 00 :00` → `00:00`).
4. Match each queue line with `^\s*(\d)\.(\d)\b(.*)$` and each window with `(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})`.
5. Treat `24:00` as the next day's 00:00. Every window has `kind: "off"`. This source has no "maybe" state.

**Date:** take it from the **title** ("ГПВ на 6 листопада") with a Ukrainian-month regex, and infer the year from `publishedAt`. Don't use the slug. Post 4873 has slug `onovleno-...-na-1-lystopada` but its title is "Оновлено графік ... на 3 листопада".

**Updates:** a second post titled "Оновлено графік / Оновлення графіка ... на N" replaces the earlier post for that date. Pick the latest `publishedAt` for each date.

**Non-schedule posts with similar titles:** "застосовані графіки аварійних відключень (ГАВ)" has no per-queue windows (sample `...hav-3.json`). "графіки обмеження потужності (ГОП)" is for industry only and should be ignored. Cancellations use wording like "не застосовуватимуться / скасовано" (UNVERIFIED: no sample today; the regex in mcfedr/cherkasy-outage-ha covers it).

**Freshness:** use `publishedAt` of the post, or `createdAt`.

**Groups:** `1.1`..`6.2` (12 groups).

## 2. Address → queue — cabinet API

Base URL: `https://cabinet.cherkasyoblenergo.com/api_new/disconn.php`. Every call is a GET with query params.

- Server: Apache, PHP/7.0.7.
- Headers: `Access-Control-Allow-Origin: *`, `Content-Type: application/x-javascript`. The body is JSON, so parse the text yourself.
- No auth, no cookies, and no special headers needed.

| op                | params                                                                                                    | returns                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `department_list` | –                                                                                                         | `[{ID,NAME}]` 26 branches ("Черкаські міські ЕМ", ...)                                                                                         |
| `city_list`       | `dept_id`                                                                                                 | `[{ID,NAME}]` e.g. `{ID:"1",NAME:"м. Черкаси"}`                                                                                                |
| `street_list`     | `city_id`, `search_name=` (empty means all)                                                               | `[{ID,NAME}]` 415 streets for Черкаси                                                                                                          |
| `house_list`      | `street_id`, `search_name=`                                                                               | `[{HOUSE}]`                                                                                                                                    |
| `ls_list_by_addr` | `street_id`, `house`                                                                                      | `[{LS,NAME,ADDRESS}]`. **LS is a personal account number.** We redacted it in the fixture, and the SDK should not log or persist it.           |
| `disconn_by_ls`   | `abon_ls`, `disconn_selector` (0 planned, 1 emergency, **2 schedules**), `n_date`,`k_date` (`dd.mm.yyyy`) | `{DATETIME:"23:33 05.11.2026", DISCONN_QUEUQ:[{QUEUE_INFO}], DISCONNECTIONS:[...]}`                                                            |
| `disconn_by_dept` | `dept_id`, `disconn_selector`, `n_date`,`k_date`                                                          | `{DATETIME, DISCONNECTIONS:[{DISCONN_TYPE,DATE_START,DATE_STOP,STATE_INT,STATE_CHAR,ADDRESS(html)}]}`. This is big: about 2 MB for selector 2. |

The key name `DISCONN_QUEUQ` is a typo in the API itself, and that's the real field name.

**Flow:** `department_list` → `city_list(dept_id)` → `street_list(city_id)` → `house_list(street_id)` → `ls_list_by_addr(street_id, house)` → pick any LS → `disconn_by_ls(abon_ls, disconn_selector=2, n_date=today, k_date=today)`.

`QUEUE_INFO` is a string:

- `"Графік погодинних відключень - 4 черга 1 підчерга"` → group `4.1`.
- `"Графік аварійних відключень - в чергу не включено"` → this is GAV membership, which you can ignore or expose.

Use regex `(\d+)\s*черг\w*\D{0,5}(\d+)\s*підчерг`.

Caveats:

- City IDs are global and not scoped to a department (dept 2 → `ID:5 м. Сміла`).
- Some streets come back as `*невизначена`.
- A house can have several LS rows (one per apartment). UNVERIFIED: all LS in one house are assumed to share a queue.
- `disconn_by_ls` with selector 2 returned `DISCONNECTIONS: []` even on a GPV day. Windows come only from the news posts.

**`disconn_by_dept` with selector 2** returns `DISCONN_TYPE:"ГПВ"` records with odd multi-week ranges (e.g. `08:52 02.11.2026 → 10:39 03.12.2026`, "Завершено"). These look like dispatcher switching records, not the schedule. Don't use them for the schedule.

### TLS gotcha (important)

`cabinet.cherkasyoblenergo.com` sends only its leaf cert and leaves out the intermediate _Sectigo Public Server Authentication CA DV R36_.

- `openssl s_client` reports `Verify return code: 21`.
- macOS curl works, but **Node `fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**, and `--use-system-ca` doesn't help.

What we verified:

- `NODE_EXTRA_CA_CERTS=sectigo-public-server-auth-ca-dv-r36.pem` makes fetch return 200.
- `https.get(url, {ca: [...tls.rootCertificates, pem]})` returns 200.
- In the SDK, use an undici `Agent({connect:{ca:[...tls.rootCertificates, PEM]}})` scoped to this host. Keep verification on.

The PEM is saved here. It is valid until 2036-03-21, and its AIA URL is http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt.

## Converting to `{start,end,kind}` per date

For each schedule post, take date D from the title. For each queue line, map each window to `{start: D HH:MM Europe/Kyiv, end: D HH:MM (24:00 → D+1 00:00), kind:"off"}`. Merge windows that touch.

## Rate limits / failure modes

- No rate-limit headers were seen and nothing returned 429 during research (about 40 requests). UNVERIFIED under load.
- `www` has HSTS. `cherkasyoblenergo.com` returns 301 to `www.`.
- The cabinet API returns its own error/empty shapes. `[]`, or `DISCONNECTIONS` as an object instead of an array, are possible, so normalise with `Object.values`, as the official frontend does (`J()` helper).
- Post HTML formatting is hand-edited and changes from day to day. Keep the parser tolerant.

## Saved files

- `api-posts-search-gpv.json`: search results with schedule posts plus GAV posts, showing the pagination shape.
- `api-post-hrafik-...-na-4|5|6-lystopada.json`: populated daily GPV posts.
- `api-post-onovleno-...-na-1-lystopada.json`: update post. The slug says "1", the title says "3 листопада".
- `api-post-po-cherkaskiy-...-hav-3.json`: GAV announcement with no windows (a negative case).
- `disconn-department_list.json`, `disconn-city_list-dept1.json`, `disconn-street_list-city1.json`, `disconn-house_list-street16896.json`
- `disconn-ls_list_by_addr-street16896-house100.REDACTED.json` (LS replaced)
- `disconn-disconn_by_ls-selector2-schedules.json`: queue info, `4 черга 1 підчерга`.
- `disconn-disconn_by_ls-selector0-planned-empty.json`
- `disconn-disconn_by_dept-dept1-selector{0,1,2}.TRIMMED.json`: the first 15 records, with the original count in `_TRIMMED_FROM`.
- `sectigo-public-server-auth-ca-dv-r36.pem`: the missing intermediate.

## Reference repos

- mcfedr/cherkasy-outage-ha (MIT, pushed 2026-10): Home Assistant integration that uses exactly these two APIs. It has a good parser (`parser.py`) and the bundled-intermediate trick.
- sigmanor/cherkasyoblenergo-api (BSD-2-Clause): Go service that parses `api/v1/posts/category/news`.
- InetIntel/power-outages-scraping, `src/scrapers/ukraine/cherkasy/` (license not checked, UNVERIFIED).
- yaroslav2901/OE_OUTAGE_DATA has `data/Cherkasyoblenergo.json` (aggregated, upstream not public).
