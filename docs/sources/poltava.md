# Poltava — АТ «Полтаваобленерго» (POE)

Verified 2026-11-05 ~23:36 Kyiv. GPV active (today + tomorrow published).

## URLs

- GPV info page: https://www.poe.pl.ua/disconnection/hrafik-pohodynnoho-vidkliuchennia-elektroenerhii/ (static text + PDF of groups)
- Outage page: https://www.poe.pl.ua/disconnection/power-outages/ (dynamic GPV block loaded via AJAX)
- Address search: homepage widget and https://www.poe.pl.ua/disconnection/poshuk-vidkliuchennia-za-osobovym-rakhunkom/
- All logic in `/wp-content/themes/llorix-one-lite/js/poe-custom.js`. Server nginx, WordPress 4.8, no WAF. Plain curl / Node 24 `fetch` → 200.

## Schedule source: server-rendered HTML fragment

```sh
curl -s https://www.poe.pl.ua/customs/dynamicgpv-info.php
```

`GET`, no params, Content-Type `text/html` (~270–360 KB; JS calls it with `dataType: json` but it's HTML). Fixture: `dynamicgpv-info-2026-11-05.trimmed.html` (inline `<style>` and duplicate mobile `gpv-vtable` removed).

Structure — one block per published day, each starting with `<div class="gpvinfodetail">`:

- Header text: `… в Полтавській області <b>5 листопада 2026 року</b><br><b>з 00:00 по 06:00</b> застосовується ГПВ в обсязі <b>2.5</b> черги…` (has full date incl. year).
- `<table class="gpv-table">`: one `<tr>` per group, `<td class="gpv-q" title="Черга 1, підчерга 1">1.1</td>` then 48 `<td class="gpv-c gpv-sN …" title="1.1: 00:00–00:30 — «Вимкнено», …">`.
  - `gpv-s1` = «Увімкнено» (on), `gpv-s2` = «Вимкнено» → kind `off`, `gpv-s3` = «Час, необхідний для перемикань. Електроенергії може не бути» → kind `maybe`. `gpv-past` = cosmetic.
- `<ul class="gpv-periods"><li><b>1.1</b> — <span>00:00–00:30</span>, <span>05:00–09:00</span>…` = merged **s2-only** intervals (s3 slots are excluded). Easiest parse for `off`; use the table for `maybe`.
- `gpv-now-info` ("Зараз 23:36 …") is render-time status — ignore.
- If there's no GPV the endpoint returns a text notice without `turnoff-scheduleui-table`/`gpv-table` (JS checks `indexOf('turnoff-scheduleui-table')`) — exact empty wording UNVERIFIED.

Convert: for each block → date from header; for each row → 48 slots (index i = i*30 min) → merge runs of s2 → off, s3 → maybe. Group naming `1.1`–`6.2`.

Other endpoints seen in JS (all proxy to an internal Java `poeREST`):

- `POST /customs/newgpv-info.php` (`seldate={"date_in":"DD.MM.YYYY"}`) → today returns `{"status":400,"detail":"Failed to read request","instance":"/poeREST/abon/site/turnoff/schedule/get/v2"}` for every payload tried (fixture `newgpv-info-400-error.json`). Broken / UNVERIFIED payload.
- `/customs/gpv-info.php`, `oldgpv-info.php`, `unloading-info.php` — 406/400, legacy.

## Address search (works, no captcha)

All `POST` form-urlencoded, field `disconn` = JSON string, base `https://www.poe.pl.ua/customs/`:

1. Filial list is static `<select id="input-filial-main">` on homepage (e.g. `123` = Полтавська об'єднана філія, `115` Кременчуцька, `119` Миргородська, `117` Лубенська …; 28 options).
2. `search-disconnection-cabinet.php` `{"operation_type":"city","filial_id":"123","city_id":"","street_id":""}` → `[{instance_id, instance_name:"місто Полтава"}]` (`search-city-filial-123.json`; Полтава = 11389)
3. same with `"operation_type":"street","city_id":11389` → streets (1044) (`search-street-city-11389.json`)
4. `"operation_type":"building","city_id":11389,"street_id":1004324` → `[{instance_id, instance_name:"10"}]` (`search-building-street-1004324.json`); `instance_id` here is just a row number — use `instance_name`.
5. `disconnectinforesult-cabinet.php` `{"cityid":"11389","streerid":"1004324","house":"10"}` (note the misspelt key **`streerid`**) → `[{fn_accident_message, message_type, accident_str, accident_id, accident_date, gav_message:"… залучено до АЧР, ГПВ (черга 1-1).", gp_qnum_1:"1", gp_qnum_2:"1", planned_message}]` → group = `${gp_qnum_1}.${gp_qnum_2}` (`result-…-house-10.json`).
   - Failure mode: houses with several connections return empty `gp_qnum_*` and a message "зареєстровано декілька підключень… скористайтеся пошуком за особовим рахунком" (`result-…-house-1-multiple-connections.json`). Common for apartment blocks (3 of 4 tried).
   - `fn_accident_message` also carries current outage status (HTML).

- Response Content-Type is `text/html` even when JSON → parse body manually.
- Personal-account lookup (`readings-abon-disconnection.php`, `personalaccount`) exists — personal data, not explored.

## Freshness / limits

No explicit updated-at in the fragment (only "Зараз HH:MM" render time). No rate limiting observed; JS timeout 9 s on search → backend can be slow.

## Reference repos

- None official/community found for the direct endpoints (OlegVapnik/svitlo lists Poltava as `url-only`; no license).
- Aggregator cross-check: `aggregator-OE_OUTAGE_DATA-Poltavaoblenergo-2026-11-05.json` (yaroslav2901/OE_OUTAGE_DATA, no license; derived).
