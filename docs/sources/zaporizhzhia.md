# Zaporizhzhia — АТ «Запоріжжяобленерго» (ZOE)

Verified 2026-11-05 ~23:30 Kyiv. GPV active (schedules for 03–06.11 on the page, several intra-day updates for 05.11).

## What the SDK reads (since 2026-11-17)

Measured 17.11.2026, see `research/freshness/CHANNELS-A.md`.

| Source id                              | Channel                                                                             | Role                         |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `site`                                 | `https://www.zoe.com.ua/outage/`, page 1 (~20 articles ≈ 2 days)                    | primary: the complete record |
| `telegram:@Zaporizhzhyaoblenergo_news` | `https://t.me/s/Zaporizhzhyaoblenergo_news`, posts since yesterday noon (≤ 3 pages) | fallback                     |

- **Which is first.** The site: 80 versions in 9 days, of which Telegram repeated 32, a median 3 min later (twice an older version 98 and 118 min late).
- **`updatedAt`** is the "(оновлено HH:MM)" of the current article. The stamp has no date: it is that time on the day the article is about or on the evening before, whichever is the latest not after the article above it on the page (`PostAnalysis.statedAt`, placed by `stampOf`). A day's first article has no stamp.
- **Telegram is used only** (a) when the site can't be read, (b) for a date the site has nothing equal to, where the newer of the two wins, and (c) for the time of a day's first article, when its post has the same hours. A Telegram day equal to any other version of the site is dropped, so a late repeat never replaces a newer version.
- Each update lists the whole day, so the newest version replaces the day (no layering here). A group left out of a post has no outages.
- **Formats**: lines `1.1: 10:00 – 15:00, 23:30 – 24:00` (site and Telegram) and blocks `⚡ Черга 1.1` / `з 10:00 до 15:00` (Telegram), read by the client's text processor (since 0.5.0; up to 0.4.8 by `parseGroupPost`): the trailing "Також з 00:00 до 24:00 … ГОП" sentence is industry's schedule, not 6.2's. ГАВ/СГАВ on/off posts and pictures are not schedules.
- **Failure modes**: site down → Telegram answers with today and later (possibly an older version than the site's); Telegram down → the site alone, a first article then has no time; both down → the site's error.

## URLs

- Schedule page (WordPress archive): https://www.zoe.com.ua/outage/ (paginated `/outage/page/2/` … `/page/27/`)
- Monthly archives linked from the page, e.g. `/стабілізаційні-відключення-грудень-2025/`
- Server `nginx`, no WAF challenge. Plain `curl` and Node 24 `fetch` (no headers) → 200, ~125–135 KB.
- WP REST: `/wp-json/` exists but returns no routes/namespaces (disabled) — not usable.

## Source type

HTML; schedule is **plain text inside `<article>` posts**, newest first. Fixture: `outage-page-2026-11-05.html` (articles only; header/footer/scripts trimmed).

```html
<article id="post-392871">
  <h2>6 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ ДІЯТИМУТЬ ГПВ</h2>
  <div class="content">
    <p>
      … Години відсутності електропостачання по чергам (підчергам) (з урахуванням 30 хвилин на перемикання):
    </p>
    <p>
      1.1: 12:00 &#8211; 17:00, 21:00 &#8211; 24:00<br />
      1.2: 00:00 &#8211; 02:00, 06:00 &#8211; 11:00, 15:00 &#8211; 20:00<br />
      …
    </p>
  </div>
</article>
```

Update posts: `ОНОВЛЕНО ГПВ НА 5 ЛИСТОПАДА ПО ЗАПОРІЗЬКІЙ ОБЛАСТІ (оновлено 21:25)`.

```sh
curl -s https://www.zoe.com.ua/outage/
```

## Parsing → `{start,end,kind}` (Europe/Kyiv)

1. Iterate `<article>`s in document order (newest first). Skip empty ones (`<h2></h2>` with empty content exists — post-392801) and non-GPV posts (e.g. `ДО УВАГИ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ 27 ЖОВТНЯ` — ГОП for business).
2. Date: `(\d{1,2})\s+(січня|…|грудня)` from `<h2>` (fallback: body). Months are UPPERCASE in titles and Capitalised in body (`5 Листопада`) → case-insensitive. **No year** — infer from fetch date (Dec/Jan rollover).
3. For a given date, the **first** (newest) article wins; later ones in the list are superseded versions.
4. Lines: split `<br>`/`<p>`, decode entities (`&#8211;` en dash), regex `^([1-6]\.[12])\s*:\s*(.+)$`, then intervals `(\d{1,2})[:.](\d{2})\s*[–-]\s*(\d{1,2})[:.](\d{2})`. `24:00` = end of day.
5. All intervals are kind `off`. Text says times _include_ 30 min switching ("з урахуванням 30 хвилин на перемикання"); ZOE doesn't mark `maybe`. Queues not listed → no outage.
6. "No outages for population" posts: keywords like `НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ`, `не застосовуватимуться`, `скасовано` (from milkmann parser; not seen today — UNVERIFIED wording).
7. Freshness: `(оновлено HH:MM)` in title; first post of a day has none (use article id order). No machine timestamp in the archive HTML; `article id="post-N"` is monotonic.

Group naming: `1.1`–`6.2` (черга.підчерга), 12 groups.

## Address search

Verified 2026-11-16. The homepage's Apps Script lookup is gone (404), but two pages link one public Google Sheet per group:

- `https://www.zoe.com.ua/перелік-адрес-для-кожної-з-черг-з-підч/`: the city of Zaporizhzhia, households. Links are titled `м. Запоріжжя, Черга 1, підчерга 2`; 11 sheets (2.1 has none). Each sheet has a title row, then `"Вулиця","Будинок"` and one row per street, with the houses joined by `|`.
- `https://www.zoe.com.ua/перелік-адрес-для-кожної-з-черг-з-підче/`: the rest of the area. Links are titled `1 черга ІІ підчерга`; 12 sheets. Columns are громада, населений пункт, вулиця, будинки, категорія (consumer names, including people: don't store or show them), черга/підчерга "за графіком" and "фактична по режиму". The actual group may differ from the sheet's group. An empty group says `Відключення відсутні`.
- CSV: `https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv[&gid=<gid>]`, no auth.

Houses look like `1|10А|34-40|1–15|1-9 поспіль|1-9 непарні|17 п.1–2|1 (п.1-4)|145 (5 пов)|70/1|будинки без номерів - 5`. Almost every range has ends of the same parity, so it covers one side of the street. An empty cell is the whole street.

How the SDK reads it (`src/providers/zaporizhzhia-addresses.ts`):

- It loads both pages and every sheet once per 6 hours, about 4k rows in all.
- Ranges cover one side unless marked `поспіль` or their ends differ in parity.
- Entrances, floors and notes are dropped, and a building listed on several sheets gets every group it is on (`otherGroups`).
- A number that isn't listed but falls inside a range ("48а" in "46-54") gets the range's group.
- When a settlement has one or two rows under another community and ten times as many under its own, those rows are merged into the main one. "м. Вільнянськ" has 433 rows under its own community and one stray row in each of two others.
- Old street names in brackets ("вул. Автоклубна (Виборзька)") stay in the name, and only fuzzy search reaches them.

## Failure modes

- Community scrapers fetch through a Ukrainian proxy (SenichkinArtur/zoe-bot) or fall back to the aggregator, and set `CERT_NONE` (milkmann). Suggests geo-blocking of non-UA/cloud IPs and/or TLS chain issues in the past — **UNVERIFIED** (worked from here with full TLS verification; cf-ray of other hosts showed VIE egress).
- Freeform text: watch for `—`/`–`/`-`, `.` instead of `:`, NBSP, queues grouped like `1.1, 1.2: …` (milkmann regex supports lists).
- Page holds ~20 posts; older dates go to `/page/N/`.

## Reference repos

- https://github.com/milkmann/gpv-zoe-zaporizhzhia (`scripts/parser.py`) — parses this HTML; output JSON in yaroslav2901 schema. **No license.**
- https://github.com/SenichkinArtur/zoe-bot — proxies the same page. No license.
- https://github.com/GrolGPA/ha-energyua-poweroff `providers/zoe.py`. No license.
- Aggregator cross-check snapshot: `aggregator-OE_OUTAGE_DATA-Zaporizhzhiaoblenergo-2026-11-05.json` (https://github.com/yaroslav2901/OE_OUTAGE_DATA, no license) — derived data, not official.
