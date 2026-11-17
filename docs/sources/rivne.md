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
- Text node after the table `Оновлено: DD.MM.YYYY HH:MM` (Kyiv): NOT a change time, see "Freshness" below. The provider ignores it.
- Parse cells with tag stripping + `/(\d\d:\d\d)\s*-\s*(\d\d:\d\d)/g`; Wayback samples show interval `<p>`s; older versions separated with `<br>` (handle both).
- Before ~12.2025 the page layout differed (no container) — UNVERIFIED, not captured.

## Freshness (measured 2026-11-17)

- **One channel: the page.** There is no official Telegram channel (`@rivne_oblenergo` is a third-party relay, `@rivneoblenergo` has three posts from 2022); the Facebook page needs a login.
- **`updatedAt` is null.** "Оновлено: 17.11.2026 00:00" became "00:30" half an hour later over a row that had not changed, and the page's HTTP `Last-Modified` (`Mon, 16 Nov 2026 22:30:02 GMT` = 00:30:02 Kyiv) moves with it: a half-hourly job, not an operator's edit. Looked for a real change time in the page text, the response headers and `/wp-json/`: there is none.
- **Day**: the first cell of each row (`DD.MM.YYYY`), never the clock. At 00:28 and 00:44 on 17.11 the only row was still `16.11.2026` (all "Очікується") under "Оновлено: 17.11.2026 …": the result is that row dated 16.11, i.e. nothing published for today. When the row of the new day appears is UNVERIFIED.
- **Stale rule**: newest row with data < today ⇒ `behind`; only "Очікується" ⇒ `unpublished`. A page left over from another day (the February capture read in November) is `behind`, never today (`test/providers/rivne.test.ts`).
- HTTP: `Cache-Control: max-age=0, no-cache, no-store, must-revalidate`: not cached.

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

---

## Address lookup

`src/providers/rivne-addresses.ts` (`rivneAddresses`), on the PDF reader in `src/pdf/text.ts`. Measured 2026-11-17. This replaces the "ship a pre-built index" advice in "Address → group" above: the two PDFs are read at run time.

- **Source**: the two files linked from `https://www.roe.vsei.ua/disconnections`, found by their button text ("Дізнатися чергу відключень у м. Рівне" / "… у Рівненській області"; the file names change on re-upload). Text PDFs printed from Excel 2013: city 631 405 bytes, 2 pages, 82 rows, `Last-Modified` 21.10.2026; oblast 1 052 295 bytes, 45 pages, 663 rows, 20.10.2026. Reading both takes about 0.1 s.
- **Rows**: Excel clips every cell to its box, so the clip rectangles in the page content are the row grid. A row is a smallest box, a column starts at a box edge, the lines of a cell are joined as printed (Excel wraps in the middle of a word). All 745 rows come out with a group; 5 oblast cells hold more text than their box shows (cut off in the file) and are kept as candidates only for a street they don't name outright.
- **What a row says** (745 rows): 153 put whole settlements in a group ("повністю"), 397 list streets of one settlement or of settlements each marked in the text ("м.Березне (вул.…) с.Балашівка (вул.…)"), 183 name several settlements over one unmarked list and are kept only as candidates, 12 name no settlement (enterprises). 1 122 settlements, keyed by громада (`City.district`, e.g. Ганнівка of Корецька and of Деражненська громада); 615 of them are answered for any street, 325 have candidate rows only.
- **What a cell says**: 3 751 street mentions (organisations included: the list doesn't tell them apart), 266 of them partial ("частково", a note in brackets, words that aren't house numbers). 4 723 houses are named outright: 4 608 in one group, 115 in two (returned as `group` + `otherGroups`).
- **Answers, and nothing else**:
  - a house the list names → that group;
  - a house inside a range: `167-195 (непарні)` only odd numbers, `1-34` all of them, `42-64` only the even ones (the other side is a candidate), `2-66 (приватний сектор)` nobody; never a lettered house the range doesn't name;
  - a street, or a settlement, listed whole in exactly one group (1 587 of 2 770 whole-street mentions). "повністю" in the settlement cell counts as that even when the same row goes on to list the settlement's streets, so a village two rows call whole in two groups (Яцковичі: 1.2 and 4.2) is answered by neither;
  - the last two only when no row of another group has the street's main word in text that wasn't read as a street (an unassigned row, a cut cell, a list split wrongly).
- **Everything else is `not-found`** with the candidate groups and the operator's wording: `1, вул. Замкова, Рівне: Рівнеобленерго's list doesn't settle it. Could be 1.2 (the street is listed in part: "вул.24 серпня (частково) , …"); 2.1 (…)`. A street the lists don't mention at all: `not in Рівнеобленерго's lists`.
- **Whose numbers**: house numbers belong to the street they follow, and only while that is certain. A number glued to the next name is a boundary ("І.Богуна 1,2Івана Огієнка 26,…": a line break inside the cell; "23авул.Данила Галицького 10,…"), "(частково) вул.X" marks the street before it and starts X, and an item that begins like a number but is neither a house nor a range leaves the numbers after it unassigned. Streets listed after another settlement's name in the city list ("с. Тинне, вул. …") keep no houses: they are that village's, and for Rivne only candidates.
- **Names**: "Кн.Володимира" = "Князя Володимира", "С.Бандери" = "Степана Бандери" (every word but the last counts by its first letter); вулиця and провулок of one name are two streets; a street typed without its first name is matched by the usual fuzzy search and the answer's `address.street` shows which one was taken.
- `findGroup` goes through `lookupAddress` (so the refusal can explain itself); `searchCities` / `searchStreets` / `searchHouses` / `groupOf` serve autocomplete from the same index. `rivneAddresses(…).addressSource(ctx)` returns the two URLs with their `Last-Modified` (not a `Provider` method).
- **Caching**: page + two files on the first lookup, shared by concurrent calls, kept 6 h, then the page again and the files with `If-Modified-Since`. If the site doesn't answer on a refresh the previous lists are served and it is asked again after 15 min.
- **Failure modes**: `parse` when the buttons are gone from the page or a file is no longer the table (column count, header text, a group cell that isn't `N,M`/`N.M`, unreadable characters, encryption); `network`/`http` when nothing was read before.
- **Known limits**: answers are a reading of free text; the files are from October 2026; Вараш and enterprises listed without a settlement are not covered; 183 rows (25%) are never an answer, only a candidate.
- **Fixtures**: `test/fixtures/rivne/address/GPV_cherga_misto_Rivne-1.trimmed.pdf` (the whole city list), `GPV_cherga_Rivnenska_oblast-1.pages-1-16-19-20.pdf` (4 of 45 pages), both without the embedded fonts; `disconnections.address-buttons.2026-11-17.fragment.html`.
