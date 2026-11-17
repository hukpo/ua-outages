# DTEK krem — www.dtek-krem.com.ua — ДТЕК Київські регіональні електромережі (Kyiv oblast)

Researched 2026-11-05 ~23:30 Europe/Kyiv. Status then: **BLOCKED for plain HTTP** (curl and Node 22 `fetch`, browser UA + Accept/Accept-Language headers). Since 2026-11-17 the SDK reads the region through `/ua/ajax` alone, see the last section.

Protocol (page with `DisconSchedule.*` JSON, `POST /ua/ajax` getStreets/getHomeNum/checkDisconUpdate with cookies + `X-CSRF-Token`)
is identical to dtek-oem — see **../dtek-oem/NOTES.md** for endpoints, shapes, slot values (24 hourly slots, yes/no/first/second/maybe/mfirst/msecond)
and group naming (`GPV1.1` → `1.1`). The CSRF cookie is `_csrf-dtek-krem` (verified 2026-11-17).

## What we got

- `GET /ua/shutdowns` → HTTP 200 (!) with Hard block: ~840-byte page with iframe `/_Incapsula_Resource?SWUDNSAI=31&...` and text "Request unsuccessful. Incapsula incident ID: ...". Sets `visid_incap_*`/`incap_ses_*` cookies. → `blocked-first-get.html`
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

none found among official sources; YASNO does not list a Kyiv-oblast DSO (regions endpoint only has 25/Київ and 3/Дніпро).

## Status 2026-11-17

`/ua/shutdowns` is still challenged from a Ukrainian residential address: HTTP 200 with a ~950-byte page whose only content is
`<script src="/_Incapsula_Resource?SWJIYLWA=…">`. `/ua/ajax` is not, and the SDK reads the region through it alone
(`route: 'ajax'` in `src/providers/dtek.ts`), by the owner's decision:

1. `POST /ua/ajax` with `method=checkDisconUpdate&update=01.01.2000 00:00` and no token → 400
   `Bad Request (#400): Не вдалося перевірити передані дані.` with `Set-Cookie: _csrf-dtek-krem=<64-char signature>a:2:{i:0;s:15:"_csrf-dtek-krem";i:1;s:32:"<token>";}`
   (URL-encoded; Yii2), plus `dtek-krem`, `_language` and the Incapsula cookies.
2. The same POST with those cookies and `X-CSRF-Token: base64url(mask + (mask XOR token))` (Yii2's masked token, what the page
   prints in its meta tag) → 200 `{result, fact, preset, showTableSchedule, showUserGroup}`, 30 KB. Headers sent besides:
   `X-Requested-With: XMLHttpRequest`, `Origin`, `Referer`.
3. `method=getStreets` → `{result, streets}`, 468 KB, 1198 settlements. `method=getHomeNum` as on dtek-oem.

Verified live at 11:35 Kyiv with the SDK's default User-Agent: 12 groups, `fact.update` "16.11.2026 23:37", one day
(17.11); м. Ірпінь, вул. Західна → houses 2, 4, 6, …; м. Бровари, вул. Київська, 1 → 2.1 (also 3.1, 1.2).
Not verified: from outside Ukraine; a filled tomorrow key; how long a token stays valid (the SDK takes a new one for every
schedule read and keeps it at most 10 minutes for address requests).

No challenge is solved and no browser is imitated. If Imperva starts answering `/ua/ajax` with the stub (as it does for
Donetsk), the region is `blocked` again. No other official source was found (YASNO lists only Kyiv city and Dnipro; no
public Telegram channel with group times).
