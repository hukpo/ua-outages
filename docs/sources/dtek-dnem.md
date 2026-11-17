# DTEK dnem — www.dtek-dnem.com.ua — ДТЕК Дніпровські електромережі (Dnipropetrovsk oblast)

Researched 2026-11-05 ~23:30 Europe/Kyiv. Status: **BLOCKED for plain HTTP** (curl and Node 22 `fetch`, browser UA + Accept/Accept-Language headers).

Protocol (page with `DisconSchedule.*` JSON, `POST /ua/ajax` getStreets/getHomeNum/checkDisconUpdate with cookies + `X-CSRF-Token`)
is identical to dtek-oem — see **../dtek-oem/NOTES.md** for endpoints, shapes, slot values (24 hourly slots, yes/no/first/second/maybe/mfirst/msecond)
and group naming (`GPV1.1` → `1.1`). CSRF param name is expected to be `_csrf-dtek-dnem` (UNVERIFIED — page never loaded).

## What we got

- `GET /ua/shutdowns` → HTTP 200 (!) with JS challenge: 212-byte page with `/_Incapsula_Resource?SWJIYLWA=...` script. Sets `visid_incap_*`/`incap_ses_*` cookies. → `blocked-first-get.html`
- Repeating the GET with those cookies → HTTP 200, ~950-byte "Request unsuccessful. Incapsula incident ID" iframe page. → `blocked-retry-with-cookies.html`
- (kem) `GET /`, `/ua/news` → same challenge; static `/src/js/static/discon-schedule.js`, `/robots.txt`, `GET /ua/ajax` → served normally.
- (kem, dnem) `POST /ua/ajax` without CSRF → 400 `Bad Request (#400): Не вдалося перевірити передані дані.` — i.e. AJAX reaches the app but
  needs a CSRF token + `_csrf` cookie that only the (challenged) HTML page provides.
  Detection rule: HTTP 200 but no `DisconSchedule.fact` and no `<meta name="csrf-token"` (body < ~5 KB) ⇒ WAF block. Status code is useless.
  IP/incident ids in saved samples are redacted.

## What reference repos do

shed-crypto/dtek-blackout-client (MIT): `curl_cffi` Chrome TLS impersonation, warm-up GET for cookies, optional Playwright+stealth to solve the
challenge and lift cookies + CSRF; also accepts a user-supplied `ajax_url`. groove-max/ha-dtek-monitor (PolyForm-NC): oem only, curl_cffi impersonation.
Not attempted here (out of scope: no WAF bypass).

## Alternative official source

YASNO regionId=3 dsoId=301 (ДнЕМ; see ../yasno/NOTES.md) — WAF-free, oblast-wide cities/streets/houses/group.

## Status 2026-11-17: second source of `dnipro`

`/ua/ajax` answers plain requests here (15:40 Kyiv, a Ukrainian residential address): POST without a token → 400 with
`Set-Cookie: _csrf-dtek-dnem`; with `X-CSRF-Token` built from it → 200. `checkDisconUpdate`: `fact.update` 17.11.2026 00:43, 12 queues; YASNO `updatedOn` 17.11 06:10:27.
Every queue had the same intervals as YASNO for 17.11; neither had 18.11 yet.

Since 0.4.3 the site is merged with YASNO for `dnipro` (`dtekSiteSource` in `src/providers/dtek.ts`): `/ua/ajax` first, the
page if that fails. Address lookup stays on YASNO. Not measured: which of the two has a change first, and whether YASNO ever
re-stamps old hours after the site has changed (the merge takes the newer stamp).
