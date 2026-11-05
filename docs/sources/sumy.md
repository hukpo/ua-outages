# Sumyoblenergo (Сумська) — research notes

Researched 2026-11-05 (~21:35 Europe/Kyiv). GPV was **active** that day, so `schedules-2026-11-05.json` is a populated real sample.

## Sites

- Official site: https://www.soe.com.ua/ (Next.js app, nginx, **not** behind Cloudflare, IP 93.183.206.108).
- The apex https://soe.com.ua/ is behind a **Cloudflare managed challenge** (403, `cf-mitigated: challenge`, "Just a moment..."). Always use `www.`.
- Schedule + address UI: https://www.soe.com.ua/consumers/shutdowns. The page is rendered client-side, so the HTML has no data.
- Personal account: https://sm.e-svitlo.com.ua/ (needs login, not used here).

## API (found in the JS bundle `/_next/static/chunks/3065_9tk1io81.js`, module 72136)

Base URL: `https://www.soe.com.ua/next-api` (the bundle hard-codes `http://`; https works).
Every call is a `GET`.

Required headers. Verified: without them you get `403 {"message":"Access Denied"}` (see `error-403-no-referer.json`).

- `Referer: <anything>`. Any value passes; the check only tests that the header is present. Use `https://www.soe.com.ua/consumers/shutdowns`.
- `User-Agent`: any non-default value. Node's default UA (`node`) and curl's default UA get 403. `ua-outages/0.1` returns 200.
- `X-Source: soe-website` is what the site sends. It isn't required, but send it anyway.
- `Origin` alone (without Referer) gets 403.

| Purpose                                                   | Path                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GPV schedule, all 12 subqueues, today                     | `/shutdowns/schedules`                                                                                  |
| City search                                               | `/shutdowns/cities?search=<text>`                                                                       |
| Street search                                             | `/shutdowns/streets?cityId=<id>&search=<text>` (the UI waits for 3+ chars)                              |
| House search                                              | `/shutdowns/houses?streetId=<id>&search=<text>` (1+ char)                                               |
| Queues for every house on a street (optionally one house) | `/shutdowns/queues-by-street?streetId=<id>[&houseId=<id>]`                                              |
| Queue by account number                                   | `/shutdowns/queue-by-account?accountNumber=<n>` (personal data, UNVERIFIED, not tested)                 |
| Queue by meter number (business)                          | `/shutdowns/queue-by-meter?meterNumber=<n>[&accountNumber=<n>]` (UNVERIFIED)                            |
| Current outages                                           | `/shutdowns/by-street?streetId=..[&type=]`, `/shutdowns/by-house?houseId=..[&type=]` (UNVERIFIED shape) |

```bash
curl -s -A 'ua-outages/0.1' -H 'Referer: https://www.soe.com.ua/consumers/shutdowns' \
     -H 'X-Source: soe-website' https://www.soe.com.ua/next-api/shutdowns/schedules
# -> {"payload":"<base64>"}
```

### Response envelope is encrypted (AES-GCM with a key in the public JS)

Every next-api response looks like `{"payload": base64}`. The site decrypts it in the browser like this:

```
bytes = base64decode(payload); iv = bytes[0:12]; ciphertext+tag = bytes[12:]
key   = utf8(keyString), raw AES-256-GCM key (32 bytes)
keyString = `qasdw-enjenf-twfeft!!d451qwqw!-${Y}-${M0}-${D}-${H}-${floor(min/5)+off}`.padEnd(32,"x").slice(0,32)
```

**Gotcha:** the prefix is already 31 characters, so `.slice(0,32)` cuts off the whole timestamp. The effective key is the **constant** `qasdw-enjenf-twfeft!!d451qwqw!-2` (32 bytes, where "2" is the first digit of the year). The site tries offsets 0 and −1, but with the truncation both give the same key. Every capture today decrypted with that string.

This is the site's own client-side obfuscation, not a WAF or captcha. If the site changes the key, decryption will fail: fall back to recomputing the template and log loudly. The `*.raw.json` fixtures keep the original envelope plus `_meta.keyString`, so a decrypt unit test can use them.

Reference: Kerber0ss/esvitlo-web `lib/shutdowns.ts` uses the same approach (repo has no license, so read it only, don't copy).

## Schedule format (`schedules-2026-11-05.json`, decrypted)

```json
{"data":[{"cherga_n":"1.1","no_data":false,"last_update":"Оновлено: 05.11.2026 21:21",
  "lst_time_disc":[{"start_time":"08:00","end_time":"12:00","diff_time":"4 год. 00 хв."}, ...],
  "text_time_munyv":"...","text_time_curent":"...","text_time_tom":"..."}, ...]}
```

- The response has 12 entries, `cherga_n` "1.1" through "6.2", which map directly to group ids.
- **There is no date field.** The site renders the intervals as _today_ in local time (`setHours` on `new Date()`). Treat the schedule as today's date in Europe/Kyiv. The `last_update` date usually matches today, but it is the update time, not the schedule date. A tomorrow schedule isn't exposed by this endpoint (UNVERIFIED whether it ever is; the site only shows one day).
- `end_time` "00:00" means 24:00, the end of the day.
- **Duplicate and overlapping intervals happen**, e.g. 1.1 has `20:00–00:00` and `22:00–00:00`, and 3.2 has `22:00–00:00` twice. Sort and merge overlaps.
- Half-hour boundaries occur (3.1 `18:00–21:30`).
- Every interval is a definite outage (`kind: "off"`). The format has no "maybe" state.
- `no_data: true` presumably means no schedule (UNVERIFIED; the UI shows "no GPV" when every `lst_time_disc` is empty).
- Freshness: parse `last_update` (`Оновлено: DD.MM.YYYY HH:MM`, Kyiv time). The UI refetches every 15 minutes.

Conversion: for each entry, group = `cherga_n`. For each interval, start = today + start_time and end = today + end_time, with 00:00 meaning the next day 00:00. Merge, then emit `{start, end, kind:"off"}`.

## Address → group (all verified, no captcha)

1. `cities?search=Шостк` returns `{"data":{"result":0,"list":[[5911000000,"м.Шостка (Шосткинський Район/М.Шостка)"]]}}`. The id is a KOATUU code.
2. `streets?cityId=5911000000&search=Шевч` returns `list: [[7549,"вулиця Шевченка"], ...]`.
3. `houses?streetId=7549&search=1` returns `list: [[211911,"14"], ...]`.
4. `queues-by-street?streetId=7549&houseId=211911` returns `list: [[city, street, house, [ГАВ, АЧР, СГАВ, ГПВ, САВН, ГОП, ГОЕ]]]`.
   - Index **3 is ГПВ**. The value is a string like `"6.1"` or `"4.1,6.1"` (comma-separated when a building has several connections), or `null`.
   - The other indices are emergency queues: 0 ГАВ, 1 АЧР, 2 СГАВ, 4 САВН, 5 ГОП, 6 ГОЕ.
   - Without `houseId` the endpoint returns every house on the street (`address-4-queues-by-street.json`, 39 rows).

**Gotcha:** every address sampled in **Sumy city** (5910100000: вул. Харківська, Соборна, Курська, Іллінська, Петропавлівська, пр. Лушпи) has `null` at index 3, so it has no GPV subqueue. See `sumy-city-kharkivska-gpv-null.json` (trimmed to 12 rows). Shostka and Romny return values. It's unclear whether Sumy city is missing from this lookup or exempt from GPV. Account lookup may be the only route there (UNVERIFIED).

## Files

- `schedules-2026-11-05.json`: decrypted, populated, all 12 groups.
- `schedules-2026-11-05.raw.json`: the encrypted envelope plus `_meta` (url, fetchedAt, keyString), for a decrypt test.
- `address-1-cities.json`, `address-2-streets.json` (+ `.raw.json`), `address-3-houses.json`, `address-4-queues-by-street.json` (+ `.raw.json`), `address-5-queues-by-street-house.json`: the address flow.
- `sumy-city-kharkivska-gpv-null.json`: example with GPV null.
- `error-403-no-referer.json`: the 403 response without Referer.

## Rate limits / failure modes

- 10 rapid requests all returned 200. No rate-limit headers were seen. Poll at most every 5–15 minutes.
- Missing Referer or a default UA gets `403 {"message":"Access Denied"}` (JSON).
- The apex domain returns the CF challenge, so never use it.
- Key change or bundle change makes decryption fail.
- The backend API `https://www.soe.com.ua/api/*` (news and so on) returned 500 for news. It isn't needed.

## Reference repos

- Kerber0ss/esvitlo-web (no license): TS client for this same next-api, including decryption.
- OlegVapnik/svitlo `docs/osr-direct-sources.md` (no license): lists Sumy as `url-only`.
- yaroslav2901/OE_OUTAGE_DATA has no Sumy file.
