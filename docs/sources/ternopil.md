# Ternopil — ПрАТ «Тернопільобленерго» (TOE)

Researched 2026-11-05. Status: **no active ГПВ** (last schedule in API: 17.10.2026).

## Official pages

- SPA «Чому немає світла?»: https://poweron.toe.com.ua/ (React, `/static/js/main.<hash>.js`, axios `baseURL: "https://api-poweron.toe.com.ua/api"`). Same vendor/codebase family as Lviv (API Platform/Hydra, `pw_*` resources).
- Main site https://www.toe.com.ua/ → **403** for curl and Node fetch (WAF). Not needed.

## Plain fetch

`api-poweron.toe.com.ua` works with plain fetch, no auth/cookies. Observed: one `a_gpv_g` call returned empty for a range that returned data seconds later — treat empty results as "maybe transient", retry once (UNVERIFIED cause). Third party (OlegVapnik/svitlo) reports occasional TLS timeouts on bulk crawling.

## Schedule — `GET /a_gpv_g` (address-keyed!)

The schedule is **only retrievable per address**. The server resolves the address from the `X-debug-key` header and returns the group(s) of that building; the `group[]` and `time` query params are ignored (verified: wrong `group[]` → still returns the building's real group; fake key → empty).

```
KEY=$(printf '1032/10035/1' | base64)       # "<cityId>/<streetId>/<buildingName>" UTF-8 → base64
curl -G 'https://api-poweron.toe.com.ua/api/a_gpv_g' \
  --data-urlencode 'after=2026-11-04T12:00:00+00:00' \
  --data-urlencode 'before=2026-11-06T00:00:00+00:00' \
  --data-urlencode 'group[]=3.2' --data-urlencode 'time=1032100351' \
  -H "X-debug-key: $KEY"
```

- SPA sends: `after = (today-1) "YYYY-MM-DDT12:00:00+00:00"`, `before = (today+1) 00:00 "+00:00"` (literal +00:00 on local date), `group[] = building groups`, `time = key without slashes`. Wider ranges work (got 46 days back to 26.01.2026 with `after=2025-01-01`) — **free historical data**.
- Response: Hydra `ActualGpvGraph` collection. `hydra:member` is `null` (not `[]`) when the address is valid but nothing matches; `[]` when no key. Handle both.
- Item: `{id, dateGraph:"2026-10-17T00:00:00Z", dateCreate:"2026-10-17T18:52:36Z", dataJson:{"3.2":{"times":{"00:00":"0", "00:30":"0", … "23:30":"0"}}}}`
  - `dateGraph` — schedule date (take the `YYYY-MM-DD` part as a Kyiv-local date).
  - `dateCreate` — updated-at. SPA formats it with `dayjs.utc(...)` and shows 18:52, i.e. **the "Z" is fake — the value is Kyiv local time**. Do not convert from UTC (UNVERIFIED, but consistent with Lviv's 18:56 publication that day).
  - `times` — 48 half-hour slots keyed `HH:MM` (start of slot). Values: `"0"` = power on, `"1"` = off, `"10"` = "possible off" (rendered grey `#B3B3B3`) → `kind: "maybe"`. Missing slot → SPA defaults to "0".
  - Merge consecutive equal slots into `{start,end,kind}`; slot `23:30` ends at next-day 00:00.
  - Building with two supplies has two keys in `dataJson` (SPA text: "Ваш будинок має два джерела електропостачання і входить до двох черг ГПВ"). Group keys may contain `#` suffix (SPA does `e.split("#")[0]`) — strip it.
  - SPA picks up to 2 members: earlier `dateGraph` = today, later = tomorrow.
- To provide a per-group (not per-address) API, the SDK must hold one representative address per group (pick from `building-names`). Fragile but workable.

## Address → group (no personal data needed)

Base `https://api-poweron.toe.com.ua/api`:

1. `GET /pw_otgs?pagination=false` → 64 hromadas (`id`, `code`, `name`; Тернопільська = 41).
2. `GET /pw_cities?pagination=false&otg.id=41` → `{id, name, otg}` (Тернопіль = 1032; note an entry with empty `name`).
3. `GET /pw_streets?pagination=false&city.id=1032` → Hydra `{id, name:"вул. Руська"}` (299; names **include** type prefix, unlike Lviv).
4. `GET /pw-accounts/building-names?cityId=1032&streetId=10035` → `{filters, buildingNames:[{id, buildingName, chergGpv, chergGav, chergAchr, chergGvsp, chergSgav, disconnectionTask}]}` — one row per building (71 here), already includes `chergGpv` (`"3.2"` or `"Не входить"`).
5. Optional: `GET /pw-accounts/building-groups?cityId=&streetId=&buildingNames=1` → `{"buildingGroups":[{"chergGpv":"3.2"}]}` (array → multiple groups possible).
6. Freshness of address DB: `GET /options?option_key=successful_last_synk` → `date`.
   Other: `/pw_accidents`, `/pw_accident_planeds`, `/pw_accounts_by_acc?account=` (personal account — avoid), `/check-light?number=` (UNVERIFIED). `/archive_gpv_graphs` holds only 3 junk test rows (incl. an LFI test) — do not use.

## Group naming

`1.1 … 6.2`; non-member = `"Не входить"`.

## Files

- `a_gpv_g.address-1032-10035-1.current-empty.json` — real, current (`hydra:member: null`).
- `a_gpv_g.address-1032-10035-1.HISTORICAL-populated.json` — real historical response (wide date range), trimmed to 3 items: 17.10.2026 (with `"1"` and `"10"`), 01.07.2026 (all `"0"`), 10.04.2026.
- `pw_*.json`, `pw-accounts.*.json`, `options-*.json` — address chain (trimmed where noted by `_trimmed`).

## References

- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license) — notes the endpoint but misreads `time`/`X-debug-key` as group code; our verification above supersedes it.
