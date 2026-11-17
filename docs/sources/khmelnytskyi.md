# Khmelnytskoblenergo (Хмельницька) — research notes

Researched 2026-11-05. **No GPV is active today.** The schedule page has no schedule image. The most recent official GPV in the archive is 17.10.2026.

## What the SDK reads (since 2026-11-17)

Measured 17.11.2026, see `research/freshness/CHANNELS-A.md` and `research/aggregators/FRESHNESS.md`. The schedule has been text since November ("Підчерга 1.1 – 10:00-15:00; 18:00-21:00."); the image notes below describe October.

| Source id                       | Channel                                                                                                                                                                                                                                         | Requests     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `site`                          | `/page/pogodinni-vidkljuchennja` (text blocks, newest on top, split by `<hr>`), and the archive page's PNGs for dates it has no text for                                                                                                        | 2 (+ images) |
| `news`                          | the list `/post/novini-kompaniji` → the per-day posts for today and later, picked by title (slugs vary: `prognoz-gpv-na-17-listopada`, `pogodinni-vidkljuchennja-na-15-listopada`, `prognoz-obmezhen-na-12-listopada`); same blocks as the page | 1 + ≤ 3      |
| `telegram:@khmelnytskoblenergo` | `https://t.me/s/khmelnytskoblenergo`, posts since yesterday noon                                                                                                                                                                                | ≤ 2          |

- **Which is first.** Telegram had 17.11 at 16.11 22:55 and the news post had it too, while the schedule page still showed only 16.11 at 05:30 on 17.11.
- **Merge** (`mergeSources`): per date the newest publication wins. Telegram: the post time. Page and news post: the operator's own stamp, "(оновлено о 23:00, 15.11.2026)" or "(оновлено з 15:00, 16.11.2026)"; a day's first announcement has none (null), so Telegram's copy of it wins the date.
- An update posted during its own day lists only the hours still ahead (an outage in progress is listed from its start; a group with nothing more is left out). The SDK therefore layers a day's posts oldest first (`layerPublications` in `src/providers/posts.ts`): a post published before the day is the whole day; a later one keeps the earlier outages before the minute it takes effect and replaces the rest. When it takes effect: "з 15:00" → 15:00; a stamp dated the day before → the whole day; on Telegram a bare "(16:00)" → that time when the post went out on the day, else the post time. A subgroup left out of an announcement has no outages (the operator lists only those that do).
- **Failure modes**: any one or two of the three down → the rest answer, failures listed in `sources`; all down → the page's error. A block that names subgroups without a date or a readable line is a `parse` error of that source.

## Sites

- Official site: https://hoe.com.ua/ (ASP.NET MVC, jQuery, no Cloudflare). A plain fetch works, with no cookies needed.
- Outages hub: https://hoe.com.ua/page/informatsija-vidkljuchennja
- GPV page: https://hoe.com.ua/page/pogodinni-vidkljuchennja. When GPV is active it holds a text paragraph plus a **PNG image** of the schedule. Community scrapers select `h2 + p + p img`. The page also links per-REM queue lists as PDF and XLSX (`/Content/Uploads/GPV6/{pdf,xls}/Черги_на_відключення_<REM>_09102026.*`).
- Archive: https://hoe.com.ua/page/arhiv-grafikiv-pogodinnih-vidkljuchen-2026 (also `-2025`, `-2024`, `-2023`). It's a `<ul>` of `<a href="/Content/Uploads/YYYY/MM/fileYYYYMMDDhhmmssfff.png">Графік погодинних відключень DD.MM.YYYY (оновлено, HH:MM)</a>`, newest first. A few entries are PDFs.
- Address → queue tool: https://hoe.com.ua/shutdown/queue. Current outages by address: https://hoe.com.ua/shutdown/new. All current outages: https://hoe.com.ua/shutdown/all.

## Schedule source: IMAGE ONLY (no machine-readable official source found)

- Official GPV is published only as a PNG table (1920×1021). The table has rows for subqueues 1.1–6.2 and 24 hourly columns.
  - Legend colours: blue `≈#8EA9DB` = "Електроенергія відсутня" (off), grey = "може бути відсутня" (maybe), white = power on.
  - Cells can be **half-filled** (30-minute granularity). The PNG title holds the date and update time, e.g. "Графік погодинних відключень на 17.10.2026 (ОНОВЛЕНО, 16:50)".
- No JSON or HTML-table endpoint was found. The JS bundle `/bundles/js?v=...` contains only the address and shutdown-list AJAX, plus an admin-side "generate schedule" form that isn't public.
- Practical options:
  - (a) Parse pixel colours from the PNG. The grid is fixed, so this is deterministic. DenayeD/desvitlo_bot (MIT) does colour analysis and OCR.
  - (b) Discover the newest image via the archive list or the GPV page, then pixel-parse it.
  - (c) Use the third-party yaroslav2901/OE_OUTAGE_DATA `data/Khmelnytskoblenerho.json` (unofficial; its scraper code isn't public).
- Freshness: the update time is in the archive link text "(оновлено, HH:MM)", in the PNG title, and in the `Last-Modified` header on the PNG (UTC; e.g. `Sat, 17 Oct 2026 13:44:37 GMT` for the 16:50 update).

Conversion for the image: for each subqueue row and each hour column, a fully blue cell gives `[h, h+1)` off. A left or right half-blue cell gives the corresponding 30-minute slot. Grey gives `kind:"maybe"`. Merge adjacent slots. The date comes from the title or link text (Europe/Kyiv).

## Address → group (verified, plain fetch; reCAPTCHA script is loaded but NOT enforced)

**Required header:** `X-Requested-With: XMLHttpRequest`. Without it the lookup endpoints return an HTML 404. `Referer` isn't needed, but send `https://hoe.com.ua/shutdown/queue`.

1. `GET https://hoe.com.ua/settlements/?term=<text>`. **The trailing slash is required**; `/settlements?term=` gives a 404. Returns `[{"id":26499,"text":"м. Хмельницький (Хмельницька громада)"}, ...]`.
2. `GET https://hoe.com.ua/streets/<settlementId>?term=<text>`. Returns `[{"id":280957,"text":"вул. Проскурівська"}, ...]`. An empty term returns every street.
3. `GET https://hoe.com.ua/houses/<streetId>`. Returns a JSON array of house strings: `["1","2","3А","4/3",...]`.
4. `POST https://hoe.com.ua/shutdown-queues` with form body `streetId=<id>&house=<houseString>`. Returns an **HTML fragment**:
   ```html
   <div class="alert alert-info">... ГПВ ... підчерги: <strong>1.1, 3.1, 4.1, 6.1, 6.2</strong></div>
   <div class="alert alert-info">... ГАВ ... черги: <strong>8, 8, 3</strong></div>
   ```
   Parse the first `<strong>` and split on ", ". A building can belong to several subqueues because it has several connections.

`POST https://hoe.com.ua/shutdown-events` (same body) returns the current or planned outages for the address as HTML. The saved sample is the "no outage" message.

```bash
curl -s -H 'X-Requested-With: XMLHttpRequest' 'https://hoe.com.ua/streets/26499?term=%D0%9F%D1%80%D0%BE%D1%81%D0%BA'
curl -s -H 'X-Requested-With: XMLHttpRequest' -X POST -d 'streetId=280957&house=2' https://hoe.com.ua/shutdown-queues
```

Bulk alternative: the per-REM XLSX files on the GPV page map addresses to queues. They weren't downloaded here. The current file set is dated 09.10.2026. UNVERIFIED columns.

## Files

- `address-1-settlements.json`, `address-2-streets.json`, `address-3-houses.json`: address lookup steps.
- `address-5-queues.html`: queue lookup result for вул. Проскурівська 1, Хмельницький (GPV 1.1, 3.1, 4.1, 6.1, 6.2).
- `address-4-events.html`: "no registered outage" response.
- `schedule-page-2026-11-05-no-active-gpv.html`: content block of the GPV page today, with no image, meaning no active GPV.
- `archive-2026-page-content.html`: archive list (31 links, newest 17.10.2026).
- `historical-2026-10-17-gpv-updated-1650.png`: official schedule image for 17.10.2026 (updated 16:50). **Re-quantised to 32 colours** to stay under 200 KB (the original is 290 KB RGBA). Colours shift slightly, so match with a tolerance. Original URL: https://hoe.com.ua/Content/Uploads/2026/10/file20261017164437203.png
- `thirdparty-oe-outage-data-Khmelnytskoblenerho.json`: the third-party JSON for the same day (17.10.2026 16:45, `fact.data[ts]["GPV1.1"]["1".."24"]`). Its values match the PNG (e.g. 1.1 is off 16–19). Use it as an expected-output oracle for the image parser. It is UNOFFICIAL, from yaroslav2901/OE_OUTAGE_DATA, which has no license file.

## Rate limits / failure modes

- No WAF and no rate-limit headers seen. Be polite (≤1 req/s for address lookups).
- Wrong URL shape or a missing XHR header gives the HTML 404 page with status 404.
- Missing params give an HTML "Помилка" page with status 200 (check the content type).
- When there's no GPV, the GPV page simply has no `<img>`. The archive keeps old days.
- Image layout may change between campaigns. Older (2022–2024) schedules used numbered queues 1–6 or 1–16 (DenayeD config has 16), so check the title and layout.

## Reference repos

- DenayeD/desvitlo_bot (MIT): scrapes the `pogodinni-vidkljuchennja` image and does colour analysis and OCR.
- pashokman/electricity_availability_notifier (no license): Playwright, selector `h2 + p + p img`.
- realtomchuk-source/svitlo-starkon (no license): uses the GPV page and the news page.
- dmmat/hoe-bot (no license, 2024).
- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license): lists HOE `shutdown/new` as `url-only`.

## Emergency schedules (ГАВ)

`/shutdown-queues` has a second alert "(ГАВ) … черги: <strong>3</strong>" (often empty), returned in `emergency`. Live ГАВ status: @khmelnytskoblenergo, apply posts only (TTL). See [emergency.md](emergency.md).
