# Kharkiv — АТ «Харківобленерго»

Verified 2026-11-05 ~23:35 Kyiv. GPV active (news posts daily for 29.10–06.11).

## What the SDK reads (since 2026-11-17)

Measured 17.11.2026, see `research/freshness/CHANNELS-A.md`.

| Source id                 | Channel                                                                                                | Role    |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `site`                    | JSON:API on `https://www.oblenergo.kharkiv.ua`, then `https://oblenergo.kharkiv.ua` if the first fails | primary |
| `telegram:@kharkivenergy` | `https://t.me/s/kharkivenergy`, posts since yesterday noon (≤ 2 pages)                                 | second  |

- **Host.** On 16–17.11 the bare host answered HTTP 400 "The provided host name is not valid for this server" on every path while `www.` served the same API (still so at 05:30 on 17.11). `www.` is tried first, the bare host second.
- **Which is first.** Telegram, by a median 3 min (1–13) over 10 evenings. The site post for 14.11 came 8 h 39 min late, and for 17.11 it was still absent at 05:30 while Telegram had it since 16.11 23:02. The text is identical; one parser reads both.
- **Merge** (`mergeSources`): per date the newer of the site node's `changed` and the Telegram post time wins; `updatedAt` is that time. An edited Telegram post keeps its original time.
- **Day of a post**: from the date in its text ("у вівторок, 17 листопада"), never from the post time. ГАВ notices and news in the channel have no group lines and are skipped.
- An update posted during its own day lists only the hours still ahead (an outage in progress is listed from its start; a group with nothing more is left out). The SDK therefore layers a day's posts oldest first (`layerPublications` in `src/providers/posts.ts`): a post published before the day is the whole day; a later one keeps the earlier outages before the minute it takes effect and replaces the rest. No same-day update was seen here in 06–16.11; the rule is the neighbouring operators' and changes nothing for a post that lists the whole day.
- **Failure modes**: one source down → the other answers, the failure is listed in `sources`; both down → the site's error. Telegram alone gives today and later only. The JSON:API may serve a page up to 45 min old (`max-age=2700`); Telegram covers that gap.

## Domains

`www.oblenergo.kharkov.ua` → 301 → **`https://oblenergo.kharkiv.ua/uk`** (Drupal, Cloudflare). Personal account / address tool: `https://pa.oblenergo.kharkiv.ua` (Yii2, Cloudflare).
Plain `curl` / Node 24 `fetch` with default headers → 200 on everything below.

## Source type

No dedicated schedule page. Schedule is published as a **news node** whose body is HTML text. Drupal **JSON:API is open** — the clean way to read it.

### Primary: JSON:API

```
GET https://oblenergo.kharkiv.ua/uk/jsonapi/node/newsforlenta
    ?sort=-created&page[limit]=10
    &fields[node--newsforlenta]=drupal_internal__nid,title,created,changed,field_datanews,body
    &filter[t][condition][path]=title
    &filter[t][condition][operator]=CONTAINS
    &filter[t][condition][value]=погодинн
```

(URL-encode the Cyrillic; brackets may stay raw.) Response `application/vnd.api+json`: `data[].attributes.{drupal_internal__nid,title,created,changed,field_datanews,body:{value,format,processed,summary}}`, `links.next` for paging. Fixture: `jsonapi-newsforlenta-gpv-2026-11-05.json` (10 posts).
`cache-control: max-age=2700, public` — page cache may serve up to 45 min old copies (cf-cache-status DYNAMIC today). Add a cache-buster query param if needed (UNVERIFIED whether Drupal honours it).
Other: `/uk/rss.xml` (all news, body included for latest only), node page `/uk/node/{nid}` (fixture `node-13883454-article.trimmed.html`).

### Body format

Title: `У Харківській області 6 листопада діятимуть графіки погодинних відключень` (variants: `діятимуть погодинні відключення`, suffix ` (оновлено)`). Non-schedule posts also match the filter (e.g. `Як зрозуміти, коли вимкнуть світло…`) → require queue lines.

```html
<p>
  … у п'ятницю, 6 листопада, з 00:00 до 24:00 у Харківській області будуть діяти графіки погодинних відключень
  (ГПВ).
</p>
<p>
  Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):
</p>
<p>1.1 00:00-03:00; 08:00-13:30; 17:00-24:00<br />1.2 00:00-03:00; …<br />6.2 06:30-10:00; 13:30-20:30</p>
<p>Перелік адрес за чергами - <a href="…/Адреси та черги 26-27.pdf">тут</a>.</p>
```

Parse: split on `<br>`/`</p>`, `^([1-6]\.[12])\s+(.+)$`, intervals separated by `;`, `HH:MM-HH:MM`, `24:00` = end of day. All intervals kind `off` (includes switching time, "орієнтовно"; no maybe). Date from body/title (`6 листопада`, no year — use `field_datanews`/`created` year; note `field_datanews` is the _publication_ date, i.e. day before). Multiple posts for the same date (e.g. 29 Oct original + "(оновлено)") → newest `changed` wins.

Group naming `1.1`–`6.2`.

## Address search

- Official tool: https://oblenergo.kharkiv.ua/uk/gaoinfo → iframe `https://pa.oblenergo.kharkiv.ua/frontend/web/index.php/uk/portal-application/disconnection-by-address`.
- Autocomplete helpers work with plain fetch (no cookie needed):
  - `GET …/uk/helper/get-villages` → `[{aname, adp_id}]` (1782 items; `Харків м. (Хар. обл.)` = 122060) — fixture `helper-get-villages.trimmed.json`
  - `GET …/uk/helper/get-streets?adp_id=122060` → `[{adpid, aname}]` (3291) — `helper-get-streets-122060.trimmed.json`
  - `GET …/uk/helper/get-buildings?adp_id=66990` → `[{adpid, aname:"10 буд."}]` — `helper-get-buildings-66990.json`
- **Final step is blocked**: `POST disconnection-by-address` needs `_csrf_portal` + **Cloudflare Turnstile** token (`DisconnectionByAddressForm[captchaToken]`, sitekey `0x4AAAAAACMeh95aWIDZU0Qj`). Without it → "Необхідно пройти перевірку безпеки." What the result shows (GPV queue or only current outages) is UNVERIFIED.
- Fallback dataset: `addresses-and-queues-2026-27.pdf` (OpenOffice Calc export, 190 KB, valid 01.10.2026–01.04.2027). `pdftotext -layout` gives rows "free-text settlement/street list … X" with the X under column 1–6 / I–II. Mostly businesses and rural settlements as free text; Kharkiv city houses are NOT enumerated → not usable for house-level lookup; column-position parsing is fragile.
- **Verdict: address→group not available without captcha.**

## Failure modes

- Text format may change between posts; "(оновлено)" posts; posts announcing "не застосовуватимуться" (UNVERIFIED wording).
- Cloudflare in front of both hosts; no challenge seen for API/JSON:API.

## Reference repos

- No public Kharkiv scraper found. OlegVapnik/svitlo `docs/osr-direct-sources.md` lists Kharkiv as `url-only` (no license).
- Aggregator cross-check: `aggregator-OE_OUTAGE_DATA-Kharkivoblenerho-2026-11-05.json` (yaroslav2901/OE_OUTAGE_DATA, no license; derived, not official).
