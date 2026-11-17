# ua-outages

TypeScript SDK for Ukrainian power outage schedules (графіки погодинних відключень).

- **Schedules straight from the grid operators.** No aggregators in between: each region reads the operator's own official channels (its API, its site, the files it publishes, its official Telegram channel), and where the operator publishes on several, all of them, taking each day from the one that has it first.
- **Find a group by address.** Settlement, street and house in; the outage group ("черга") out.
- **One shape for every region.** Intervals in Kyiv time with explicit offsets, DST-safe.
- **Health check.** See in one call which sources still parse, so you notice when an operator changes its site.
- **Stale data is detected, not served silently.** Every result says where it came from; `assessFreshness` tells whether it is current, and a failed fetch can fall back to the last good result, marked as such.
- No runtime dependencies. Node 20+.

**See it running: [hukpo.github.io/ua-outages](https://hukpo.github.io/ua-outages/).** A live map of Ukraine where every light is a house in one of the groups and goes dark when its group is scheduled off, plus a countdown for your group, calendar feeds, shared "power everywhere" windows for several addresses, and an archive. It is a static page rebuilt by GitHub Actions every 15 minutes from this SDK (`site/`, `.github/workflows/site.yml`).

```sh
npm install ua-outages
```

```ts
import { OutageClient, stateAt, nextOutage } from 'ua-outages'

const outages = new OutageClient()

const { group } = await outages.findGroup('kyiv', { street: 'вул. Хрещатик', house: '6' })
const schedule = await outages.getSchedule('kyiv', group)

stateAt(schedule.days) // 'on' | 'off' | 'maybe' | 'unknown'
nextOutage(schedule.days) // { from: '2026-11-05T19:30:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' }
```

## Regions

<!-- regions:start -->

| id                | region                  | operator                                | SDK reads                                                                                                                                           | schedule              | address        | notes                                                                                                                                                             | schedule page                                                                                            | lookup page                                                                                  |
| ----------------- | ----------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kyiv`            | Київ                    | ДТЕК Київські електромережі (YASNO)     | app.yasno.ua API + the grid operator's site (dtek-kem.com.ua, /ua/ajax then the page)                                                               | ✅                    | ✅             | the two carry the same schedule; either keeps the region up when the other fails                                                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                      |
| `dnipro`          | Дніпропетровська (ДТЕК) | ДТЕК Дніпровські електромережі (YASNO)  | app.yasno.ua API + the grid operator's site (dtek-dnem.com.ua, /ua/ajax then the page)                                                              | ✅                    | ✅             | the two carry the same schedule; either keeps the region up when the other fails                                                                                  | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `dnipro-cek`      | Дніпропетровська (ЦЕК)  | ЦЕК (YASNO)                             | app.yasno.ua API + Telegram @cek_info                                                                                                               | ✅                    | ✅             | the operator's channel is ahead of YASNO; addresses from YASNO                                                                                                    | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `odesa`           | Одеська                 | ДТЕК Одеські електромережі              | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                      | ✅                    | ✅             |                                                                                                                                                                   | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                              | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                  |
| `kyiv-region`     | Київська                | ДТЕК Київські регіональні електромережі | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                      | ✅                    | ✅             | the schedule page is behind a bot check, so the answer comes from /ua/ajax                                                                                        | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                            | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                |
| `donetsk`         | Донецька                | ДТЕК Донецькі електромережі             | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                      | ⚠️ code ready         | ⚠️ code ready  | the site answers automated clients with a bot check on every route, so requests come back `blocked`; untested against live data                                   | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                              | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                  |
| `lviv`            | Львівська               | Львівобленерго                          | api.loe.lviv.ua, power-api.loe.lviv.ua                                                                                                              | ✅                    | ✅             |                                                                                                                                                                   | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                                      | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                          |
| `ternopil`        | Тернопільська           | Тернопільобленерго                      | api-poweron.toe.com.ua                                                                                                                              | ✅                    | ✅             | schedule read per group via a reference address                                                                                                                   | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                                        | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                            |
| `zakarpattia`     | Закарпатська            | Закарпаттяобленерго                     | Telegram @zakarpatenergyofficial + api-outage-zakarpat-energy.inneti.net: table picture (read by colour)                                            | ✅ image              | ✅             | groups `unknown` while no picture is published; a picture counts only under a channel post that names its date                                                    | [zakarpat.energy](https://zakarpat.energy/customers/break-in-electricity-supply/schedule/)               | [outage.zakarpat.energy](https://outage.zakarpat.energy/schedule_queues)                     |
| `ivano-frankivsk` | Івано-Франківська       | Прикарпаттяобленерго                    | be-svitlo.oe.if.ua                                                                                                                                  | ✅                    | ✅             | full address only, no autocomplete                                                                                                                                | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                              | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                  |
| `chernivtsi`      | Чернівецька             | Чернівціобленерго                       | schedule page + Telegram @oe_cv_ua (change times), district directories                                                                             | ✅                    | ✅             | groups numbered 1–12                                                                                                                                              | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns/)                                                    | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns-search/)                                 |
| `rivne`           | Рівненська              | Рівнеобленерго                          | schedule page + the two address lists (PDF)                                                                                                         | ✅                    | ✅ best effort | the lists are free text: `not-found` with the candidate groups when they don't settle an address                                                                  | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                                    | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                        |
| `volyn`           | Волинська               | Волиньобленерго                         | inneti archive API: table image (read by colour), lookup form                                                                                       | ✅ image              | ✅             | autocomplete for streets and houses; the settlement is typed in full                                                                                              | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/) | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/) |
| `khmelnytskyi`    | Хмельницька             | Хмельницькобленерго                     | schedule page + per-day news post + Telegram @khmelnytskoblenergo (text); archive table image (read by colour) for dates without text               | ✅ text/image         | ✅             |                                                                                                                                                                   | [hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)                                           | [hoe.com.ua](https://hoe.com.ua/shutdown/queue)                                              |
| `chernihiv`       | Чернігівська            | Чернігівобленерго                       | schedule poster from the site + Telegram @chernigivoblenergo (times read from the picture), address list (PDF)                                      | ✅ image              | ✅             | the schedule API and the online lookup need a captcha; the address list is dated 25.12.2025 and has no street types, so a house can come back with several groups | [chernihivoblenergo.com.ua](https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg)           | [interruptions.energy.cn.ua](https://interruptions.energy.cn.ua/interruptions)               |
| `zhytomyr`        | Житомирська             | Житомиробленерго                        | ztoe.com.ua/gpv/api + schedule page, lookup form                                                                                                    | ✅                    | ✅             |                                                                                                                                                                   | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                              | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                  |
| `kirovohrad`      | Кіровоградська          | Кіровоградобленерго                     | kiroe.com.ua JSON (today) + Telegram @SvitloKropyvnytskyiMisto (tomorrow, change times)                                                             | ✅                    | ✅             | tomorrow has no "possible" half hours until it becomes today                                                                                                      | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                                | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                    |
| `cherkasy`        | Черкаська               | Черкасиобленерго                        | news API + Telegram @pat_cherkasyoblenergo, lookup backend                                                                                          | ✅                    | ✅             | the lookup asks the operator about a few of the house's accounts, one request at a time                                                                           | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                                           | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                               |
| `sumy`            | Сумська                 | Сумиобленерго                           | soe.com.ua/next-api + sm.e-svitlo.com.ua (the operator's cabinet)                                                                                   | ✅ today              | ✅             | tomorrow only once E-Svitlo's slot for it is filled (never seen filled: unverified)                                                                               | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                                 | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                     |
| `poltava`         | Полтавська              | Полтаваобленерго                        | poe.pl.ua/customs                                                                                                                                   | ✅                    | ✅             | buildings with several connections have no single group                                                                                                           | [poe.pl.ua](https://www.poe.pl.ua/disconnection/power-outages/)                                          | [poe.pl.ua](https://www.poe.pl.ua/)                                                          |
| `kharkiv`         | Харківська              | Харківобленерго                         | Drupal JSON:API (news) + Telegram @kharkivenergy                                                                                                    | ✅                    | —              | lookup needs a captcha                                                                                                                                            | [oblenergo.kharkiv.ua](https://www.oblenergo.kharkiv.ua/uk)                                              | [oblenergo.kharkiv.ua](https://www.oblenergo.kharkiv.ua/uk/gaoinfo)                          |
| `zaporizhzhia`    | Запорізька              | Запоріжжяобленерго                      | news page, Telegram @Zaporizhzhyaoblenergo_news as the fallback; address sheets (Google Sheets)                                                     | ✅                    | ✅             | lists per group                                                                                                                                                   | [zoe.com.ua](https://www.zoe.com.ua/outage/)                                                             | [Telegram bot](https://t.me/esozoebot)                                                       |
| `mykolaiv`        | Миколаївська            | Миколаївобленерго                       | off.energy.mk.ua API                                                                                                                                | ✅                    | ✅             |                                                                                                                                                                   | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                            | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                |
| `vinnytsia`       | Вінницька               | Вінницяобленерго                        | no official source; with `unofficialSources: true` a community mirror ([vn-progr/gpv-voe-vinnytsia](https://github.com/vn-progr/gpv-voe-vinnytsia)) | ⚠️ opt-in, unofficial | ❌             | the operator gives the hours per queue only behind a bot check, a login or in its bots; see [Unofficial sources](#unofficial-sources)                             | [voe.com.ua](https://www.voe.com.ua/informatsiya-pro-cherhy-hrafika-pohodynnykh-vidklyuchen-hpv-1)       | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/)                                |

**АТ «Укрзалізниця»** is a distribution operator too: homes near stations and along the lines are wired to the railway's grid and get its own schedule, which differs from the oblenergo's. It has one region per oblast page on [uz.gov.ua](https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen/): `uz-kyiv`, `uz-kyiv-region`, `uz-dnipro`, … (`uz-<region id>`), and two branches each in Vinnytsia (`uz-vinnytsia`, `uz-vinnytsia-odesa`) and Sumy (`uz-sumy`, `uz-sumy-south`). The schedule is read from the HTML tables, each filed under the date written above it (usually today's, sometimes tomorrow's too); a table without a date is a `parse` error. When no table is for today, every group comes back `unknown` for today. The page has no change time, so `updatedAt` is null. The same page lists each group's addresses: address lookup and autocomplete work in 24 of the 26 regions (`uz-donetsk` and `uz-kherson` list none). A house inside a run like "1-31" whose side of the street the list doesn't settle is `not-found`.

**Not covered**

| region     | operator         | why                                   | schedule page                                               | lookup page                                                   |
| ---------- | ---------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Вінницька  | Вінницяобленерго | schedule and lookup behind Cloudflare | [voe.com.ua](https://www.voe.com.ua/disconnection/detailed) | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/) |
| Херсонська | Херсонобленерго  | no public schedule                    | [ksoe.com.ua](https://ksoe.com.ua/)                         | —                                                             |

Луганська область and Crimea are not covered. "today" means the channels the SDK reads have shown only the current day. "⚠️ code ready" means the provider is implemented but the operator currently blocks automated requests. "image" means the schedule is read from the picture the operator publishes. "Telegram @…" is always the operator's own official channel, read from its public web preview (`t.me/s/…`).
<!-- regions:end -->

"Address" means the SDK can turn an address into a group. Zakarpattia publishes its schedule only as a picture, on its Telegram channel and through its API. While none is published `getSchedules` lists its groups as `unknown` (not "no outages"). The channel's picture is read under the date in its caption. The API's picture carries no date, so it is read only for a day the channel has posted too, as a cross-check; otherwise the `api` entry of `sources` has an `unsupported` error with the picture's address and the groups stay `unknown`. That the API serves the same table layout as the channel is unverified (no schedule has applied there since 17.10.2026). The address lookup works either way.

### Which channel has a day first

Operators don't publish everywhere at once. Chernihiv's site shows a day's poster only on the morning of that day, while its Telegram channel has it the evening before; Kirovohrad's site never shows tomorrow. So a region reads every official channel that carries the schedule and takes each day from the one that published it last. The ids are those in the result's `sources` (see [Freshness and failures](#freshness-and-failures)); the measurements are from November 2026, details per region in [`docs/sources`](docs/sources).

| region           | `sources`                                       | who has what                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chernihiv`      | `site`, `telegram:@chernigivoblenergo`          | Telegram: tomorrow's poster the evening before and every change. The site: the day's poster at full size, from the morning of that day.                                                                                                                               |
| `kirovohrad`     | `site`, `telegram:@SvitloKropyvnytskyiMisto`    | Telegram: tomorrow the evening before, and the time of every change. The site: today, with the "possible" half hours.                                                                                                                                                 |
| `dnipro-cek`     | `api`, `telegram:@cek_info`                     | Telegram: tomorrow the evening before and every change. YASNO has lagged it by hours.                                                                                                                                                                                 |
| `kharkiv`        | `site`, `telegram:@kharkivenergy`               | The same text; Telegram a few minutes earlier, the site post sometimes hours late.                                                                                                                                                                                    |
| `cherkasy`       | `site`, `telegram:@pat_cherkasyoblenergo`       | The same text within minutes; the site has gone a night without the post Telegram had.                                                                                                                                                                                |
| `khmelnytskyi`   | `site`, `news`, `telegram:@khmelnytskoblenergo` | Telegram and the per-day news post; the schedule page has shown only yesterday past midnight.                                                                                                                                                                         |
| `zaporizhzhia`   | `site`, `telegram:@Zaporizhzhyaoblenergo_news`  | The site has every version. Telegram repeats under half of them: used when the site is down, and for the time of a day's first post.                                                                                                                                  |
| `chernivtsi`     | `site`, `telegram:@oe_cv_ua`                    | The site has the schedule and no change time; the time of the channel's newest post about a day is that time, unless that post says something else in words.                                                                                                          |
| `zhytomyr`       | `api`, `site`                                   | The API has a real change time and wins every day it has; the page stands in when the API fails.                                                                                                                                                                      |
| `sumy`           | `site`, `e-svitlo`                              | The same schedule; the site's grid has no date, E-Svitlo's has, so it dates the grid.                                                                                                                                                                                 |
| `zakarpattia`    | `telegram:@zakarpatenergyofficial`, `api`       | Not measured: no schedule has applied since 17.10.2026.                                                                                                                                                                                                               |
| `kyiv`, `dnipro` | `api`, `site`                                   | YASNO's API and DTEK's own site. On 17.11.2026 they had the same hours in every queue; YASNO's stamp was later for the same schedule (Kyiv 00:00 against 23:46, Dnipro 06:10 against 00:43), so it usually supplies the day. Who has a change first was not measured. |

One entry: `mykolaiv` (`api`); `odesa`, `kyiv-region`, `donetsk`, `volyn` (`site`). No `sources`: `lviv`, `ternopil`, `ivano-frankivsk`, `poltava`, `rivne`, `uz-*`. These read one channel.

### Why some regions are missing

Donetsk (a DTEK site) answers automated clients with a bot check on every route, so its provider reports `blocked`. Kherson publishes no schedule, so it has no provider. This SDK solves no challenge and imitates no browser.

#### Unofficial sources

Vinnytsia is the one region whose operator has no channel a plain request can read. Its address tool answers every route with a Cloudflare challenge, its cabinet wants a login and a consumer's EIC, and the rest are a Telegram bot, a Viber bot and Facebook posts. Its site does say on which date and hours ГПВ applies and has a table of possible hours per queue, but that is not the schedule (on 16.11.2026 queue 3.1 was off in hours the table leaves white).

So by default `vinnytsia` has no schedule: `capabilities.schedule` is false and `getSchedules` throws `unsupported`. If you would rather have a community mirror than nothing, opt in:

```ts
const outages = new OutageClient({ unofficialSources: true })
const s = await outages.getSchedules('vinnytsia')
s.sources // [{ id: 'unofficial:github.com/vn-progr/gpv-voe-vinnytsia', official: false, … }]
```

- The mirror is a JSON file on GitHub that a workflow rebuilds every few minutes from bezsvitla.com.ua, a third-party site that says it takes the data from the operator's site. Two parties stand between the operator and you, neither answerable for the data, and the repository has no licence.
- Its entry in `sources` has `official: false`; no official channel ever has that field.
- `updatedAt` is null: the mirror records when it ran, not when the operator changed anything.
- A day with no outage in any queue is `unknown`, not "no outages": that is what the mirror shows before the operator has published the day.
- A file not rebuilt for 3 hours, or whose own last run failed, is a `parse` error, not old hours.
- No address lookup.

The DTEK sites (`odesa`, `kyiv-region`, `donetsk`) have two routes to the same data: the schedule page, and the `/ua/ajax` endpoint the page itself calls, which takes a CSRF token derived from the cookie the endpoint sets. The provider asks `/ua/ajax` first and the page only if that fails, so a bot check on one route doesn't take the region down; `sources[0].url` says which one answered. Kyiv region's page is behind the bot check and its `/ua/ajax` is not; Donetsk has both behind it for requests from Ukraine.

If an operator grants you access (an allowlisted server, an API key, a data-sharing agreement), pass a `fetch` that applies it. Providers make every request through it:

```ts
const outages = new OutageClient({
  fetch: (url, init) => {
    // e.g. route DTEK requests through the server the operator allowlisted for you
    if (url.startsWith('https://www.dtek-dem.com.ua/'))
      return fetch(url.replace('https://www.dtek-dem.com.ua', ALLOWLISTED_PROXY), init)
    return fetch(url, init)
  },
})
```

In interactive tools (a CLI, a desktop app, a script you run yourself), `fetch` can also be backed by a visible browser window: the person using the tool passes the site's check themselves, and the requests then run in that same browser session. This SDK doesn't ship such a fetch and never solves checks on anyone's behalf. Expect the session to expire and the check to come back. It doesn't fit servers or cron jobs, where nobody is there to pass it.

The same option works for proxies, caching, logging and tests. When an operator opens its data publicly, as YASNO did for Kyiv and Dnipro, support follows; issues and contacts at operators are welcome.

## API

### `new OutageClient(options?)`

| option         | default                  |                                                                                                                                                                         |
| -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheTtlMs`   | `300000`                 | Reuse a region's schedule for this long. `0` turns caching off. Concurrent requests for one region share a single fetch (except calls with a `signal`, see Cancelling). |
| `timeoutMs`    | `15000`                  | Per request.                                                                                                                                                            |
| `retries`      | `1`                      | Extra attempts after a network error or a 5xx. A bot-check page is never retried, whatever its status.                                                                  |
| `maxBodyBytes` | `67108864`               | The largest response body read (64 MB). A larger one is not buffered: the request ends with `too-large`.                                                                |
| `fetch`        | `globalThis.fetch`       | Bring your own (proxy, logging, tests).                                                                                                                                 |
| `userAgent`    | `ua-outages (+repo url)` |                                                                                                                                                                         |
| `providers`    | built-in                 | Replace or extend the regions.                                                                                                                                          |
| `staleIfError` | `false`                  | Default for every schedule call: answer a failed fetch with the last good result, see [Freshness and failures](#freshness-and-failures).                                |

### Schedules

```ts
outages.regions() // RegionInfo[]: id, name, operator, capabilities (schedule, addressSearch, streetSearch, emergency)
await outages.getSchedules('lviv') // every group: { groups, schedules: { '1.1': DaySchedule[] }, updatedAt }
await outages.getSchedule('lviv', '3.1') // one group; accepts "GPV3.1", "черга 3.1", …
```

A `DaySchedule` is `{ date: 'YYYY-MM-DD', status, intervals }`:

- `status` is `scheduled`, `no-outages`, `emergency` (the plan doesn't apply) or `unknown` (not published yet).
- `intervals` are sorted and merged: `{ from, to, kind }`, where `kind` is `off` or `maybe` ("можливе відключення", switching time).

`updatedAt` is when the operator last changed the schedule, when the source says so; it is null where the only stamp is one the page regenerates by itself (Rivne, the railway pages). `fetchedAt` is when the SDK read it. Days are dated by the date the source itself gives, never by the clock, so a page left on yesterday comes back as yesterday. Most regions also return `sources`, and a result served in place of a failed fetch has `stale` set: see [Freshness and failures](#freshness-and-failures).

#### "No outages" vs "nothing published"

The SDK never turns silence into "no outages": a group with no cells, a group named without times ("1.1: графік уточнюється") or a source that publishes nothing comes back `unknown`. Read a result like this:

| you get                                          | it means                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a day with `status: 'no-outages'`                | The operator said there are no outages for that group that day (a cancellation notice, or a published schedule with nothing in that group). |
| a day with `status: 'scheduled'`, no `intervals` | A schedule is in force for that day and has no outage for that group.                                                                       |
| a day with `status: 'emergency'`                 | Emergency outages: the hourly schedule doesn't apply, power may go off at any time. Published, but not "no outages".                        |
| a day with `status: 'unknown'`                   | Nothing is published for that group and day. Not "no outages".                                                                              |
| every day of every group `unknown`               | The operator publishes nothing right now. Regions with a fixed set of groups keep listing them (e.g. Sumy marks every group "no data").     |
| `groups: []`, `schedules: {}`                    | The operator publishes nothing right now, and its groups come only with a schedule (e.g. YASNO, DTEK). The same as all `unknown`.           |
| a missing date                                   | Not published. Most operators publish today and, from the evening, tomorrow.                                                                |

So "no outages" is only ever `no-outages` days or `scheduled` days without intervals. `emergency` means outages without a schedule; anything else (`unknown`, a missing date, no groups) should read as "the schedule isn't published", with a link to the operator's website. `stateAt()` returns `'unknown'` for `unknown` and `emergency` days.

**Upgrading from 0.1.1:** `groups: []` used to be documented as "no outages" for some regions (Zakarpattia, the railway pages). It never means that now, and Sumy, Lviv, Zakarpattia, Ivano-Frankivsk, Ternopil, Mykolaiv, Zaporizhzhia and the railway pages list their groups as `unknown` instead when nothing is published. If your code shows "no outages" for an empty `groups` list, change it to something like:

```ts
const day = schedule.schedules[group]?.find((d) => d.date === kyivDate())
if (!day || day.status === 'unknown') show('Графік не опубліковано')
else if (day.status === 'emergency') show('Аварійні відключення, без графіка')
else if (day.intervals.length === 0)
  show('Відключень немає') // 'no-outages', or 'scheduled' without outages
else showIntervals(day.intervals)
```

**Upgrading from 0.3.x:** what a caller can notice in 0.4.0:

- Results carry `sources` for most regions, and `stale` when served by `staleIfError`.
- Every provider result is validated before it is returned: a malformed one now throws `parse` (see [Freshness and failures](#freshness-and-failures)).
- `healthCheck`: the `staleAfterHours` default went from 72 to 36, and `stale` now follows `assessFreshness` (a source stuck on a past day is `stale` at once; an old `updatedAt` alone no longer is while today is published). Regions have `freshness`, `sources` and `degraded`; the report has `stale` and `degraded`.
- YASNO (`kyiv`, `dnipro`, `dnipro-cek`): a `WaitingForSchedule` day is `unknown` with no intervals (its preliminary slots used to be returned), and `EmergencyShutdowns` on a date after today is `unknown`, not `emergency`.
- More days: Kirovohrad returns tomorrow (from the operator's Telegram channel); Chernihiv returns tomorrow from the evening before; the railway pages return tomorrow's table when the page has one. Fewer where a source is behind: a railway table is filed under the date written above it, not under today, and Volyn's pictures dated before today are no longer read.
- `updatedAt` is null where the old value was a stamp the page regenerates every half hour: Rivne always; Zhytomyr when its API's change time can't be read (the page's stamp is never used); Chernivtsi when the operator's channel has no post about the day (or can't be read).
- 0.4.5: `getHouseOutage` (see [Is this house off now?](#is-this-house-off-now)) and `capabilities.houseOutage`. In the DTEK regions a street's house list is kept for at most 5 minutes (before: until the site's session was renewed), so `findGroup` may ask the site a little more often.
- 0.4.4: `getEmergency` reads more of what operators write. Cancellations in the present tense and as a noun ("скасовуються екстрені відключення", "відміна дії графіку ГАВ"), an edit under the text ("UPD: ГАВ скасовано"), and a second schedule in the same post ("О 21:07 скасовано ГАВ … О 20:45 відміна СГАВ") now end the episode; words of waiting, of a condition or of tomorrow ("про скасування повідомимо додатково", "відміна не планується") don't. `area` can now be a city ("м. Суми") for operators that name one.
- 0.4.4: `khmelnytskyi` with nothing published returns its 12 subgroups with today `unknown` (before: `groups: []`).
- 0.4.4: `khmelnytskyi`: "(оновлено з 18:00, …)" on the page is when a change takes effect; read before that time it is no longer the day's publication time, so `updatedAt` is never ahead of the clock and may be null until then.
- 0.4.4: `khmelnytskyi`: a cancellation on the schedule page or in a news post ("Графік погодинних відключень на 17 листопада скасовано") is read like one on Telegram: the day is `unknown` for every subgroup (before: the older schedule under it stayed).
- 0.4.4: `chernihiv`: a change the operator posts in words without an end ("З 07:15 починається відключення для черг 5/1 та 5/2") makes those queues `maybe` from 07:15 to the poster's next outage, or to midnight (before: the poster's old hours under the time of the change). A later "До 22:00 продовжується" while it runs makes it `off` up to 22:00. A queue in a change that fits nothing, or in a change for two days at once, has that day `unknown` until the next poster; `assessFreshness` then lists `partial`.
- 0.4.4: `chernivtsi`: when the channel's newest post about a day states it in words (an all-clear, group hours) and the page shows something else, the day comes from the post and the `site` source has `disagrees` and no `updatedAt` (before: the page won with the post's time).
- 0.4.4: `kirovohrad`: the day after "ГПВ скасовано до окремого розпорядження" a grid with nobody switched off is today's (`scheduled`, no intervals), published when the order was (before: filed under yesterday, the region read `behind`).
- 0.4.4: `sumy` with E-Svitlo down, 00:00–00:59 Kyiv time: a grid last changed before midnight is not dated and today is `unknown` for every group (before: dated today); from 01:00 as before.
- 0.4.4: `kyiv`, `dnipro`, `dnipro-cek`, in a client that has read the region before: a day whose hours didn't change keeps the publication time it first came with, although YASNO's `updatedOn` (or the DTEK site's update time) has moved on. `sources[].updatedAt` of `api` / `site` can therefore be older than the source's own stamp, and a correction the other channel published in between is no longer overridden. The first read of a new client is as before.
- 0.4.4: `assessFreshness` and `healthCheck` count a day the operator called off as published: a region whose newest word is a cancellation of today is `fresh` / `ok` (before: `behind`, `stale`, and `healthCheck({ strict: true })` failed), with `coveredThrough` reaching that day and `today` still `missing`.
- 0.4.4: input the SDK doesn't understand is a `parse` error where a schedule without those outages used to come back: a Poltava cell of an unknown state, a Mykolaiv row of an unknown type, a Rivne row whose date can't be read ("17.11.2026 (вт)" is read), a GPV day that isn't 24 or 48 cells keyed from 1 (the DTEK regions, Vinnytsia), a railway cell that isn't queues written "3(1,2)" or times, a railway table without its times. A railway queue whose bracket can't be read ("1(,2)", "3(1.2)") has that day `unknown` for both its subqueues (before: one of them switched off by guess).
- 0.4.4: Poltava with no day table on the page and Rivne with only the table header return their 12 groups with today `unknown` (before: `groups: []`).
- 0.4.4: schedule pictures (Volyn, Khmelnytskyi): when the newest picture of a date can't be decoded or its table can't be read, the read fails with `parse` instead of returning an older picture of that date. A picture with no table at all (a text announcement) is still skipped. A table whose header row or label column is exactly the size of its cells is refused as ambiguous.
- 0.4.4: house numbers that differ only by a separator ("1/1" and "11") are two houses in Zaporizhzhia, Lviv, Ternopil and Zakarpattia; Zaporizhzhia's `House.id` keeps the separator ("…#1/1").
- 0.4.4: a new option, `maxBodyBytes` (default 64 MB), and a new error code, `too-large`, for a response over it.
- 0.4.4: `timeoutMs` ends a request also when a custom `fetch` ignores `init.signal`, for the headers and for the body.
- 0.4.4: pictures over 25 megapixels, PDF streams that inflate to more than 64 MB and PDFs of more than 20 000 pages (or whose page tree repeats a node) are refused with `parse`.
- 0.4.4: address lists are no longer kept for the life of the process: settlements and streets for 24 h, the groups of a street's houses for 6 h (Lviv, Ternopil, Zakarpattia, Poltava, Mykolaiv, Zhytomyr, Volyn). A long-running process sends a few more requests.
- 0.4.3: `kyiv` and `dnipro` have a second source, DTEK's own site (`site`), next to YASNO (`api`): two entries in `sources`, and two more requests per read. A YASNO failure no longer fails these regions while the site answers.
- 0.4.3: the DTEK regions ask `/ua/ajax` first and the schedule page second (0.4.2: only `kyiv-region` used `/ua/ajax`, and only it). Their `sources[0].url` is the route that answered, no longer always the page.
- 0.4.2: a new region id, `vinnytsia`, with `capabilities.schedule` false unless the client is created with `unofficialSources: true` (see [Unofficial sources](#unofficial-sources)). Code that walks `regions()` sees one more entry.
- 0.4.1: the DTEK regions (`odesa`, `kyiv-region`, `donetsk`) do the same when the site has a schedule object with no days in it: 12 groups, today `unknown` (before: `groups: []`). Donetsk answers like this to requests from abroad.
- Volyn with nothing published returns its 12 groups with every day `unknown`, like the other regions (0.3.x returned `groups: []`). A caller that read an empty group list as "no schedule in force" has to read all-`unknown` days the same way.
- Zakarpattia no longer throws `unsupported` once a picture is published: the picture is read (see [Regions](#regions)).
- `capabilities.addressSearch` is now true for Chernihiv, Rivne, Cherkasy and 24 of the railway regions, and `capabilities.streetSearch` for Volyn too.

#### Cancelling

```ts
// stop as soon as your own deadline passes
const s = await outages.getSchedules('sumy', { fresh: true, signal: AbortSignal.timeout(20_000) })
```

`getSchedules`, `getSchedule` and `healthCheck` take a `signal`. When it aborts, the call rejects right away with the signal's reason (an `AbortError` by default, not an `OutageError`). The work that call started is stopped: its request in flight is cancelled, and nothing more is sent to the operator for it, no further groups, pages or retries. With a `Promise.race` cap of your own, pass a signal too, otherwise the losing call keeps running in the background.

Work shared with other callers keeps going for them: a call with a signal that is answered from the cache, or that waits for a session another call is opening, just stops waiting. Shared work is cancelled only when every caller waiting for it has given up. To keep one caller's cancellation from reaching others, a call with a signal doesn't share its own fetch through the cache while it runs (its result is cached when it arrives). Address search doesn't take a signal yet.

### Schedules published as pictures

Volyn and Zakarpattia publish the schedule only as a table image, and Khmelnytskyi did until it began posting text (its archive pictures are still read for a date that has no text; the text wins for its date). The SDK reads those itself: it decodes the PNG or JPEG, finds the grid and classifies each cell by colour, with no dependencies. When an operator posts a text announcement as an image under the same date, it is skipped. A colour the SDK doesn't know is reported as a `parse` error instead of being guessed.

Chernihiv publishes a poster of twelve cards, one per group, with the off times written out ("00:00 - 02:30"). The SDK reads those too, without OCR: it decodes the JPEG, finds the orange cards and matches each time line as a whole ("dd:dd-dd:dd") against a model of the poster font, built from hand-checked posters (`scripts/train-digits.ts`). The date comes from the poster header. A digit it isn't sure about, a time line it can't read or a date that isn't current gives a `parse` error, never a guess. The poster is read from two places: the site (full size, 1200 px wide) and the operator's Telegram channel (a 471 px copy, posted the evening before). Of the 36 hand-checked posters it reads 34 exactly and refuses 2 (one has a stray comma after a time, one has digits 9 px tall); none is misread. A poster in a new font, or with a typo in a time, is refused the same way until a few such posters are labelled and the model rebuilt. Changes the channel posts in words during the day ("З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2") are applied only where the wording is exact; otherwise the poster's times stay and `updatedAt` moves to the post.

### Address → group

```ts
await outages.findGroup('dnipro', { city: 'Днепр', street: 'проспект Яворницкого', house: '41' })
// { region: 'dnipro', group: '5.1', address: { city: 'м. Дніпро', street: 'просп. Дмитра Яворницького', house: '41' } }
```

People rarely know a street's official name, so matching is forgiving:

| they type                           | finds                                                          |
| ----------------------------------- | -------------------------------------------------------------- |
| `Хрищатик`, `крещатик`              | вул. Хрещатик (typos)                                          |
| `Адмиральская`, `Днепр`, `Киевская` | вул. Адміральська, м. Дніпро, вул. Київська (Russian spelling) |
| `Тараса Шевченка`                   | вул. Шевченка (the directory omits the first name)             |
| `Богдана Хмельницького`             | Хмельницького Б. (an initial)                                  |
| `Центральний проспект`              | пр. Центральний (type in any position)                         |
| `Шевч`                              | вул. Шевченка (still typing)                                   |

`findGroup` picks a name on its own only when one match is clearly the best. Otherwise it throws `not-found` with suggestions, for example when "Соборна" is both a вулиця and a площа, or two villages share a name (pass `district` then). Some buildings belong to more than one group; you get those in `otherGroups`.

Forgiving stops where another address begins. `findGroup` never takes a street whose name carries other numbers ("2-й провулок Миру" is not "Миру") or states another type ("вул. Миру" is not "просп. Миру"; a name without a type fits either), and never a house that differs by more than spelling: "12-А" is "12а", but "2/3" is not "23". Those are `not-found` with the closest names or numbers.

Where the operator's lookup also says which emergency queues an address is in, the match carries them in `emergency` (omitted when the operator says nothing):

```ts
await outages.findGroup('sumy', { city: 'Конотоп', street: 'провулок 2-Й Миру', house: '3' })
// { region: 'sumy', group: '2.2', …, emergency: { gav: ['6'], sgav: ['2'], achr: ['3'] } }
```

`gav` (ГАВ, the emergency schedule), `sgav` (СГАВ, the special one) and `achr` (АЧР, automatic load shedding by frequency) are numbered separately from ГПВ groups: "1" … "10", Lviv also "20", Mykolaiv also reserve queues "1(Р)". Values are distinct and sorted; a building with several accounts or connections can be in several. Regions that return them: Lviv, Ternopil, Zakarpattia (`chergGav`, `chergSgav`, `chergAchr`), Ivano-Frankivsk (ГАВ, СГАВ), Volyn ("Черга у ГАВ"), Khmelnytskyi (ГАВ, often empty), Sumy (ГАВ, АЧР, СГАВ), Poltava (ГАВ; "черга 0" counts as none), Mykolaiv (ГАВ, СГАВ) and Cherkasy (ГАВ, of the accounts asked). The others publish no address → ГАВ mapping (Kharkiv says it can't by law), or only one the SDK doesn't read: Chernihiv's online lookup is behind a captcha, and its ГАВ list is a separate PDF.

#### Is this house off now?

DTEK's sites keep a record per house of the outage there now, and it is the only place that shows emergency outages house by house. On the evening of 17.11.2026 ЦЕК had cancelled the region-wide emergency in Dnipro at 12:56, YASNO and every channel said the schedule applied, and still about one house in five of group 1.2 in the city was marked "екстрені відключення, без застосування графіку" until past midnight. `getHouseOutage` reads that record:

```ts
if (outages.region('dnipro').capabilities.houseOutage) {
  const o = await outages.getHouseOutage('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '32' })
  // { kind: 'emergency', scheduleApplies: false, reason: 'Екстренні відключення (Аварійне без застосування …)',
  //   from: '2026-11-16T10:40:00+02:00', to: '2026-11-18T00:25:00+02:00', groups: ['1.2'], … }
  // null: the operator lists no outage at the house
}
```

- `kind`: `emergency` (екстрені: the schedule doesn't apply to the house now, `scheduleApplies: false`), `scheduled` (the schedule's own outage, `true`), `repair` (аварійні ремонтні роботи, local damage), `planned` (планові ремонтні роботи) or `other`; `reason` is the operator's wording.
- `to` is DTEK's estimate of when power returns and moves; `updatedAt` is when the site last updated its records.
- Regions: `kyiv`, `dnipro` (DTEK's site, looked up by its own names, not YASNO's), `kyiv-region`, `odesa`, `donetsk`. Not `dnipro-cek`: a house the DTEK site marks as ЦЕК's is `not-found`.
- One request per street, cached for 5 minutes (`fresh: true` skips that). The sites are behind a bot check that blocks a client asking for a couple of hundred streets in a row, so ask for the houses people asked about, not for whole cities.

#### Autocomplete

```ts
await outages.prefetch('lviv') // optional: load the settlement list before the user types

const [city] = await outages.searchCities('lviv', 'Львов')
const streets = await outages.searchStreets('lviv', 'Городоцк', { city, limit: 10 })
// [{ id, name: 'Городоцька', score: 0.92 }, { name: 'Суха-Городоцька', score: 0.74 }, …]
const houses = await outages.searchHouses('lviv', streets[0])
const match = await outages.groupOf('lviv', houses[0], streets[0], city)
```

Results come back ranked, best first, each with a `score` from 0 to 1. Most operators publish a whole directory: the SDK downloads it once and searches it locally, so later keystrokes cost nothing. For operators whose server does the searching (YASNO streets, Sumy, Khmelnytskyi), a misspelled query is also sent as word fragments, so a typo still finds the street. `capabilities.streetSearch` tells you whether a region supports autocomplete. Ivano-Frankivsk only checks a complete address, so there `findGroup` works but autocomplete doesn't. Volyn has no settlement list (`searchCities` returns nothing): pass the settlement's exact name as text, `searchStreets('volyn', 'Вин', { city: { id: '', name: 'Луцьк' } })`, with at least three letters of the street; houses and the group then come from that answer.

Some lookups read lists rather than ask a service, and say so when the list doesn't settle an address:

- **Chernihiv**: the operator's address list (a PDF in force from 25.12.2025, no longer linked from the site but still served). Its groups matched the outage windows of 96% of 400 houses sampled in November 2026. It has no street types, so a number listed under "Миру" in two groups (вулиця and проспект) comes back with both (`otherGroups`). A house that isn't listed is `not-found`.
- **Rivne**: the operator's two PDF lists are free text ("частково", "167-195 (непарні)"). A house or a range the list names, or a street or settlement listed whole in one group, gets an answer; anything else is `not-found` with the candidate groups and the operator's wording. About a quarter of the rows can only ever be candidates.
- **Cherkasy**: the backend of the lookup on the operator's site, hosted with its customer cabinet. It answers per household account, so the SDK asks about up to 8 accounts of the house, one request at a time, and returns the most common group (`otherGroups` when the house is split). Account numbers are personal data: they stay in memory for that call only and are never returned, cached or put in an error. A house with no household accounts is `not-found`.
- **Укрзалізниця**: the address table on each region's page. A house under several groups returns all of them; in a run like "1-31" the odd numbers are answered and an even one is `not-found`, since the list doesn't say.
- **Kharkiv** has no lookup: the operator's needs a captcha.

### Emergency schedules (ГАВ / СГАВ)

Besides the hourly schedule (ГПВ), Ukrenergo can order emergency schedules: ГАВ, СГАВ, or "екстрені відключення" as DTEK calls them. They switch whole queues off within minutes, the published schedule usually stops applying, and they are announced only as posts. `getEmergency` reads those posts (and machine sources where there are some) and tells whether one is in force now:

```ts
if (outages.region('poltava').capabilities.emergency) {
  const s = await outages.getEmergency('poltava')
  // { state: 'active', kind: 'gav', since: '2026-11-09T09:44:00+02:00', queues: ['1','2','3','4','5'],
  //   queueCount: 5, scheduleApplies: null, area: null, inferred: false,
  //   message: { text: 'В області застосовано ГАВ! …', url: 'https://t.me/poltavaOE/4504', at: … }, source: 'telegram', … }
}
```

- `state`: `active` (in force now), `inactive` (cancelled, ended by the TTL, or nothing announced in the last 48 h), `unknown` (the newest post can't be read, or one of the region's sources failed, or its channel couldn't be read back as far as the TTL, while the others said nothing is in force). Nothing posted is never an error.
- Telling `inactive` apart: a cancellation always has `message` (the cancel post, or YASNO's own switch) and `endedAt`; a TTL end has `inferred: true`; "nothing announced" has `kind`, `message` and `endedAt` all null.
- `kind`: `gav`, `sgav`, or `emergency` when the operator doesn't say which (DTEK, "аварійні відключення").
- `since`: the time in the text ("з 10:35", "О 9:44", "з 08 год. 24 хв.", "станом на 22:02"), else the post time. `endedAt`: the cancellation, or the inferred end.
- `queues` / `queueCount`: the ГАВ queues off now, when the operator names them ("1-5 черга", "черги 3 та 4", "в повному обсязі" = all ten, "заміна черг: знеструмлюються 6-10, вмикаються 1-5"), or just how many ("10 черг"). Compare `queues` with `GroupMatch.emergency.gav` to tell a user whether their queue is off.
- `scheduleApplies`: ГПВ continues alongside ("Також продовжують діяти ГПВ") or is suspended ("графіки не діють"); null when not said.
- `area`: when only part of the region is affected ("м. Дніпро", "частині Голосієвського та Соломянського районів", "Ніжинському і Прилуцькому районах", "промислові споживачі"). Each area is its own episode: a cancel for "м. Павлоград" doesn't end Dnipro; a cancel for the whole region ends every area; a cancel naming an area when only a whole-region apply is on ("Шановні споживачі м. ДНІПРО: скасування" after "Шановні споживачі: діють") ends that one. Several areas on at once are listed in the order they started, with `queues` / `queueCount` null unless they all name the same.
- `inferred`: many operators never post a cancellation. An announcement nobody followed up on for 12 h (Sumy: 6 h) counts as ended at that point; a new post after such a gap starts a new episode. Ends read from Mykolaiv's outage feed are inferred too (its `finish_at` is often an estimate).
- A post that takes effect later ("О 19:00 - заміна черг" posted at 18:52, "з 18:00 будуть застосовуватися") changes the status only from that time.
- `previous`: pass the last status you stored: `getEmergency('kyiv', { previous })`. The client remembers which emergencies it saw through YASNO, so it can tell when YASNO stops showing one; after a restart `previous` stands in for that. It also dates an "UPD … скасовано" edit of an apply post (`endedAt` is the first reading that saw the edit, when `previous` was that post still in force), and while one source is down (t.me, YASNO, Mykolaiv's feed) an ongoing episode keeps the kind, queues, area, start and message it had instead of a bare "on".
- `source`: `telegram` (the operator's channel), `yasno`, `api` (Mykolaiv's outage feed) or `ukrenergo` (the national channel, a low-confidence fallback).

| region                          | source                                                                                                      | names queues           | posts cancellations                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------- |
| Kyiv, Dnipro (DTEK)             | YASNO `EmergencyShutdowns` + @dtek_ua                                                                       | no                     | Kyiv yes; Dnipro only via YASNO       |
| Kyiv region, Odesa, Donetsk     | @dtek_ua (posts by prefix: "Київщина:", "Одещина:" …)                                                       | no                     | mostly                                |
| Dnipro (ЦЕК)                    | @cek_info (YASNO 3/303 never flags it)                                                                      | no (ГАВ vs СГАВ only)  | yes                                   |
| Poltava                         | @poltavaOE                                                                                                  | ranges, counts         | yes, with times                       |
| Sumy                            | @SumyEnergo                                                                                                 | ranges, swaps          | never (6 h TTL)                       |
| Ivano-Frankivsk                 | @prykarpattyaoblenergo_official                                                                             | queue numbers, changes | yes                                   |
| Kirovohrad                      | @SvitloKropyvnytskyiMisto (the city's channel; the 21 district ones match)                                  | sometimes (СГАВ 1, 2)  | yes, with times                       |
| Mykolaiv                        | outage feed (`reason: "… ГАВ черга N"`) + @mk_energy_ua                                                     | yes, from the feed     | rows end when power returns           |
| Chernihiv, Lviv, Ternopil       | @chernigivoblenergo, @lvivoblenergo (edits "UPD … скасовані"), @ternopiloblenerho                           | counts                 | sometimes                             |
| Zhytomyr, Kharkiv, Zaporizhzhia | @ztoe_ua (edits "UPD"), @kharkivenergy, @Zaporizhzhyaoblenergo_news                                         | no                     | Zhytomyr yes; Kharkiv rarely          |
| Cherkasy, Khmelnytskyi          | @pat_cherkasyoblenergo, @khmelnytskoblenergo                                                                | no                     | never (TTL)                           |
| Chernivtsi                      | @oe_cv_ua, then @Ukrenergo                                                                                  | no                     | unverified (history deleted)          |
| Zakarpattia, Volyn, Rivne       | @Ukrenergo only, when it names the oblast                                                                   | no                     | rarely ("лише у Харківській області") |
| Укрзалізниця (`uz-*`)           | none (Kherson isn't covered at all): `capabilities.emergency` is false, `getEmergency` throws `unsupported` |                        |                                       |

Limits worth knowing: the posts are free text, read with patterns built from the operators' real wording; a new phrasing may read as nothing (`inactive`) or `unknown` until the patterns learn it. DTEK says "екстрені відключення" for ГАВ and "аварійні" for local damage after attacks; the latter is not reported. Neither is an emergency that goes on house by house after the region-wide one ended: DTEK's sites show that per address, through `getHouseOutage`. Telegram doesn't show when a post was edited, so an "UPD … скасовано" cancellation gets the post's own time as `endedAt`, unless `previous` shows the post was still in force at the last reading (then the time of this reading). Negated, conditional and future wording ("не скасовано", "скасовано не буде", "можуть бути скасовані", "після скасування") is never read as a cancellation, and "аварійні відключення не застосовуються" is ignored rather than read as one: a false "cancelled" is worse than a false "still on", which the TTL ends. A partial cancel ("скасовано 5 черг") ends the episode only when the remaining queues are known to be none; a partial or area-only cancel with nothing known before it is `unknown`, not "cancelled", until the TTL has passed since (then it is history: `inactive`, a partial one with the end inferred). Queue rotations replace rather than add up: "для 6-10 черг (1-5 ввімкнені)", "замість 1 та 2 черг будуть знеструмлені 7 та 8", and "знову введені ГАВ (для 6-10 черг)" while those are off. When ГАВ and СГАВ both ended, `kind` / `endedAt` are of the one that ended last. Conditions, purposes and the past ("у разі перевищення … будуть застосовані", "щоб уникнути застосування", "вчора було застосовано", "можуть бути застосовані") are not applies ("було застосовано" with a time of the last day, "о 07:35 … було застосовано ГАВ", is; so is "Щоб уникнути аварій, застосовано ГАВ"), and ГПВ being cancelled ("ГПВ скасовано, діють ГАВ") is not an emergency cancel. National wording reposted by an operator ("в окремих регіонах України запроваджені", "у більшості регіонів скасовано", "по всій країні") says nothing about its region unless the sentence names an oblast; neither does a post about the schedules as documents ("набрали чинності оновлені графіки (ГПВ, ГАВ та СГАВ)"). A post that can't be read while an emergency runs keeps it running. YASNO not showing `EmergencyShutdowns` never cancels a post by itself (its `updatedOn` moves with every schedule); it ends only an emergency YASNO itself showed earlier in the same client. Ukrenergo names oblasts only sometimes, so for Zakarpattia, Volyn and Rivne a quiet `inactive` means little; for Chernivtsi its posts are merged with the operator's channel by time. YASNO groups without a known `today.status` are a failed read, never an end. Results are cached like schedules (`fresh: true` skips the cache), and a channel shared by several regions is fetched once.

### Helpers

```ts
stateAt(days, at?)       // power state at an instant
intervalAt(days, at?)    // the interval covering an instant
nextOutage(days, from?, { kinds?, includeCurrent? })  // joins outages across midnight
minutesOf(day, kind?)    // total scheduled minutes
assessFreshness(schedule, opts?) // is it current? see "Freshness and failures"
normalizeGroup('Черга 3.1') // '3.1'
fuzzyScore('Хрищатик', 'вул. Хрещатик') // 0..1, the matcher behind the search
```

### Health check

```ts
const report = await outages.healthCheck({ address: true })
// { ok, degraded, stale, checkedAt,
//   regions: [{ region, status: 'ok' | 'stale' | 'empty' | 'error', latencyMs, groups, updatedAt, message,
//               freshness, sources, degraded, address }] }
```

- `empty`: the source works but publishes nothing right now (no groups, or every day `unknown` with no day cancelled by the operator). Often there are no outages then, but the SDK can't tell.
- `stale`: the data is out of date: its `freshness.state` is `stale` (see below), and `message` says why. For the health check that means the source is stuck on a past day, or hasn't changed for `staleAfterHours` (default 36) while today isn't published. Regions whose `updatedAt` is null can only be caught by the first.
- `error`: a network failure, a bot check (`blocked`), or a format change (`parse`).
- `degraded: true` next to any status but `error`: one of the region's channels failed and the others still gave a result. `message` names the channel; `sources` has the details.
- `freshness` is `assessFreshness` of what was fetched; `sources` is the schedule's `sources`.

`report.ok` is false when a region is `error` or an address lookup failed. `report.stale` and `report.degraded` say whether any region is stale or degraded; with `healthCheck({ strict: true })` those make `ok` false too. Other options: `regions`, `staleAfterHours`, `tomorrowExpectedAt` (passed to `assessFreshness`), `concurrency` (default 6), `signal`. The health check always asks the operator: it uses neither the cache nor `staleIfError`.

From the terminal: `npm run health` (`-- --address`, `-- --strict`, `-- --json`, `-- --skip a,b`, `-- kyiv lviv`). It prints one line per region with today's and tomorrow's coverage and the age of the data, and one line per entry of `sources`. Exit code 0: every source works; 1: a source or an address lookup is broken; 2 (only with `--strict`): nothing is broken, but something is stale or degraded.

The `Source health` workflow (`.github/workflows/health.yml`) runs it every 30 minutes with `--address`, skipping `donetsk` (always `blocked`). Only broken sources and failed lookups open an issue; stale or degraded regions don't. A failing check is repeated after two minutes; if it still fails, the workflow opens an issue titled `Source health: <failing regions>` (the first five, then "+N more") with the failing part of the report, reuses that issue while the failure lasts (a comment when the set of failing regions changes), and closes it with a comment on the first green run. Its runners are outside Ukraine, so a source that blocks foreign addresses shows up as `blocked`.

### Freshness and failures

A schedule that parses is not necessarily current: a site can keep showing yesterday's table, a channel can be down while another works, an app can hold an object for hours. The SDK reports each of these instead of passing old data off as new.

**Where a result came from.** Regions that read several official channels of the operator (site, API, Telegram channel) ask all of them and take each day from the one that published it last; a channel without a publication time loses to one with it, and a tie goes to the region's primary channel (the first entry). Such results carry `sources`, one entry per channel:

```ts
const s = await outages.getSchedules('chernihiv')
s.sources
// [{ id: 'site', url: 'https://…', ok: false, dates: [], updatedAt: null, error: { code: 'network', message: '…' } },
//  { id: 'telegram:@chernigivoblenergo', url: 'https://t.me/s/…', ok: true, dates: ['2026-11-17'], updatedAt: '2026-11-16T23:18:48+02:00' }]
```

`dates` are the days that channel supplied to the result, `updatedAt` is when the operator published them there. A channel that failed has `ok: false` and the `error`; the call still succeeds while any channel answers, and throws the first channel's error when none does. `disagrees: true` marks a channel that has a different schedule for a day another channel won (usually it is just behind). When an operator calls a day's schedule off in a post (Kharkiv, Cherkasy, Khmelnytskyi, Zaporizhzhia), that is a publication too: if it is the newest, the day's status is `unknown` for every group (neither the old hours nor `no-outages`), the channel that cancelled has the date in its `dates`, and a channel still showing the schedule gets `disagrees`. Regions with one channel have one entry or omit `sources`; the ids per region are listed under [Which channel has a day first](#which-channel-has-a-day-first). `getSchedule` passes `sources` on.

**Is it current?** `assessFreshness` is a pure function of a `RegionSchedule` or `GroupSchedule` and the clock:

```ts
import { assessFreshness } from 'ua-outages'

const schedule = await outages.getSchedule('lviv', '3.1', { staleIfError: true })
const f = assessFreshness(schedule, { tomorrowExpectedAt: '21:00' })
// { state: 'fresh' | 'stale' | 'unpublished', today: 'published' | 'missing', tomorrow: 'published' | 'missing',
//   coveredThrough: '2026-11-18', ageMinutes: 95, fetchedMinutesAgo: 0, issues: [{ code, message }] }
if (f.state === 'stale') showWarning(f.issues.map((i) => i.message).join('; '))
```

`state` is `stale` when any stale-making issue is present, else `unpublished` when nothing is published, else `fresh`. "Published" means a day whose status isn't `unknown`, or a day the operator called off: such a day is `unknown` for every group and is in the `dates` of the entry of `sources` that cancelled it (a cancellation is a publication, so it never makes a region `behind`). Days are Kyiv calendar days. `today` / `tomorrow` say whether any group has hours or a status for that day (`missing` for a cancelled one), `coveredThrough` is the newest published date, `ageMinutes` is the time since `updatedAt` (null when the source doesn't say), `fetchedMinutesAgo` the time since `fetchedAt`.

| issue code          | when                                                                                                                              | state         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `nothing-published` | No day of any group is published. Silence is not staleness, however long it lasts.                                                | `unpublished` |
| `behind`            | Something is published, but nothing for today or later: the source is stuck on a past day.                                        | `stale`       |
| `not-updated`       | Something is published, today isn't, and `updatedAt` is older than `staleAfterHours` (default 36).                                | `stale`       |
| `last-good`         | The result has `stale` set: it is the last good one, served instead of a failed fetch.                                            | `stale`       |
| `fetched-long-ago`  | `fetchedAt` is older than `fetchedStaleAfterMinutes` (default 30): you are holding an old object. Not listed next to `last-good`. | `stale`       |
| `source-failed`     | Some entry of `sources` has `ok: false`. The result is degraded, but as fresh as its data.                                        | unchanged     |
| `sources-disagree`  | Some entry of `sources` has `disagrees: true`.                                                                                    | unchanged     |
| `tomorrow-missing`  | `tomorrowExpectedAt` (Kyiv "HH:MM") is given, it is past that time, and tomorrow isn't published.                                 | unchanged     |
| `partial`           | Today is published for some groups and `unknown` (or absent) for others.                                                          | unchanged     |

An old `updatedAt` alone is fine while today is covered (a schedule published two days ahead). `fresh` doesn't promise today is there: when only a later day is published, `state` is `fresh` and `today` is `missing`. Right after Kyiv midnight a source that still shows only yesterday is `behind` until the operator publishes the new day. Options: `now`, `staleAfterHours`, `fetchedStaleAfterMinutes`, `tomorrowExpectedAt`.

**When the operator can't be read.** By default a failed fetch throws. With `staleIfError` the client answers with the region's last good result instead:

```ts
const outages = new OutageClient({ staleIfError: true }) // or per call; { maxAgeMs } to change the 6 h limit

const s = await outages.getSchedules('sumy', { previous: storedSchedule })
if (s.stale) {
  // { since: '2026-11-17T08:02:11+02:00', error: { code: 'network', message: 'Cannot reach www.soe.com.ua' } }
}
```

- It applies to `network`, `http`, `blocked` and `parse` errors. `unsupported`, `not-found` and a cancelled call are thrown as before.
- The result is a copy of the last successful one with `stale: { since, error }`; `since` is its `fetchedAt`, which stays as it was. `assessFreshness` reports it as `last-good`, state `stale`.
- The client remembers each region's last successful result. `previous` is one your app stored (across a restart, say); the one fetched later is used. A `previous` that isn't a valid schedule of that region is ignored.
- It is used only while at most `maxAgeMs` old (default 6 h); after that the error is thrown.
- A failure is never cached as a result. After answering with the last good result the client waits a minute (or `cacheTtlMs`, when shorter) before asking the operator again for calls with `staleIfError`; `fresh: true` asks at once, and calls without `staleIfError` always ask.
- `healthCheck` never uses it.

**Garbage is an error.** Before a result is cached or returned, the client checks it (`validateSchedule`, exported): `region` matches; `groups` are distinct and are exactly the keys of `schedules`; dates are real `YYYY-MM-DD` and distinct per group; statuses are the four known ones; every interval has ISO `from` < `to`, a kind of `off` or `maybe`, lies within its Kyiv day (ending at the next midnight is allowed, and the day is 23 or 25 hours long when the clocks change) and intervals are sorted and don't overlap; a `no-outages` day has no intervals; `updatedAt` is null or a time at most 24 h ahead of the clock. Anything else throws `OutageError('parse')` naming the region and the first violation, the same as a format change, and with `staleIfError` falls back the same way. Providers passed in `providers` are checked too.

### Errors

Everything throws `OutageError` with a `code`:

| code          | meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `network`     | DNS, timeout, connection reset                                                                             |
| `http`        | non-2xx from the operator                                                                                  |
| `blocked`     | a firewall or bot check answered instead of the operator                                                   |
| `parse`       | the response arrived, but its format changed, or what was read from it isn't a valid schedule              |
| `too-large`   | the response body is over `maxBodyBytes` and was not read (not retried, and not covered by `staleIfError`) |
| `unsupported` | unknown region, or the operator doesn't offer this                                                         |
| `not-found`   | unknown group, or the address couldn't be matched unambiguously                                            |

## How it works and its limits

Each region is a provider in `src/providers/` that reads the operator's own channels: a JSON API where one exists (YASNO, Mykolaiv, Sumy, …), otherwise the schedule page, the operator's news posts, the files it publishes (posters, PDF address lists) or its official Telegram channel, read from the public preview at `t.me/s/<channel>`. The channel is read where the operator publishes there first or only there: Chernihiv's site shows a day's poster on the morning of that day, its channel the evening before. No third-party aggregator, bot or relay channel is read. A provider with several channels merges them with `mergeSources` (`src/providers/sources.ts`): all are read at once, each day comes from the channel that published it last, and one failing doesn't fail the region. Nothing goes around captchas or bot protection. When an operator puts one in front of its data, the SDK reports `blocked` instead.

Notes on every source (endpoints, formats, quirks) are in [`docs/sources`](docs/sources), with the measurements behind the choice of channels.

Known limits:

- `donetsk` comes back `blocked`; `kyiv-region` works only while its `/ua/ajax` endpoint or its page stays unchallenged; `vinnytsia` has a schedule only with `unofficialSources: true`, from a community mirror; Kherson has no provider (see [Why some regions are missing](#why-some-regions-are-missing)).
- No address lookup for Kharkiv (captcha) and for the railway's Donetsk and Kherson pages (no list); no autocomplete for Ivano-Frankivsk; no settlement list for Volyn.
- Lookups from lists are as good as the lists: Chernihiv's is dated 25.12.2025 and has no street types, Rivne's are free text, Cherkasy's answer is a sample of the house's accounts (see [Autocomplete](#autocomplete)).
- A Chernihiv poster in a new font or with a typo in a time fails that channel with `parse` instead of being misread; the other channel still answers when it has the day.
- Text posts are read with patterns built from the operators' real wording. A schedule post that can't be read exactly fails its channel with `parse` (Kirovohrad, ЦЕК, Khmelnytskyi); a change in words that can't be applied leaves the earlier times (Chernihiv) or marks the groups it names `unknown` (ЦЕК).
- Telegram shows when a post was made, not when it was edited: an edited post keeps its first time.
- Not seen on live data yet, so unverified: a filled "tomorrow" slot of Sumy's E-Svitlo (until one is read, Sumy has today only); the picture Zakarpattia's API serves (if its layout differs from the channel's, that source reports `parse` and the channel still answers); how tomorrow appears in Zhytomyr's API (the reader takes whatever dates the rows carry).

Operators change their sites without warning. Every provider is tested against real saved responses (`test/fixtures`), and `healthCheck` catches changes in production. If a region breaks, please open an issue with the `npm run health` output.

## Development

```sh
npm install
npm test            # offline, on fixtures
npm run test:live   # hits real servers
npm run health -- --address
```

Adding a region: implement `Provider` (`src/providers/provider.ts`) with `getSchedules` and, if the operator has a lookup, the address methods. If the operator publishes on more than one channel, give each a reader and combine them with `mergeSources`. Save real responses as fixtures, write tests next to the others, and register the provider in `src/providers/index.ts`.

## Releasing

Bump the version and push the tag; the Release workflow (`.github/workflows/release.yml`) tests, builds and publishes it to npm with provenance:

```sh
npm version patch   # or minor / major
git push --follow-tags
```

## License

MIT
