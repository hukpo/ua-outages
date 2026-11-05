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
