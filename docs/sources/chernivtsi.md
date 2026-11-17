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
- `#gsv_a`: `Графік актуальний станом на <b>23:30</b>` — NOT a change time: a half-hour mark that moves by itself (23:30 on 05.11, 0:00 and 0:30 on 17.11 while the schedule dated from 22:59 the evening before). The provider ignores it; see "Channels and freshness".
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

## Channels and freshness (measured 2026-11-17)

Two channels of the operator, merged per day with `mergeSources`:

| id                   | what                                                                                           | change time                                  |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `site` (first)       | `/shutdowns/` (today) and `/shutdowns/?next` (tomorrow, fetched when today's page links to it) | none of its own: it gets the channel's clock |
| `telegram:@oe_cv_ua` | `https://t.me/s/oe_cv_ua`, the last 36 h (at most 2 pages)                                     | post time                                    |

- **The change clock.** The operator posts every version of a day there (0–11 reposts a day; tomorrow 20:00–23:00 the evening before). The time of the newest post about a date is when that date last changed, to the second: 16.11 22:59:32 for 17.11 (https://t.me/oe_cv_ua/4054). That is the `publishedAt` of the site's day and so the region's `updatedAt`. No post about a day the site shows ⇒ `updatedAt: null`.
- A post is about the date in its first line when that date is the post's own Kyiv day or the next one (the channel misdated a post once; such a post is skipped):
  - `⚡ Орієнтовний графік заживлення на 17.11.2026` + two pictures (the format since 15.11.2026 17:00): clock only, the times are in the pictures;
  - `⚡️ Орієнтовний графік заживлення для груп споживачів • 15.11.2026` + group blocks (until 15.11.2026 16:06): clock and a text copy of the day;
  - `✨ На 13.11.2026` / `Електропостачання без обмежень для всіх груп споживачів!`: clock and a `no-outages` day for all twelve groups.
- **Text format** (fixture `chernivtsi/telegram-oe_cv_ua-4013-4024.trimmed.html`): per group the windows WITH power, the inverse of outages:

  ```
  💡 Група 1
  00:00 - 17:00
  19:30 - 23:00

  💡 Група 3
  00:00 - 19:00
  з 21:30

  💡 Група 4
  Електропостачання без обмежень
  ```

  `з 21:30` runs to the end of the day; everything outside the windows is `off`. A post with a line the reader doesn't know, windows out of order or a group twice gives no text day at all. Only the newest post about a date counts, so a picture post after a text post leaves that date without text.

- **Text vs page.** The page marks the half hour before the power is back as "мз" (`maybe`); in the text that half hour is inside the gap (page 17:00–19:00 off + 19:00–19:30 maybe = text gap 17:00–19:30). When the page's off+maybe cells equal the text's gaps in every group, the two say the same and the channel is not marked `disagrees`. This equivalence is derived from the two formats; no page and text post of the same day were ever saved together (UNVERIFIED on live data).
- **Merge rule**: the site's day and the text day of a date carry the same clock, so the site (first) keeps every day it has, as long as the page shows what the newest post says. The channel supplies a day the site doesn't have: tomorrow before `?next` shows it, or everything when the site is down. Days before today are dropped.
- **A page behind the channel** (since 0.4.4). The clock is the time of a post, so it belongs to the page only if the page shows that post. When the newest post about a date states the day in words (group blocks, or "Електропостачання без обмежень для всіх груп") and the page's cells say something else, the site's day gets no time (`publishedAt: null`), the post wins the date, and the site is marked `disagrees`. Until 0.4.3 the page took the post's time whatever it showed and, being first, won the tie: an all-clear posted at 10:00 lost to the morning's cells. A picture post can't be compared with the page (the times are in the pictures): there the page keeps the post's time as before, so a page behind a picture post is not noticed. The site alone (channel down) has no time either way.
- **Failure modes**: channel unreadable ⇒ the site's days with `updatedAt: null` and `sources[1].ok: false`; site down ⇒ text days if the channel has any (none since 15.11.2026), otherwise the groups stay `unknown`; both ⇒ the site's error is thrown. Telegram shows when a post was made, not when it was edited: an edited post keeps its first time.
- **Day**: the page's own date line (`#gsv > ul > p`), never the clock. After midnight on 17.11 `?next` returned the same 17.11 page; two pages with one date are read as one day. When `?next` first holds tomorrow is UNVERIFIED.
- **Stale rule**: page date ≠ today ⇒ `behind`.
- HTTP: `cf-cache-status: DYNAMIC`, no `cache-control`: not cached. From GitHub Actions the site answered with bot protection on 16.11 23:45.
