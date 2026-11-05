# Rivne — ПрАТ «Рівнеобленерго» (ROE)

Researched 2026-11-05. Status: **no active ГПВ** — table shows one row `05.11.2026` with `Очікується` for every group ("Оновлено: 05.11.2026 23:30").

## Official page

https://www.roe.vsei.ua/disconnections (WordPress, Apache, `Cache-Control: no-cache`). The schedule is a **server-rendered HTML table** inside `<div id="fetched-data-container">` — no JSON endpoint found (`/wp-json/` root does not return JSON; only `/wp-json/custom/v1/status` → `{"status":"Працює"}` for the call-centre widget).

## Plain fetch

Works (curl/Node, no cookies). ~165 KB HTML, ~36 KB gzip. reCAPTCHA scripts are on the page but only for contact forms. No rate limit observed.

```
curl --compressed https://www.roe.vsei.ua/disconnections
```

## Table format

After `#fetched-data-container`:

- Row 1: title "Графік погодинних відключень (ГПВ)"; row 2: "Години відключення" ×12; row 3: "Черга № 1..6" (colspan 2); row 4: `Підчерга | 1.1 | 1.2 | … | 6.2` → **column order of groups; read it from this row**, don't hardcode.
- Rows 5+: one row per date. First `<td>` = `DD.MM.YYYY`; next 12 `<td>`s = cell per group, each containing one `<p>` per interval (`<p style="white-space:nowrap; margin:0;">05:00 - 09:00</p>`), or the single word `Очікується` (= schedule for that date not yet published / no outages announced → no intervals; not an error).
- Interval text `HH:MM - HH:MM`; end `23:59` means end of day → map to next-day 00:00. Only `off` intervals; no "maybe" notation observed.
- Typically today + tomorrow rows (2 rows seen in Wayback 10.02.2026 and 11.01.2026, tomorrow `Очікується` until published).
- Updated-at: text node after the table `Оновлено: DD.MM.YYYY HH:MM` (Kyiv).
- Parse cells with tag stripping + `/(\d\d:\d\d)\s*-\s*(\d\d:\d\d)/g`; Wayback samples show interval `<p>`s; older versions separated with `<br>` (handle both).
- Before ~12.2025 the page layout differed (no container) — UNVERIFIED, not captured.

## Address → group

**No API.** Official lookup = two PDFs linked on the same page (URLs change when re-uploaded — scrape the `href`s with text "Дізнатися чергу відключень у м. Рівне" / "...у Рівненській області"):

- https://www.roe.vsei.ua/wp-content/uploads/2026/10/GPV_cherga_misto_Rivne-1.pdf (2 pages; columns: № | free-text streets & house numbers | підчерга written as `1,1` with **comma**)
- https://www.roe.vsei.ua/wp-content/uploads/2026/10/GPV_cherga_Rivnenska_oblast-1.pdf (45 pages; громада | населені пункти | вулиці/будинки | `1.2`)
  Both are Excel-exported, extremely free-form ("частково", ranges "167-195 (непарні)", organisations). An SDK can only offer best-effort fuzzy search over pre-extracted text; ship a pre-built index instead of parsing PDFs at runtime. OlegVapnik/svitlo `tools/import-rivne-pdf.py` (no license) did this and found 316 conflicting addresses.
- Commented-out in the page HTML: Rivne ODA search (rv.gov.ua) and a Looker Studio report — likely retired (UNVERIFIED).
- Вараш has its own separate schedule (per third-party notes; UNVERIFIED).

## Group naming

`1.1 … 6.2` in the table; `1,1` in the city PDF — normalise `,`→`.`.

## Files

- `disconnections.current-2026-11-05.fragment.html` — live, trimmed to the schedule block (all `Очікується`).
- `disconnections.HISTORICAL-wayback-20260210.fragment.html` — **HISTORICAL** (Wayback 2026-02-10 20:08Z), 2 dates fully populated, `23:59` ends.
- `disconnections.HISTORICAL-wayback-20260111.fragment.html` — **HISTORICAL**, today populated + tomorrow `Очікується`.
- `GPV_cherga_*.page1.pdftotext-layout.txt` — `pdftotext -layout` of page 1 of each address PDF (PDFs themselves are 0.6–1 MB, not stored).
