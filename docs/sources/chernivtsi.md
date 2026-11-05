# Chernivtsi — АТ «Чернівціобленерго» (oblenergo.cv.ua)

Researched 2026-11-05. Status: **ACTIVE schedule** for 05.11 and 06.11.2026 (captured).

## Official pages

- Schedule: https://oblenergo.cv.ua/shutdowns/ (today) and https://oblenergo.cv.ua/shutdowns/?next (tomorrow; link present only when published).
- Address → group: https://oblenergo.cv.ua/shutdowns-search/ and https://oblenergo.cv.ua/shutdowns-search/<diln>/ (diln 1–12).
- Mobile app "eSvitlo CV" (com.intercode.esvitlodev) — probably has its own API; not investigated (UNVERIFIED).

## Plain fetch

Works (curl and Node fetch, Cloudflare in front, no challenge). Server-rendered HTML, no JSON. ~22 KB per schedule page. No rate limit observed.

## Schedule format (HTML)

```
curl --compressed https://oblenergo.cv.ua/shutdowns/
```

- `#gsv_t`: `<b>05.11.2026</b><a href="/shutdowns/?next">06.11.2026</a>` — bold = displayed date; link = other available date.
- `#gsv_a`: `Графік актуальний станом на <b>23:30</b>` — updated-at **time only** (date = page's date context; assume Kyiv, and if the time is later than now it belongs to the previous day — UNVERIFIED).
- `#gsv_actual`: "Сторінку відкрито DD.MM.YYYY о HH:MM" (server render time).
- `#gsv > ul > p`: schedule date `DD.MM.YYYY`; `li#grpN` = "Група N", **N = 1..12** (not 1.1…6.2!).
- `#gsv > div > div#infN[data-id=N]`: exactly **48 half-hour cells** starting 00:00, each an element whose tag+text encodes state:
  - `<u>з</u>` = заживлені (on)
  - `<o>в</o>` = відключені → `kind: "off"`
  - `<s>мз</s>` = можливо заживлені (possibly restored — always appears as the half-hour after an off block) → `kind: "maybe"` (or treat as off-tail; decide in SDK, document it)
    Parse with `/<(u|o|s)>([^<]*)<\/\1>/g`, cell i → `start = 00:00 + 30·i min`.
- All-clear day = all 576 cells `з` (per OlegVapnik/svitlo notes 21.10.2026).
- Date in `#gsv > ul > p` is the date of the displayed schedule; on `?next` it is tomorrow.

## Group naming / mapping

Chernivtsi uses **groups 1–12**. Mapping to the national `1.1…6.2` scheme is not published on these pages (UNVERIFIED; do not assume `1→1.1, 2→1.2…`). The SDK should expose native ids `"1".."12"` with a region-specific label.

## Address → group (full static directory, HTML)

- `GET /shutdowns-search/` — `<select name="diln">` with 12 дільниці: 1 ЧЕРНІВЦІ, 2 Вижницька, 3 Герцаївська, 4 Глибоцька, 5 Заставнівська, 6 Кіцманська, 7 Кельменецька, 8 Новоселицька, 9 Путильська, 10 Сокирянська, 11 Сторожинецька, 12 Хотинська.
- `GET /shutdowns-search/<diln>/` — whole directory for that дільниця rendered into HTML (~21 k rows, ~75–80 KB gzip); search is purely client-side.
  - diln 1 (city): `#city_tbl > div` rows `<p>street</p><b>буд. N</b><u>group</u>`
  - other: `#obl_tbl > div` rows `<s>м. ВИЖНИЦЯ</s><p>вул. 1 ТРАВНЯ</p><b>буд. 10</b><u>1</u>`
  - First row `.h_line` is the header. Garbage rows exist (GUIDs as street/house) — filter. Mixed case and prefixes ("вул.", "бульвар", "пров.") — normalise.
  - SDK flow: дільниця (or infer from city) → fetch table once (cache) → match street/house → group.
- `#pa_form` hidden form on /shutdowns/ (`v_type, v_diln, v_city, v_street, v_house, v_date …`) posts to `/shutdowns/planovi_avarijni_result.php` — planned/emergency works, not ГПВ.

## Files

- `shutdowns.today-2026-11-05.fragment.html` — **live, populated** (12 groups × 48 cells; includes `в`, `з`, `мз`).
- `shutdowns.next-2026-11-06.fragment.html` — live, populated tomorrow.
- `shutdowns-search.diln-1-Chernivtsi.trimmed.html`, `shutdowns-search.diln-2-Vyzhnytska.trimmed.html` — directory tables, first 80 rows + `diln` select.

## References

- OlegVapnik/svitlo `tools/osr_direct_sync.py` + tests (no license) — parser of `#gsv`.
