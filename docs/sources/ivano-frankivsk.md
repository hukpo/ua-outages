# Ivano-Frankivsk — АТ «Прикарпаттяобленерго» (oe.if.ua)

Researched 2026-11-05. Status: **no active ГПВ** (`/schedule-by-queue` returns `[]`; archive page says "Відключень не було" for 01–04.11.2026).

## Official pages

- ГПВ SPA: https://svitlo.oe.if.ua/ (Vite/React bundle `/assets/index.<hash>.js`, axios `baseURL: "https://be-svitlo.oe.if.ua/"`)
- https://oe.if.ua/uk/shutdowns_table (planned/emergency works, server HTML), https://oe.if.ua/uk/schedule_archives (ГПВ archive, HTML: per day "Відключень не було" or images — UNVERIFIED for days with outages).
- Gotcha: `oe.if.ua` sends gzip even when the client didn't ask (`curl` without `--compressed` gets binary). Node fetch is fine.

## Plain fetch

Works for the API. `GET https://be-svitlo.oe.if.ua/` (root) returns **403** — that is only the root; endpoints return 200 with no special headers (no Origin/Referer needed). Behind CloudFront (`x-cache: Miss from cloudfront`, `cache-control: no-cache`). No rate limit observed.

## Endpoints (`https://be-svitlo.oe.if.ua`)

| Method               | Path                           | Notes                                             |
| -------------------- | ------------------------------ | ------------------------------------------------- |
| GET (SPA uses POST)  | `/gpv-queue-list`              | `[{id, code:"1.1", label:"черга 1.1"}]` × 12      |
| GET                  | `/schedule-by-queue?queue=1.1` | `ScheduleDay[]`, `[]` when nothing published      |
| POST form-urlencoded | `/schedule-by-search`          | address/account → queue + schedule                |
| —                    | `/GavByQueue`                  | old endpoint seen in third-party code, UNVERIFIED |

```
curl 'https://be-svitlo.oe.if.ua/schedule-by-queue?queue=4.2'
curl -X POST https://be-svitlo.oe.if.ua/schedule-by-search \
  --data-urlencode accountNumber= --data-urlencode userSearchChoice=pob \
  --data-urlencode 'address=Івано-Франківськ,Галицька,1'
```

Body is `application/x-www-form-urlencoded` (the SPA builds `URLSearchParams`). `userSearchChoice`: `pob` (household; with `accountNumber` = personal account, or with `address`), `jur` (legal entity; `accountNumber` = meter no.). Address search = "Усі споживачі" tab: `address = "<city>,<street>,<building>"`, `accountNumber=""`.

### Schedule format (`ScheduleDay`)

```json
{
  "eventDate": "25.11.2025",
  "queues": { "4.2": [{ "shutdownHours": "16:30-20:00", "from": "16:30", "to": "20:00", "status": 1 }] },
  "createdAt": "24.11.2025 19:52",
  "scheduleApprovedSince": "24.11.2025 19:52"
}
```

- Array of days (today and, after evening publication, tomorrow). Select by `eventDate` (`DD.MM.YYYY`, Kyiv local); there may be several rows for the same date — third-party code takes the **last** one (UNVERIFIED why).
- `queues[group]` — intervals; `status: 1` = scheduled outage (`off`), `0` = no outage (per BogdanGrushetsky/telegram-outage-bot constants). No observed "maybe" status — treat any other value as unknown/`maybe` (UNVERIFIED). `to` may be `24:00` (UNVERIFIED) → next-day 00:00.
- `queues[group] == []` with an `eventDate` → SPA shows "NO_SCHEDULE_PLANNED" (no outages for that group).
- Updated-at: `scheduleApprovedSince` (`DD.MM.YYYY HH:mm`, Kyiv). Response type from bundle also has top-level `showFutureDateUntil` (UNVERIFIED).
- `/schedule-by-queue` with a queue param returns all queues or only the requested one? — UNVERIFIED (empty now). Parser should iterate `Object.entries(queues)` either way.

### Address search responses (`/schedule-by-search`) — HTTP status matters

- **200** found: `current = {queue:"3", subQueue:"2", hasQueue:"yes", note, gav:{queue}, sgav:{queue}}`, `schedule: ScheduleDay[]` (same as above). Group = `${queue}.${subQueue}`.
- **300** multiple: `hasQueue:"many"`, `queue:"-1"`, `possibleQueues:["1.1","1.2"]`. Don't treat 3xx as redirect error (fetch won't follow, no Location header — OK).
- **404** not found: `queue:""`, note "Інформація по вказаній адресі ... не знайдена".
- **204** (from bundle message map): consumer not in any ГПВ queue (UNVERIFIED, not reproduced). 400 = bad input.
- Address matching is exact-ish on the free-text triple: `Івано-Франківськ,Незалежності,1` works, `вул. Незалежності` does not. **No autocomplete / street directory endpoint** → SDK can only offer free-text city/street/house; normalise (strip "вул.", "м."). The note echoes the input and contains a timestamp (`Станом на 23:33 05.11.2026`).

## Group naming

`1.1 … 6.2` (12).

## Files

- `gpv-queue-list.json` — real.
- `schedule-by-queue.1.1.current-empty.json` — real, `[]`.
- `schedule-by-search.found-single.json` (200), `.many-300.json` (300), `.not-found-404.json` (404) — real, public addresses only.
- `schedule-by-queue.RECONSTRUCTED-populated.json` — **RECONSTRUCTED** from the MIT-licensed test fixture in odykyi-dev/shutdown-notification-bot (tests/test_logic.py); shape matches other clients' TS types. Not a captured response.

## References

- just-an-ordinary-user/blackouts-web `src/types/Response.d.ts` (TS types of the API; license not checked)
- strange-v/power-outage-schedule-card (MIT) — Home Assistant config using `/schedule-by-search`
- odykyi-dev/shutdown-notification-bot (MIT), BogdanGrushetsky/telegram-outage-bot (no license)
- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license) — survey of official sources for all regions
