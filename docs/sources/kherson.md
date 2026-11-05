# Kherson — АТ «Херсонобленерго» (KSOE)

Checked 2026-11-05 ~23:40 Kyiv. **No machine-readable GPV source found. Status: unresolved.**

## Domains

- `https://ksoe.com.ua/` works (Apache, PHP 5.4.16, Yii). `www.ksoe.com.ua` does not resolve / connect (curl 000).
- Plain curl / Node fetch → 200 for the homepage.

## What exists

| URL                                                              | Result today                                                                                                                    | Fixture                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/disconnection/schedule/` ("Графік відключень" in menu)         | **200 with `Content-Length: 0`**                                                                                                | `disconnectionschedule-*` |
| `/disconnection/search/` ("Пошук відключень")                    | 200, empty body                                                                                                                 | `disconnectionsearch-*`   |
| `/disconnection/planned/`                                        | 200, empty body                                                                                                                 | `disconnectionplanned-*`  |
| `/disconnection/` and `/disconnection/outages/` (→ `/messages/`) | 200, only site chrome, no data                                                                                                  | —                         |
| `/cabinet/login/`                                                | login form; per press (Obozrevatel, ~2024) schedules were "лише в особистому кабінеті" — needs a customer account, out of scope | —                         |

Wayback Machine (CDX for `ksoe.com.ua/disconnection/schedule/`): until 2023-09 the page was a planned-works table (РЕМ filter, "Роботи / Причина / Час") — never a GPV queue table. Since 2023-12 every snapshot has the same tiny/empty digest (`3I42H3S6…`) — page broken for ~3 years.
News list `/company/news/` has no GPV posts (latest items are generic/old).

No Kherson file in yaroslav2901/OE_OUTAGE_DATA; OlegVapnik/svitlo `docs/osr-direct-sources.md` marks Kherson `unresolved` ("джерело без даних — це теж результат").
Press: June 2025 the OVA head announced GPV in Kherson with schedules from Khersonoblenergo published via social channels (UNVERIFIED channel; no Telegram/Facebook links on the homepage HTML).

## Address search

Not available.

## Recommendation for SDK

Ship region as `unsupported`/`unresolved` with a probe: if `/disconnection/schedule/` ever returns a non-empty body, flag for re-research. Group naming presumably `1.1`–`6.2` per national instruction (UNVERIFIED for Kherson).
