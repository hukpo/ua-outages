# Zhytomyroblenergo (Житомирська) — research notes

Researched 2026-11-05 (~23:30 Europe/Kyiv). Schedule was **active** (ГПВ on 05.11 and 06.11).

## TL;DR

- **Official source**: `https://www.ztoe.com.ua/unhooking-search.php`. It is server-rendered PHP HTML in **windows-1251** with a 12-row × 48-column table of 30-minute slots, one table per date (today and tomorrow once published).
- **Plain Node fetch works**: GET and POST return 200 with no cookies, captcha or WAF (nginx, no Cloudflare). A UA header isn't required, but send one anyway.
- **Address search works with plain fetch** using the same URL: form POSTs go РЕМ → settlement → street → rows of (houses, черга, підчерга).
- Group naming: `1.1`..`6.2` (черга N, підчерга M). Full set of 12.

## Endpoints

### 1. Schedule (GET)

```
curl -s 'https://www.ztoe.com.ua/unhooking-search.php' | iconv -f cp1251 -t utf-8
```

- `Content-Type: text/html; charset=cp1251`. Decode with `new TextDecoder('windows-1251')`, not `res.text()`.
- `https://www.ztoe.com.ua/unhooking.php` → 302 to the PowerOn SPA (see below). Don't use it.
- `?pidcherga_id=N` (N=1..12, 1=1.1, 2=1.2, … 12=6.2) gives the same page plus the full address list for that subgroup (~1.3 MB). That could be used to build an offline address→group index.

**Structure** (see `schedule-2026-11-05.cp1251.html`):

- Freshness: `<h4>Дата оновлення інформації - 23:30 05.11.2026</h4>`, in `HH:MM DD.MM.YYYY` Kyiv local time.
- Notice block above the form: `УВАГА! ВАЖЛИВА ІНФОРМАЦІЯ! На 06.11.2026р. по команді НЕК "Укренерго" буде застосовано: з 00:00 до 06:00 - 2,5 черги …`. This is free text about how many queues are applied. Optional to parse.
- Each date has its own `<table … width:1300pt>`. The date sits in the header cell `<b style="font-size:12pt;">DD.MM.YYYY</b>` (colspan=48). The second header row lists the 48 slot labels `00:00-00:30` … `23:30-24:00`.
- Group rows: the first column `Черга` uses `rowspan="2"` on the x.1 row only, so x.2 rows have one fewer leading cell. The subgroup cell is `<a href="/unhooking-search.php?pidcherga_id=N"><b …>1.1</b></a>`, followed by a spacer `<td style="width:3pt">`, followed by 48 slot `<td>`s.
- Slot state is only the **`background:` colour** in the td style:
  - `#ff3333` = off ("відключається при доведенні НЕК обмежень")
  - `#ffffff` = power on (guaranteed unless emergency)
  - No "maybe"/grey state is used. The legend has only red and white. A legend swatch is `#ff0000`, so don't confuse it with slots.
- **Malformed HTML**: the 2.2 row header lacks `</a>` (`<b …>2.2</b></td>`). Use a tolerant parser (parse5/cheerio) or a regex on `pidcherga_id=(\d+)…>(\d\.\d)<`.
- The table extends the hour boundaries with `border-right:3pt` (cosmetic).
- Tomorrow's table appears in the evening once published. Before that, only one date table is present (UNVERIFIED exact time; the aggregator showed tomorrow by ~20:00).

**Conversion**: for each date table → for each subgroup row → walk the 48 cells. Merge consecutive `#ff3333` runs into `{start: slotIndex*30min, end: (lastIdx+1)*30min, kind:'off'}` in Europe/Kyiv on that date. `24:00` means next day 00:00. Verified 05.11 group 1.1 = off 00:00-02:00, 06:00-10:00, 12:00-16:00, 18:00-22:00, which matches yaroslav2901's JSON.

### 2. Address → group (POST form, same URL)

Content-Type `application/x-www-form-urlencoded`. Responses are windows-1251 full pages (~0.5 MB). Each step re-renders the `<form id="mainform">` with the next `<select>` populated.

1. `GET` → `<select name="rem_id">` options (20 РЕМ, e.g. 7=Житомирський).
2. `POST rem_id=7` → `<select name="naspunkt_id">` options (e.g. 16657=місто Житомир). Sample: `search-step1-rem7-settlements.html`.
3. `POST rem_id=7&naspunkt_id=16657` → `<select name="vulica_id">` options (967 for Zhytomyr city, e.g. 173934=вул. Київська). Sample: `search-step2-zhytomyr-streets.html`.
4. `POST rem_id=7&naspunkt_id=16657&vulica_id=173934[&all=1]` → `<b>За Вашим запитом знайдено записів: 77</b>` plus a table with columns `РЕМ | Населений пункт | Назва вулиці | Будинки | Черга | Підчерга | Примітка`. Without `all=1` only the first 10 rows show and a "показати ще 67 записів" button appears. **Always send `all=1`.** Sample: `search-step3-kyivska-all-houses.html`.

```
curl -s -X POST -d 'rem_id=7&naspunkt_id=16657&vulica_id=173934&all=1' https://www.ztoe.com.ua/unhooking-search.php | iconv -f cp1251 -t utf-8
```

Result-row gotchas:

- `Будинки` is a comma-separated house list, e.g. `112, 116, 1, 118, 122, 114`. The same house can appear in several rows: different `Примітка` such as `побутові споживачі` vs `непобутові (юридичні) споживачі`, or different groups. Filter by `побутові` for households and normalise house numbers (`104/1`, letters).
- `Черга`/`Підчерга` are separate integers → group = `${черга}.${підчерга}`. Either can also be the text `В цей час не вимикається, за винятком випадків аварійних відключень`, meaning not in ГПВ (critical infrastructure). Model this as "no group".
- IDs are numeric and stable-looking. Option text is mixed-case (`с. ВЕРЕСИ`). Prefixes vary: `вул.`, `пров.`, `1 пров.`, `проспект`, `шосе`.

### 3. PowerOn SPA / API (secondary — NOT a GPV source today)

`https://ztoe-poweron.inneti.net/` (React, linked from the site as "Чому немає світла?") uses the API-Platform/Hydra JSON API `https://api-ztoe-poweron.inneti.net/api` behind Cloudflare. Plain GET works (HEAD → 401).

- `pw_otgs?pagination=false` (РЕМ list), `pw_cities?pagination=false&otg.id=6` (≈760 KB), `pw_streets?pagination=false&city.id=333`, `pw_accidents…`, `pw_accident_planeds…` (emergency/planned works), `archive_gpv_graphs?dateGraph[after]=…`, `options?option_key=successful_last_synk|pw_gpv_image_today|pw_gpv_nek_comand`.
- `pw_address_queues?city.id=&street.id=&buildingNames=` returns **0 items for every query** (tested) → empty. `archive_gpv_graphs` is empty, and `pw_gpv_image_today.value` is "" (last set 2025-12-12). So the SPA's ГПВ features are dormant. Use it only for emergency/planned-work lists, if at all. Its IDs differ from the PHP form IDs (Житомирський РЕМ = 6 here, 7 in PHP).
- The bundle also references a test host `oe-zoe-test.bot.asd.company`. Irrelevant.

## Freshness / failure modes

- Freshness comes from the `Дата оновлення інформації` h4. The PowerOn `successful_last_synk` option is a separate sync timestamp (UTC), not for ГПВ.
- When no ГПВ is applied, it's UNVERIFIED whether the table renders all white or disappears. Handle both, plus a zero-table page.
- The page is large (~480 KB today, 1.3 MB with `pidcherga_id`). Poll ≤ every 5–10 min. No rate limit observed (about 15 requests). No robots/WAF on www.ztoe.com.ua.
- Encoding: forgetting cp1251 yields mojibake and the regexes on `Черга` etc. fail.

## Saved files

- `schedule-2026-11-05.cp1251.html` — the GET page, cp1251/CRLF kept. Slot cells were trimmed for size (described in the header comment). Two dates, 05.11 and 06.11, all 12 groups populated.
- `search-step1-rem7-settlements.html`, `search-step2-zhytomyr-streets.html`, `search-step3-kyivska-all-houses.html` — address flow (UTF-8 re-encoded, form/results section only).
- `poweron-api-*.json` — PowerOn API samples (otgs, trimmed streets, EMPTY address_queues, gpv image option).
- `aggregator-yaroslav2901-Zhytomyroblenergo.json` — yaroslav2901/OE_OUTAGE_DATA output for the same day, for cross-checking (no license on that repo).

## Reference repos (all hit unhooking-search.php)

- mrkaktuz/outages-data `src/sources/ztoe/` (license NOASSERTION/custom; JS parser + test).
- xzkutor/ztoe (Python, `ztoe/schedule.py`; no license, 2024).
- IgorZaharov/UABlackoutPreWarning, IgorZaharov/Android-ZTBlackoutPreWarning (apps; license not checked).
- nazarsarkhan/ZhytoMate (license not checked).
- Elvis129/prosvitlo-addresses-db README also notes that the PowerOn API has no addresses.
