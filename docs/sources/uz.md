# Укрзалізниця (`uz-*`) — АТ «Укрзалізниця», uz.gov.ua

Updated 2026-11-17 (all 24 pages fetched once at 00:29 Kyiv; header statistics from that pass).

АТ «Укрзалізниця» is a distribution operator: homes near stations and along the lines are on the
railway's grid and follow its schedule, not the oblenergo's. One page per oblast and Kyiv:

`https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen/<page>/`

26 regions over 24 pages (Vinnytsia and Sumy carry two railway branches each, a region per
branch); the page ids are in `UZ_PAGES` (`src/providers/uz.ts`). Plain fetch works, no cookies.
It is the only channel: the railway has no Telegram channel for these schedules.

## One download

A page holds both the schedule and the address lists (80–190 KB). The provider downloads it once:
`getSchedules` and the address lookup share the download (a call in flight is joined), and the
lookup reuses the page a schedule read brought for 6 hours before asking again.

## Schedule and its date

Section "…приєднані до мереж АТ «Укрзалізниця»" up to "Перелік адрес": zero or more tables, each
under a line with its date ("17 листопада"). Two layouts (time spans as columns, or groups as
columns), see the comment in `uz.ts`.

- The day is the date written above the table, nothing else. A date heads the tables under it
  until the next one (both branches' tables of one day).
- A table dated before today is never today: today is listed `unknown` (`assessFreshness` →
  `stale`/`behind`), the old day stays in the result under its own date.
- A table with no date at all → `parse`. Chosen over "assume today": the page keeps a table for
  days, and an undated one may be any day's.
- A page that shows only tomorrow's table: today is `unknown`, except that the table this
  process read for today earlier is kept for the rest of the day (nothing took it back).
- No table (most pages most days; Donetsk, Kherson always) → the twelve groups `unknown`.

`updatedAt` is **null**. Measured: the server sends no `Last-Modified` and no `ETag` (headers of
7 pages saved 17.11: `Server`, `Date`, `Content-Type`, `Set-Cookie`, security headers only), and
the page has no "оновлено" stamp. Freshness therefore rests on the date above the table.

## Address lists ("Перелік адрес, що знеструмлюються по чергах та підчергах ГПВ")

A table of three columns (settlement, street, houses) cut into groups by one-cell header rows.
A row whose only text names a group is a header however it is laid out (every page seen spans
the table with it, most in yellow; a plain first cell beside empty ones counts as well).
Read by `parseUzAddresses` (`src/providers/uz-addresses.ts`). What the pages really contain:

- group headers in every spelling seen: "І черга/ ІI підчерга", "1 черга 1 півчерга",
  "I черга I підчерга", Roman numerals mixing Cyrillic "І" and Latin "I"; two-level headers
  (a row "1 черга", then rows "2 підчерга") on Dnipro and Zaporizhzhia;
- `rowspan` on 16 pages (a settlement or a street spanning rows), carried down;
- an empty leading column (Rivne); a list cut in two tables (Lviv);
- one-cell rows that continue the house list above (",149,153,…", Khmelnytskyi);
- an empty settlement cell continues the settlement above, inside one group only, and not after
  a row that names a stop or a km post instead of a street: such rows are dropped (`unplaced`:
  18 rows over all pages) rather than attached to a guess;
- the tables under the list are other operators' ("ГПВ АТ Чернігівобленерго", addresses of
  another oblast) or the page footer, and are left out;
- two branches on one page (Vinnytsia, Sumy): each region gets the table under its branch heading.

Survey of all pages (17.11.2026): **3,997 address rows on 22 pages**, 1,296 settlements, 3,626
streets. Kherson has no section, Donetsk's lists only dashes: both have
`capabilities.addressSearch: false`. 215 houses are listed under more than one group.

House cells, as parsed by `parseUzHouses` (counts over all pages):

| Form                            | Example                                       | Count          | Read as                                                                                                 |
| ------------------------------- | --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| single numbers                  | `1, 2А, 13/1, 5-а`                            | 13,613         | exact house                                                                                             |
| letters continuing a number     | `1а,б,в`                                      | (in the above) | 1а, 1б, 1в                                                                                              |
| dot typed for a comma           | `2.3`, `9. 10. 28`                            | (in the above) | each number                                                                                             |
| run, ends of different parity   | `1-14`, `23 – 44`                             | 31             | every number in it                                                                                      |
| run with a parity word          | `9-85 (непарні)`, `1 – 33неп.`                | 2              | that side                                                                                               |
| run, both ends odd or both even | `1-31`, `6-12`                                | 31             | numbers of that parity; the other parity is **undecidable** → `not-found` quoting the run               |
| no number                       | `б/н`, `без номера`, empty                    | 698 rows       | house `б/н`                                                                                             |
| whole street                    | `всі`                                         | 3 rows         | any house                                                                                               |
| not a house number              | `123 км`, `ФОП …`, `територія станції`, `5 1` | 138            | listed as written for a picker; a number inside one ("5 1": 5 and 1, or 5/1?) is `not-found` quoting it |

A lettered house inside a run ("36а" in "34-40") is in the run. "1/5" is never "15".

An address under several groups returns all: Київ, площа Привокзальна, 1 → `1.1` with
`otherGroups: ['4.2']`. A bare "Привокзальна" and "площа Привокзальна" are one street when the
settlement has the name under one type only.

`searchCities` → `searchStreets` (needs the city) → `searchHouses` → `groupOf`, all from the
directory built from the page. A page that loses its section answers `unsupported` ("the page
lists no addresses for this region").

## Failure modes

- page unreachable → the call fails (`network`/`http`), one channel only;
- schedule section missing, unknown table layout, two tables for one date, undated table → `parse`;
- address section gone → lookups `unsupported`; the schedule is unaffected.

## Fixtures

`test/fixtures/uz/`: `kyiv.2026-11-17` (multi-group addresses, tables under the list),
`lviv.2026-11-17` (rowspans, list in two tables), `rivne.2026-11-17` (empty leading column,
unplaced rows), `khmelnytskyi.2026-11-17` (stray one-cell rows), `chernivtsi.2026-11-17`,
`kherson.2026-11-17` (no section); `dnipro.2026-11-08` (two-level headers) and
`vinnytsia.2026-11-08` (two branches) are whole pages. More fragments are in
`research/freshness/address/uz/`.
