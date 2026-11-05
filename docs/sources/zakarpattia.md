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
