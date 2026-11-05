# YASNO (app.yasno.ua) — Kyiv city & Dnipro region

Researched 2026-11-05 (~23:30 Europe/Kyiv). Status: **works with plain `fetch`** (no special headers, no cookies, no token).

YASNO is the supplier brand of the DTEK group. Its public "blackout-service" API publishes the schedules
of the DTEK grid operators themselves:

| regionId | region (`value`) | dsoId | DSO name (from API)                                       | equivalent DTEK site |
| -------: | ---------------- | ----: | --------------------------------------------------------- | -------------------- |
|       25 | Київ             |   902 | ТОВ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ»                         | dtek-kem.com.ua      |
|        3 | Дніпро           |   301 | ДнЕМ (= ДТЕК Дніпровські електромережі)                   | dtek-dnem.com.ua     |
|        3 | Дніпро           |   303 | ЦЕК (likely Центральна енергетична компанія — UNVERIFIED) | — (non-DTEK DSO)     |

`hasCities: false` for Kyiv, `true` for Dnipro (DnEM covers the whole Dnipropetrovsk oblast — 1100 localities).
This makes YASNO the practical, WAF-free route for **dtek-kem** and **dtek-dnem** data (their own sites challenge plain HTTP clients).

## Base URL

`https://app.yasno.ua/api/blackout-service/public/shutdowns`

Responses: `application/json; charset=utf-8`, `cache-control: max-age=300, public`, `etag` present
(so `If-None-Match` should work — UNVERIFIED). Behind Imperva (`x-cdn: Imperva`, sets `visid_incap_*`/`incap_ses_*`
cookies) but no challenge was served to curl or Node 22 `fetch` with default headers. No rate limit observed (~30 requests).
Errors are RFC 9110 problem-details JSON (`error-404-*.json`).

## Endpoints

### 1. Regions / DSOs — `GET /addresses/v2/regions`

```
curl https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/regions
```

`[{ id, value, hasCities, dsos: [{ id, name }] }]` → `regions.json`

### 2. Planned outages (today + tomorrow) — `GET /regions/{regionId}/dsos/{dsoId}/planned-outages`

```
curl https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages
```

Samples: `planned-outages-25-902.json` (Kyiv, 60 groups), `planned-outages-3-301.json` (DnEM, 12 groups), `planned-outages-3-303.json` (CEK, 12 groups).

```jsonc
{
  "1.1": {
    "today":    { "slots": [{ "start": 0, "end": 90, "type": "Definite" }, ...],
                  "date": "2026-11-05T00:00:00+02:00",   // local midnight with offset
                  "status": "ScheduleApplies" },
    "tomorrow": { ...same... },
    "updatedOn": "2026-11-05T19:15:03+00:00"             // UTC; same value for all groups of a DSO
  }, ...
}
```

- `start`/`end`: **minutes from local (Europe/Kyiv) midnight** of `date`; `end` is exclusive; `end` may be 1440.
  Slots tile the whole day contiguously (observed: 0→1440 with no gaps).
  Reference impl converts via `divmod(minutes, 1440)` so values >1440 would roll to next day (never observed).
  DST: treat minutes as wall-clock (reference does `datetime.combine(date, time(h, m), tz=Kyiv)`).
- `type` (observed today): `Definite` (= outage), `NotPlanned` (= power on). Reference repo's enum knows only those two.
  Any other value → treat as `maybe`/unknown and log (UNVERIFIED whether e.g. a "possible" type exists).
- `status` values (from reference repo constants; only `ScheduleApplies` observed today):
  `ScheduleApplies` (slots valid), `WaitingForSchedule` (tomorrow not published yet — slots likely empty),
  `NoOutages`, `EmergencyShutdowns` (emergency outages — schedule does not apply).
- `today`/`tomorrow` keys may be absent (reference code guards for missing day / missing `date`).

**Group naming:** keys are `"<queue>.<subqueue>"`. Kyiv (902) currently returns **60 groups `1.1`…`60.1`** (only `.1`
subgroups; 35 distinct schedules among them). DnEM/CEK return the classic 12: `1.1`…`6.2`.
Don't hardcode group lists — read the keys.

**Mapping → `{start,end,kind}`:** for each day in (today, tomorrow) with `status == ScheduleApplies`: `base = date`
(parse ISO, it already carries +02:00/+03:00); for each slot with `type == "Definite"` emit
`{start: base+start min, end: base+end min, kind: "off"}`; skip `NotPlanned`; unknown type → `kind: "maybe"`.
Merge adjacent `off` slots if desired (API already returns merged ranges).
Freshness: `updatedOn` (per group, UTC).

### 3. Probable (weekly template) outages — `GET /probable-outages?regionId=&dsoId=`

```
curl 'https://app.yasno.ua/api/blackout-service/public/shutdowns/probable-outages?regionId=25&dsoId=902'
```

`{ "<regionId>": { dsos: { "<dsoId>": { groups: { "<group>": { slots: { "0": [slot...], ..., "6": [...] } } } } } } }`
Weekday keys `"0"`…`"6"`; reference treats them as Python `weekday()` → **0 = Monday** (UNVERIFIED against YASNO UI).
Today every slot is `{0,1440,NotPlanned}` (no weekly template active) → `probable-outages-25-902.json`.

### 4. Address search (city → street → house → group)

All `GET` on `/addresses/v2/...`, query-string params, results `[{ id, value }]`, **max 20 results**, substring match.

| step | endpoint   | params                                                                                        | notes                                                                                                                                                                                                                       |
| ---- | ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | `/cities`  | `regionId`, `dsoId`, optional `query`                                                         | only for `hasCities: true` regions. **Not used by reference repo; found by probing.** Without `query` returns all (1100 items for 3/301, `cities-dnipro-301.json`); with `query=Дніпро` → 11 items, Dnipro city is `id: 6`. |
| b    | `/streets` | `regionId`, `dsoId`, `query` (**≥ 3 chars**, shorter → `[]`), `cityId` (when hasCities)       | `streets-kyiv-902-khresh.json` (`query=Хрещ` → `вул. Хрещатик` id 915); `streets-dnipro-301-city6-yavorn.json`. Without `cityId` searches whole region.                                                                     |
| c    | `/houses`  | `regionId`, `dsoId`, `streetId`, `query` (may be empty → first 20), `cityId` (when hasCities) | `houses-kyiv-902-915.json` (`"6"` → id 41296), `houses-dnipro-301-city6-1587.json`. Values are free-form strings (`"10,12"`, `"20-22П/П-С"`, `"8А"`).                                                                       |
| d    | `/group`   | `regionId`, `dsoId`, `streetId`, `houseId`, `cityId` (**required** when hasCities)            | `{ "group": 20, "subgroup": 1 }` → `"20.1"`. `group-kyiv-902-915-41296.json`, `group-dnipro-301-city6-1587-85578.json`.                                                                                                     |

```
curl -G https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/group \
  --data-urlencode regionId=3 --data-urlencode dsoId=301 --data-urlencode cityId=6 \
  --data-urlencode streetId=1587 --data-urlencode houseId=85578      # → {"group":5,"subgroup":1}
```

Gotcha: for Dnipro, `/group` **without `cityId` returns 404** `"Street 1587 not found in Region 3 and Dso 301"`
(`error-404-street-not-found.json`) even though `/houses` without cityId works. Unknown house → 404 `EntryNotFound`.
Street names contain prefixes (`вул.`, `просп.`, `пров.`, `ріг ...`) and duplicates/variants — show all to user.

## Failure modes

- Wrong path → 404 problem JSON (`error-404-bad-path.json`).
- Network/5xx: none observed. Imperva could start challenging at any time (it is in front) — detect non-JSON / `_Incapsula_Resource` body.
- `WaitingForSchedule` for `tomorrow` before it's published (typically evening).

## Reference

- https://github.com/denysdovhan/ha-yasno-outages — MIT (© 2024 Denys Dovhan). Files: `custom_components/yasno_outages/api/{const,base,planned,probable,models}.py`.
  Sends no custom headers (plain aiohttp).

## Files

`regions.json`, `cities-dnipro-301.json`, `streets-*.json`, `houses-*.json`, `group-*.json`, `planned-outages-{25-902,3-301,3-303}.json`,
`probable-outages-25-902.json`, `error-404-bad-path.json`, `error-404-street-not-found.json`. All raw, untrimmed.
