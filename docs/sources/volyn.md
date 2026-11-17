# Volyn — ПрАТ «Волиньобленерго» (energy.volyn.ua)

Researched 2026-11-05. Status: **no active ГПВ** (image options empty since 19.10.2026; last archive image for 20.10.2026).

## Official pages

- https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/ — embeds iframe `https://voe-poweron.inneti.net/schedule_queues` (image) + a PHP search form "Пошук вашої адреси у графіках погодинного відключення" ("актуалізується кожну годину", `Оновлено: 05-11-2026 23:00`).
- https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/ — address → queue (PHP form).
- https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen-arc/ → iframe `https://voe-poweron.inneti.net/schedule_arhiv` (images).
- (Note: voe.com.ua is **Vinnytsia**, not Volyn.)

## Plain fetch

Works for all (energy.volyn.ua, api-voe-poweron.inneti.net). The PHP forms enable the submit button after 4.2 s via JS, but the server does not check it — direct POST without cookies works.

## Schedule source 1 — inneti API: **IMAGE ONLY**

Base `https://api-voe-poweron.inneti.net/api`:

- `GET /options?option_key=pw_gpv_image_today` / `pw_gpv_image_tomorrow` → **plain array** (not Hydra!) `[{id, option_key, value:"", date, name}]`; when active, `value` = `/media/...png` (UNVERIFIED, empty now).
- `GET /options?option_key=pw_gpv_nek_comand` → Hydra, empty.
- `GET /archive_gpv_graphs?page=1` (optional `dateGraph[after]`, `dateGraph[before]`) → Hydra, 616 items, 30/page, newest first:
  `{id, dateCreate:"2026-10-19T22:26:04+00:00", dateGraph:"2026-10-20T00:00:00+00:00", imageUrl:{contentUrl:"/media/2026/10/6ad66ecc04352_GPV.png", uploadTimestamp}, imageMobileUrl:{…}}`
  Image = `https://api-voe-poweron.inneti.net` + `contentUrl` (PNG ~125 KB, 200 OK). Timezone of `dateCreate` vs `uploadTimestamp` differs by 3 h (one is fake-UTC Kyiv time) — UNVERIFIED which.
- No address endpoints in this SPA (no `pw_accounts`/`pw_address_queues`).

## Schedule source 2 — PHP search (possible text source, UNVERIFIED)

```
curl --compressed -X POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/pagephp.php \
  --data-urlencode formGpvDate=2026-11-05 --data-urlencode formCity=Луцьк \
  --data-urlencode 'formStreet=Лесі Українки' --data-urlencode searchForm=searchFromForm
```

- `formGpvDate` options come from the GET form (`<select name="formGpvDate">`, today and tomorrow, `YYYY-MM-DD`). Street optional.
- With no active schedule the response contains only `Оновлено: DD-MM-YYYY HH:MM` and no result block; past dates also return nothing. **The populated result format (likely an HTML table of addresses with hours) could not be observed** — must be captured during the next outage period. This is the only potential non-image schedule source for Volyn.

## Address → group — PHP form (works)

```
curl --compressed -X POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/ \
  --data-urlencode formCity=Луцьк --data-urlencode 'formStreet=Лесі Українки'
```

- Both fields required, names without "м./с./вул." prefixes, case-insensitive; matching is substring-ish (UNVERIFIED).
- Response: HTML `<table class='table table-sm …'>` with header `Район | Нас. пункт | Вулиця | Будинок | Черга у ГПВ | Черга у ГАВ`, one row per record; `Будинок` = comma list (messy: `"10, 10,12, 14"`, `"17-19"`, `"35 А пр.3"`); `Черга у ГПВ` = `1.1`…`6.2` or `Не залучено`. Same house appears in many rows with different queues → return the distinct set for exact token match.
- No city/street directory endpoint → free-text only.

## Group naming

`1.1 … 6.2`; not included = `Не залучено`.

## Files

- `options-pw_gpv_image_today.json`, `options-pw_gpv_image_tomorrow.json` (plain array), `options-pw_gpv_nek_comand.json`, `options-successful_last_synk.json` — real, current.
- `archive_gpv_graphs.page-1.trimmed.json` — real archive (image-only) entries, 3 of 616.
- `cherga.POST-Lutsk-Lesi-Ukrainky.table.html` — real address → queue result (40 rows).
- `hrafik-vidkliuchen.form.fragment.html` — form with date options; `pagephp.POST-…no-schedule.fragment.html` — empty search result.

## References

- OlegVapnik/svitlo docs (no license) — lists inneti API only.

## Emergency schedules (ГАВ)

The `cherga` table has a 6th column "Черга у ГАВ", returned in `emergency`. No operator channel announces ГАВ; live status falls back to @Ukrenergo. See [emergency.md](emergency.md).

## What the SDK reads (updated 2026-11-17)

One channel, `site`: the archive API. There is no second official channel to merge with
(`@volynoblenergo` on Telegram has no post since 11.09.2023; Facebook and Viber aren't fetchable),
so `sources` has one entry.

- `GET /api/archive_gpv_graphs?page=1` lists the pictures per `dateGraph`, newest first. For
  every date from today on (up to two days ahead) the newest picture is read by colour. Tomorrow's
  picture is in the archive the evening before (for 18.10 at 17.10 22:12, for 19.10 at 18.10
  22:32, for 20.10 at 19.10 22:26), so today and tomorrow come in one result from then on.
- A picture for a past date is never today: with nothing dated today or later the twelve groups
  are `unknown` (`updatedAt: null`, `assessFreshness` → `unpublished`).
- `updatedAt` / `publishedAt` = `imageUrl.uploadTimestamp` of the picture read, which is true UTC
  (17.10 18:47:23 Kyiv for the last of that day's seven versions). `dateCreate` is the same moment
  as Kyiv wall time labelled `+00:00` (the picture says "станом на 22:26" for
  `22:26:04+00:00`); it is used only for an entry without the upload time.
- A date whose newest picture holds no readable table → `parse` (the source is `ok: false`; it
  is the only one, so the call fails).

### Autocomplete

The `cherga` form answers nothing without a street fragment, so there is no settlement
directory and no `searchCities`: the settlement is free text. The provider declares
`remoteSearch: { streets: true }`, like a provider whose server does the searching:

```ts
const streets = await client.searchStreets('volyn', 'Вин', { city: { id: '', name: 'Луцьк' } })
// Винокурна; Винниченка
const houses = await client.searchHouses('volyn', streets[1])
const match = await client.groupOf('volyn', houses[0], streets[1])
```

- `searchStreets` posts `formCity=Луцьк&formStreet=Вин` (bare names, no "м."/"вул.") and keeps
  the records of the settlement named exactly so: the form matches substrings, and "Луцьк" also
  brings "Прилуцьке". A fragment under three letters returns `[]` without a request ("а" in
  Lutsk matches 2,987 records). Two settlements of one name in different districts are told
  apart in the street name ("… (Ковельський район)"); the street id is `district|city|street`.
- `findGroup` (`matchRecords`) keeps such namesakes apart too: when the records of the settlement
  and street asked for come from several districts it needs `district` ("Луцький", "Луцький
  район") and otherwise answers `not-found` naming the districts, never the other village's
  group. House numbers are compared without their spelling ("67-А" = "67а") but with what
  separates two numbers: "2/3" is not "23".
- `searchHouses` and `groupOf` use the records of that answer (no more requests); a street id
  kept from an earlier session is asked for again.
- `findGroup` with a full address still works through `lookupAddress` (one request).
