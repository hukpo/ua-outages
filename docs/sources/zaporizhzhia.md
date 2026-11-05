# Zaporizhzhia — АТ «Запоріжжяобленерго» (ZOE)

Verified 2026-11-05 ~23:30 Kyiv. GPV active (schedules for 03–06.11 on the page, several intra-day updates for 05.11).

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

**Not available via plain fetch.** Homepage links "Дізнатися свою чергу за адресою" to a Google Apps Script web app
`https://script.google.com/macros/s/AKfycbzkN3KDDReQuxcjAHdkIpVoVwF2RKCSUnWlcwSPbipfMnxNWYuLF-BtZv2oHxk5FG_V/exec` → **HTTP 404 "Сторінку не знайдено"** today. Alternative: Telegram bot https://t.me/esozoebot (not an API). No address→queue dataset found.

## Failure modes

- Community scrapers fetch through a Ukrainian proxy (SenichkinArtur/zoe-bot) or fall back to the aggregator, and set `CERT_NONE` (milkmann). Suggests geo-blocking of non-UA/cloud IPs and/or TLS chain issues in the past — **UNVERIFIED** (worked from here with full TLS verification; cf-ray of other hosts showed VIE egress).
- Freeform text: watch for `—`/`–`/`-`, `.` instead of `:`, NBSP, queues grouped like `1.1, 1.2: …` (milkmann regex supports lists).
- Page holds ~20 posts; older dates go to `/page/N/`.

## Reference repos

- https://github.com/milkmann/gpv-zoe-zaporizhzhia (`scripts/parser.py`) — parses this HTML; output JSON in yaroslav2901 schema. **No license.**
- https://github.com/SenichkinArtur/zoe-bot — proxies the same page. No license.
- https://github.com/GrolGPA/ha-energyua-poweroff `providers/zoe.py`. No license.
- Aggregator cross-check snapshot: `aggregator-OE_OUTAGE_DATA-Zaporizhzhiaoblenergo-2026-11-05.json` (https://github.com/yaroslav2901/OE_OUTAGE_DATA, no license) — derived data, not official.
