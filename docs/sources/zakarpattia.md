# Zakarpattia — ПрАТ «Закарпаттяобленерго»

Researched 2026-11-05. Status: **no active ГПВ** (image options empty; NEK command empty).

## Official pages

- https://zakarpat.energy/customers/break-in-electricity-supply/schedule/ — static page: 12 PDFs "Черга N, підчерга N-M" listing settlements per sub-queue (`/wp-content/uploads/2026/09/gpv1-1.pdf` … `gpv6-2.pdf`, ~300 KB each) + link to "updated_information".
- https://zakarpat.energy/customers/break-in-electricity-supply/updated_information/ → iframe **https://outage.zakarpat.energy/schedule_queues** (React SPA «Чому немає світла?», same vendor "inneti" as Lviv/Ternopil/Volyn; `/static/js/main.<hash>.js`).
- https://outage.zakarpat.energy/nek_command — text of Ukrenergo command.

## Plain fetch

Works for `api-outage-zakarpat-energy.inneti.net` and `zakarpat.energy` (Cloudflare on zakarpat.energy, no challenge seen). No rate limits observed.

## Schedule source — **IMAGE ONLY**

Base `https://api-outage-zakarpat-energy.inneti.net/api` (Hydra). The SPA reads three option keys:

```
GET /options?option_key=pw_gpv_image_today      → member[0].value = "/media/....png" (relative to https://api-outage-zakarpat-energy.inneti.net) or ""
GET /options?option_key=pw_gpv_image_tomorrow
GET /options?option_key=pw_gpv_nek_comand       → member[0].data = HTML (sanitized and injected by SPA)
```

Current: `value: ""` everywhere; `pw_gpv_image_today.date = 2026-06-30T20:08:40+00:00` (last change), `name/data = "1"` (meaning UNVERIFIED).

- No JSON/text intervals exist anywhere official (checked SPA bundle: only these keys). Parsing requires OCR of the PNG → out of scope for "plain fetch" SDK. The SDK can still expose `{imageUrl, updatedAt, nekCommandHtml}` and report `kind: "image-only"`.
- No historical populated sample found (Wayback has nothing for the API host). Populated `value` format is UNVERIFIED (assumed `/media/<hash>.png` like Lviv/Volyn).
- `/pw_gpv_image_today` etc. as paths → 404; they are only option keys.
- The yaroslav2901/OE_OUTAGE_DATA aggregator publishes Zakarpattia JSON — presumably OCR/Telegram; not official.

## Address → group (works)

1. `GET /pw_otgs?pagination=false` → 65 (Ужгородська = 1)
2. `GET /pw_cities?pagination=false&otg.id=1` → Ужгород = 769 (+ an empty-name entry 1058 — filter out)
3. `GET /pw_streets?pagination=false&city.id=769` → 610 streets, names without type ("Корзо")
4. `GET /pw_address_queues?page=1&city.id=769&street.id=9373&buildingNames=` →
   `hydra:member[] {otg, city, street, buildingNames: "2, 4, 4/, 4/прим.104, 5, 9", chergGpv:"4.1", chergGav, chergAchr, chergGvsp, chergSgav, hash}`
   - One row per (street, group) with **comma-separated house list** (can start with ", " = empty house = whole street/unknown; values like `17(2поверх,приміщення №2)`, `б/н`).
   - Same house can appear in several rows → **several groups** (Корзо 20: 4.2 and 6.2).
   - `buildingNames=5` is a server-side **substring** filter (returns rows containing "15", "5" …) → always re-filter client-side by exact token after splitting on `,` and trimming.
   - Paginated 30/page (`hydra:view.hydra:next`); `pagination=false` also accepted per third-party notes. City-only query (`city.id=769`) → 828 rows / 28 pages → bulk export of a city is cheap.
5. `GET /options?option_key=successful_last_synk` → DB sync time.

## Group naming

`1.1 … 6.2` (`chergGpv`); PDFs use `1-1` style filenames.

## Files

- `options-pw_gpv_image_today.json`, `options-pw_gpv_image_tomorrow.json`, `options-pw_gpv_nek_comand.json` — real, current (empty).
- `pw_address_queues.city-769.street-9373.json` (3 rows), `...buildingNames-5.json` (substring filter demo) — real.
- `pw_otgs.trimmed.json`, `pw_cities.otg-1.json`, `pw_streets.city-769.trimmed.json`, `options-successful_last_synk.json`.

## References

- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license).

## Emergency schedules (ГАВ)

`pw_address_queues` rows also carry `chergGav` / `chergSgav` / `chergAchr`, returned in `emergency`. The operator doesn't announce ГАВ; live status falls back to @Ukrenergo. See [emergency.md](emergency.md).

## What the SDK reads (updated 2026-11-17)

The schedule is a picture: a table of 12 rows (1-1 … 6-2) × 48 half-hours, the half-hours
without power filled with the queue's colour, white otherwise; title "Прогнозовані години
включення/відключення електроенергії на 17.10.2026р.". No legend: that colour means "off"
follows from the pictures (17.10.2026 first version: one two-hour block per sub-queue of queues
1–3). Read by the client's image processor (`src/providers/picture-posts.ts`); up to 0.4.8 by
colour in `src/image/queue-table.ts`.

| Source                             | What                                                                                                                                                                                                           | Date of a picture           | `publishedAt` |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------- |
| `telegram:@zakarpatenergyofficial` | post with one photo (800×210 JPEG in the public preview) and the caption "… графік погодинних включень/відключень електроенергії [ГПВ] на DD.MM.YYYY"; a new post per change (17.10.2026: 10:00, 10:51, 14:19) | the caption                 | the post time |
| `api`                              | `options?option_key=pw_gpv_image_today` / `_tomorrow` → path of the picture on the operator's server                                                                                                           | none of its own (see below) | null          |

Merge (`mergeSources`): per date the channel's reading wins (it has a time, the API has none);
the API's is a cross-check and gets `disagrees: true` when its cells differ.

- Telegram: the window is from the start of yesterday (tomorrow's picture comes the evening
  before: 09.02.2026's was posted 08.02 at 21:08). For each caption date from today on, the
  newest post is read. A post for a past date is never today. A photo-only post, or any post
  without that caption, is not a schedule: the post time alone never dates a picture. When the
  newest post's picture can't be read the source fails with `parse`; an older version is not
  shown in its place.
- API: nothing says which day the picture is for or when it was put there (`date` of the option
  stood at 2026-06-30 through the pictures of 17.10.2026; the title's date is ~6 px high in the
  preview and no sample of the API's own file exists). So the picture is read as today's
  (tomorrow's) only when the channel has a schedule post for that date; otherwise the source
  fails with `unsupported` and the picture's URL. The same when the channel's newest post for
  that date couldn't be read: the API's picture may then be the version before it, and an older
  version is never shown as the day. **Unverified:** that the API serves the same
  template (no ГПВ since 17.10.2026). If it doesn't, the source shows `parse` and the channel
  still answers.
- Which channel is first is unmeasured (no ГПВ day since the research began).
- Nothing published on either → twelve groups, today `unknown`.

### Reader guards

Rows = the twelve coloured cells of the sub-queue column (their own rulings); columns = the 49
rulings of the header's half-hour cells, which must be evenly spaced and unique. Each cell is
judged on its inner half: ≥ 85 % of its pixels white, or ≥ 85 % its row's colour; anything else
(grey, another queue's colour, a half-filled cell) → error. Two rows of a queue must share a
colour and the six queues must differ. Any failure is `parse`.

Measured on the eight hand-labelled samples (`test/fixtures/zakarpattia/posters/labels.json`,
07.02–17.10.2026, from sparse to almost full): 4,608 of 4,608 cells, all eight exact.

### Failure modes

| Situation                        | Result                                            |
| -------------------------------- | ------------------------------------------------- |
| channel down, API empty          | groups `unknown`, `sources[telegram].ok = false`  |
| channel down, API has a picture  | the call fails (no way to date the picture)       |
| API down, channel ok             | the channel's schedule, `sources[api].ok = false` |
| both down                        | the call fails with the channel's error           |
| newest post's picture unreadable | `sources[telegram]`: `parse`; today `unknown`     |
