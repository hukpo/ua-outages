# ua-outages

TypeScript SDK for Ukrainian power outage schedules (графіки погодинних відключень).

- **Schedules straight from the grid operators.** No aggregators in between: each region reads the operator's own official channels (its API, its site, the files it publishes, its official Telegram channel), and where the operator publishes on several, all of them, taking each day from the one that has it first.
- **Find a group by address.** Settlement, street and house in; the outage group ("черга") out.
- **One shape for every region.** Intervals in Kyiv time with explicit offsets, DST-safe.
- **Health check.** See in one call which sources still parse, so you notice when an operator changes its site.
- **Stale data is detected, not served silently.** Every result says where it came from; `assessFreshness` tells whether it is current, and a failed fetch can fall back to the last good result, marked as such.
- **Posts and pictures read by AI you plug in.** What operators write for people (Telegram posts, news, schedule posters) goes through a text or image processor of your choice, every answer checked by the SDK. Ready-made ones for Claude and OpenAI; see [Posts and pictures](#posts-and-pictures-ai-processors).
- No runtime dependencies, no API key inside. Node 20+.

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

Regions whose operators publish only posts or pictures, and every ГАВ / СГАВ announcement, need a processor (see [Posts and pictures](#posts-and-pictures-ai-processors)):

```ts
import OpenAI from 'openai'
import { openaiImageProcessor, openaiTextProcessor } from 'ua-outages/openai'

const openai = new OpenAI() // your key, OPENAI_API_KEY
const outages = new OutageClient({
  textProcessor: openaiTextProcessor({ client: openai, model: 'gpt-6.1-terra' }),
  imageProcessor: openaiImageProcessor({ client: openai, model: 'gpt-6.1-terra' }),
})
```

Any other model goes through the Vercel AI SDK (`ua-outages/ai-sdk`) or TanStack AI (`ua-outages/tanstack-ai`).

## Regions

<!-- regions:start -->

| id                | region                                                                                            | operator                                                                                                                                                                        | SDK reads                                                                                                                                                                                                                    | schedule              | address        | notes                                                                                                                                                             | schedule page                                                                                            | lookup page                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kyiv`            | Київ                                                                                              | ДТЕК Київські електромережі (YASNO)                                                                                                                                             | app.yasno.ua API + the grid operator's site (dtek-kem.com.ua, /ua/ajax then the page)                                                                                                                                        | ✅                    | ✅             | the two carry the same schedule; either keeps the region up when the other fails                                                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                      |
| `dnipro`          | Дніпропетровська (ДТЕК)                                                                           | ДТЕК Дніпровські електромережі (YASNO)                                                                                                                                          | app.yasno.ua API + the grid operator's site (dtek-dnem.com.ua, /ua/ajax then the page)                                                                                                                                       | ✅                    | ✅             | the two carry the same schedule; either keeps the region up when the other fails                                                                                  | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `dnipro-cek`      | Дніпропетровська (ЦЕК)                                                                            | ЦЕК (YASNO)                                                                                                                                                                     | app.yasno.ua API + Telegram @cek_info                                                                                                                                                                                        | ✅                    | ✅             | the operator's channel is ahead of YASNO; addresses from YASNO                                                                                                    | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `odesa`           | Одеська                                                                                           | ДТЕК Одеські електромережі                                                                                                                                                      | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                                                                                               | ✅                    | ✅             |                                                                                                                                                                   | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                              | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                  |
| `kyiv-region`     | Київська                                                                                          | ДТЕК Київські регіональні електромережі                                                                                                                                         | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                                                                                               | ✅                    | ✅             | the schedule page is behind a bot check, so the answer comes from /ua/ajax                                                                                        | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                            | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                |
| `donetsk`         | Донецька                                                                                          | ДТЕК Донецькі електромережі                                                                                                                                                     | /ua/ajax (schedule, street list, houses), then the schedule page if that fails                                                                                                                                               | ⚠️ code ready         | ⚠️ code ready  | the site answers automated clients with a bot check on every route, so requests come back `blocked`; untested against live data                                   | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                              | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                  |
| `lviv`            | Львівська                                                                                         | Львівобленерго                                                                                                                                                                  | api.loe.lviv.ua, power-api.loe.lviv.ua                                                                                                                                                                                       | ✅                    | ✅             |                                                                                                                                                                   | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                                      | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                          |
| `ternopil`        | Тернопільська                                                                                     | Тернопільобленерго                                                                                                                                                              | api-poweron.toe.com.ua                                                                                                                                                                                                       | ✅                    | ✅             | schedule read per group via a reference address                                                                                                                   | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                                        | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                            |
| `zakarpattia`     | Закарпатська                                                                                      | Закарпаттяобленерго                                                                                                                                                             | Telegram @zakarpatenergyofficial + api-outage-zakarpat-energy.inneti.net: table picture (image processor)                                                                                                                    | ✅ image              | ✅             | groups `unknown` while no picture is published; a picture counts only under a channel post that names its date                                                    | [zakarpat.energy](https://zakarpat.energy/customers/break-in-electricity-supply/schedule/)               | [outage.zakarpat.energy](https://outage.zakarpat.energy/schedule_queues)                     |
| `ivano-frankivsk` | Івано-Франківська                                                                                 | Прикарпаттяобленерго                                                                                                                                                            | be-svitlo.oe.if.ua                                                                                                                                                                                                           | ✅                    | ✅             | full address only, no autocomplete                                                                                                                                | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                              | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                  |
| `chernivtsi`      | Чернівецька                                                                                       | Чернівціобленерго                                                                                                                                                               | schedule page + Telegram @oe_cv_ua (change times), district directories                                                                                                                                                      | ✅                    | ✅             | groups numbered 1–12                                                                                                                                              | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns/)                                                    | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns-search/)                                 |
| `rivne`           | Рівненська                                                                                        | Рівнеобленерго                                                                                                                                                                  | schedule page + the two address lists (PDF)                                                                                                                                                                                  | ✅                    | ✅ best effort | the lists are free text: `not-found` with the candidate groups when they don't settle an address                                                                  | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                                    | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                        |
| `volyn`           | Волинська                                                                                         | Волиньобленерго                                                                                                                                                                 | inneti archive API: table image (image processor), lookup form                                                                                                                                                               | ✅ image              | ✅             | autocomplete for streets and houses; the settlement is typed in full                                                                                              | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/) | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/) |
| `khmelnytskyi`    | Хмельницька                                                                                       | Хмельницькобленерго                                                                                                                                                             | schedule page + per-day news post + Telegram @khmelnytskoblenergo (text processor); archive table image (image processor) for dates without text                                                                             | ✅ text/image         | ✅             |                                                                                                                                                                   | [hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)                                           | [hoe.com.ua](https://hoe.com.ua/shutdown/queue)                                              |
| `chernihiv`       | Чернігівська                                                                                      | Чернігівобленерго                                                                                                                                                               | schedule poster from the site + Telegram @chernigivoblenergo (image + text processor), address list (PDF)                                                                                                                    | ✅ image              | ✅             | the schedule API and the online lookup need a captcha; the address list is dated 25.12.2025 and has no street types, so a house can come back with several groups | [chernihivoblenergo.com.ua](https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg)           | [interruptions.energy.cn.ua](https://interruptions.energy.cn.ua/interruptions)               |
| `zhytomyr`        | Житомирська                                                                                       | Житомиробленерго                                                                                                                                                                | ztoe.com.ua/gpv/api + schedule page, lookup form                                                                                                                                                                             | ✅                    | ✅             |                                                                                                                                                                   | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                              | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                  |
| `mykolaiv`        | the operator's outage feed (www.energy.mk.ua), by the address's house id, the last 7 days of rows | "Графік аварійних відключень \| ГАВ черга N" (`emergency`, seen on 03.11.2026), "Графік погодинних відключень" (`scheduled`), "Пошкодження …" (`repair`), PLAN rows (`planned`) | The words after "\|" are typed by dispatchers: a ГАВ row naming ГПВ or another oblenergo, or typed as an accident, is `other`. An outage that started more than 7 days ago is not seen. `to` is filled in when power is back |
| `sumy`            | the site's `by-house` list (soe.com.ua), one request per house                                    | the site's types: 3 / 6 ГАВ / СГАВ (`emergency`), 4 / 5 ГПВ, 1 / 7 планове, 2 / 9 аварійне; 8 САВН and 10 ГОП are `other`; `reason` is the site's short label ("Аварійне")      | Only types 1 and 2 have been seen live; ГАВ, СГАВ and ГПВ rows are unverified (the operator says a house's ГАВ outage shows "в момент відключення")                                                                          |
| `poltava`         | the status line of the address lookup (`fn_accident_message`), one request per house              | the ГПВ outage (`scheduled`, seen live), with start and expected end; any other wording is `other` with its text                                                                | No ГАВ wording has been seen, so a ГАВ outage comes back as `other` with the operator's words (it should name "(ГАВ)"), not as `emergency`. A building with several connections is `not-found`                               |
| `kirovohrad`      | Кіровоградська                                                                                    | Кіровоградобленерго                                                                                                                                                             | kiroe.com.ua JSON (today) + Telegram @SvitloKropyvnytskyiMisto (tomorrow, change times)                                                                                                                                      | ✅                    | ✅             | tomorrow has no "possible" half hours until it becomes today                                                                                                      | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                                | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                    |
| `cherkasy`        | Черкаська                                                                                         | Черкасиобленерго                                                                                                                                                                | news API + Telegram @pat_cherkasyoblenergo, lookup backend                                                                                                                                                                   | ✅                    | ✅             | the lookup asks the operator about a few of the house's accounts, one request at a time                                                                           | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                                           | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                               |
| `sumy`            | Сумська                                                                                           | Сумиобленерго                                                                                                                                                                   | soe.com.ua/next-api + sm.e-svitlo.com.ua (the operator's cabinet) + Telegram @SumyEnergo (pictures, image processor)                                                                                                         | ✅                    | ✅             | tomorrow from the channel's picture the evening before; without an image processor today only                                                                     | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                                 | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                     |
| `poltava`         | Полтавська                                                                                        | Полтаваобленерго                                                                                                                                                                | poe.pl.ua/customs                                                                                                                                                                                                            | ✅                    | ✅             | buildings with several connections have no single group                                                                                                           | [poe.pl.ua](https://www.poe.pl.ua/disconnection/power-outages/)                                          | [poe.pl.ua](https://www.poe.pl.ua/)                                                          |
| `kharkiv`         | Харківська                                                                                        | Харківобленерго                                                                                                                                                                 | Drupal JSON:API (news) + Telegram @kharkivenergy                                                                                                                                                                             | ✅                    | —              | lookup needs a captcha                                                                                                                                            | [oblenergo.kharkiv.ua](https://www.oblenergo.kharkiv.ua/uk)                                              | [oblenergo.kharkiv.ua](https://www.oblenergo.kharkiv.ua/uk/gaoinfo)                          |
| `zaporizhzhia`    | Запорізька                                                                                        | Запоріжжяобленерго                                                                                                                                                              | news page, Telegram @Zaporizhzhyaoblenergo_news as the fallback; address sheets (Google Sheets)                                                                                                                              | ✅                    | ✅             | lists per group                                                                                                                                                   | [zoe.com.ua](https://www.zoe.com.ua/outage/)                                                             | [Telegram bot](https://t.me/esozoebot)                                                       |
| `mykolaiv`        | Миколаївська                                                                                      | Миколаївобленерго                                                                                                                                                               | off.energy.mk.ua API                                                                                                                                                                                                         | ✅                    | ✅             |                                                                                                                                                                   | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                            | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                |
| `vinnytsia`       | Вінницька                                                                                         | Вінницяобленерго                                                                                                                                                                | no official source; with `unofficialSources: true` a community mirror ([vn-progr/gpv-voe-vinnytsia](https://github.com/vn-progr/gpv-voe-vinnytsia))                                                                          | ⚠️ opt-in, unofficial | ❌             | the operator gives the hours per queue only behind a bot check, a login or in its bots; see [Unofficial sources](#unofficial-sources)                             | [voe.com.ua](https://www.voe.com.ua/informatsiya-pro-cherhy-hrafika-pohodynnykh-vidklyuchen-hpv-1)       | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/)                                |

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

| option                 | default                  |                                                                                                                                                                                   |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheTtlMs`           | `300000`                 | Reuse a region's schedule for this long. `0` turns caching off. Concurrent requests for one region share a single fetch (except calls with a `signal`, see Cancelling).           |
| `timeoutMs`            | `15000`                  | Per request.                                                                                                                                                                      |
| `retries`              | `1`                      | Extra attempts after a network error or a 5xx. A bot-check page is never retried, whatever its status.                                                                            |
| `maxBodyBytes`         | `67108864`               | The largest response body read (64 MB). A larger one is not buffered: the request ends with `too-large`.                                                                          |
| `fetch`                | `globalThis.fetch`       | Bring your own (proxy, logging, tests).                                                                                                                                           |
| `userAgent`            | `ua-outages (+repo url)` |                                                                                                                                                                                   |
| `providers`            | built-in                 | Replace or extend the regions.                                                                                                                                                    |
| `staleIfError`         | `false`                  | Default for every schedule call: answer a failed fetch with the last good result, see [Freshness and failures](#freshness-and-failures).                                          |
| `textProcessor`        | none                     | Reads posts (Telegram, site news): schedules written as text, ГАВ / СГАВ announcements. See [Posts and pictures](#posts-and-pictures-ai-processors).                              |
| `imageProcessor`       | none                     | Reads schedule pictures (posters, tables).                                                                                                                                        |
| `processorCache`       | in memory, ~5000         | Where processor answers are kept, keyed by a hash of the processor and the whole input: each post and picture is parsed once. Pass a persistent store to keep them over restarts. |
| `onProcessed`          | none                     | Called for every post or picture handled, cached or not: tokens used, picture sizes, errors.                                                                                      |
| `processorConcurrency` | `4`                      | Processor calls in flight at once.                                                                                                                                                |

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

**Upgrading from 0.4.x:** 0.5.0 reads posts and pictures with AI processors you configure, and no longer with patterns or pixel readers (see [Posts and pictures](#posts-and-pictures-ai-processors) and `CHANGELOG.md`). Without `textProcessor` / `imageProcessor`, `zaporizhzhia`, `kharkiv`, `cherkasy`, `khmelnytskyi`, `lviv`, `volyn`, `chernihiv` and `zakarpattia` throw `OutageError('config')`, `kirovohrad`, `chernivtsi` and `dnipro-cek` answer from their structured source only, and `getEmergency` is `unknown` wherever the announcements are posts. Pass the processors to keep them working.

**Upgrading from 0.3.x:** what a caller can notice in 0.4.0:

- Results carry `sources` for most regions, and `stale` when served by `staleIfError`.
- Every provider result is validated before it is returned: a malformed one now throws `parse` (see [Freshness and failures](#freshness-and-failures)).
- `healthCheck`: the `staleAfterHours` default went from 72 to 36, and `stale` now follows `assessFreshness` (a source stuck on a past day is `stale` at once; an old `updatedAt` alone no longer is while today is published). Regions have `freshness`, `sources` and `degraded`; the report has `stale` and `degraded`.
- YASNO (`kyiv`, `dnipro`, `dnipro-cek`): a `WaitingForSchedule` day is `unknown` with no intervals (its preliminary slots used to be returned), and `EmergencyShutdowns` on a date after today is `unknown`, not `emergency`.
- More days: Kirovohrad returns tomorrow (from the operator's Telegram channel); Chernihiv returns tomorrow from the evening before; the railway pages return tomorrow's table when the page has one. Fewer where a source is behind: a railway table is filed under the date written above it, not under today, and Volyn's pictures dated before today are no longer read.
- `updatedAt` is null where the old value was a stamp the page regenerates every half hour: Rivne always; Zhytomyr when its API's change time can't be read (the page's stamp is never used); Chernivtsi when the operator's channel has no post about the day (or can't be read).
- 0.4.9: `getHouseStatus` says `on` only when every part the region has was read (a failed per-house or emergency read, or an `unknown` emergency, is `unknown`), reads only days published as `scheduled`, and during a ГАВ with unnamed queues lets the schedule decide only when the operator says it still applies. `getEmergency`: with several announcements in force (a ГАВ and a СГАВ, a region-wide one and a district's), `queues` / `queueCount` are given only when they all name the same; one list used to stand for all. `findGroup` and the other lookups: a street or settlement whose name matches the query exactly is picked over a near-duplicate ("вул. Велика Бердичівська" next to a misspelled "Бердичивська" was ambiguous). DTEK: a page whose street list is empty no longer fails the schedule; a new session keeps the cached house lists. Poltava's `getHouseOutage`: a status line past its expected end by half an hour, or not begun, is no outage now.
- 0.4.8: `getHouseStatus` (see [Is the power on at this house?](#is-the-power-on-at-this-house)) and `decideHouseStatus`; `healthCheck({ houseOutage: true })` and `npm run health -- --house-outage`. `report.ok` is now also false when a requested house outage check fails. Fixed: `getHouseOutage('kyiv', …)` failed with "specify a city": dtek-kem sends its street list without settlements, now read as the streets of м. Київ.
- 0.4.7: `getHouseOutage` in `mykolaiv`, `sumy` and `poltava`; see [Is this house off now?](#is-this-house-off-now) for their limits. `capabilities.houseOutage` is `true` for them now.
- 0.4.6: `getHouseOutage` in `lviv`, `ternopil`, `zakarpattia` and `zhytomyr`, from the operators' PowerOn lists; see [Is this house off now?](#is-this-house-off-now) for what each can tell. `capabilities.houseOutage` is `true` for them now.
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

### Posts and pictures: AI processors

Many operators publish for people, not programs: a Telegram post "ГПВ на 17 листопада: 1.1 08:00–12:00 …", a news article, a poster of twelve cards, an announcement "В 14:05 відміна дії графіку ГАВ". The SDK doesn't parse that with patterns or by reading pixels (it did up to 0.4, and every new phrasing or design broke it). It hands each post and each picture to a processor you configure, and checks every answer:

- **Text processor**: a post (its own text, the post it replies to, how many photos it has, the regions its channel covers) → typed events: `gpv` / `gav` / `sgav` / `emergency` / `other`, `start` / `cancel` / `change`, the time, the queues with their hours, the area, the day it is about (`PostInput` → `PostAnalysis`).
- **Image processor**: a picture (with its caption) → whether it is a schedule, its date, and each queue's `off` / `maybe` hours (`ImageInput` → `ImageReading`).
- **Checked, never guessed**: a time like "25:10", a date that doesn't exist or is days away from the post, a queue the region doesn't have, a schedule picture missing a queue — the whole answer is refused (`parse`). A post that can't be read never ends or extends anything: the schedule or emergency state stays as the posts before it make it, flagged (`sources[].unread`, `EmergencyStatus.unread`, with the post) so an app can warn that it may have changed, and the post is read again after 10 minutes.

Ready-made processors, each a separate entry point on structured outputs (JSON schemas). The libraries are optional peer dependencies: install the one you use. The SDK holds no key: you pass your own client or model.

| entry point              | for                                                                                     | peer dependency              |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------- |
| `ua-outages/openai`      | OpenAI's Responses API                                                                  | `openai`                     |
| `ua-outages/anthropic`   | Anthropic's Messages API                                                                | `@anthropic-ai/sdk`          |
| `ua-outages/ai-sdk`      | any model of the Vercel AI SDK: OpenAI, Anthropic, Google, Mistral, Ollama, AI Gateway… | `ai` (7+; it needs Node 22+) |
| `ua-outages/tanstack-ai` | any text adapter of TanStack AI: OpenAI, Anthropic, Gemini, Ollama…                     | `@tanstack/ai`               |

```ts
import OpenAI from 'openai'
import { openaiImageProcessor, openaiTextProcessor } from 'ua-outages/openai'

const openai = new OpenAI()
const outages = new OutageClient({
  textProcessor: openaiTextProcessor({ client: openai, model: 'gpt-6.1-terra' }),
  imageProcessor: openaiImageProcessor({ client: openai, model: 'gpt-6.1-terra' }),
})
```

```ts
// Vercel AI SDK: any provider's model, or an AI Gateway id ('openai/gpt-6.1-terra')
import { openai } from '@ai-sdk/openai'
import { aiSdkImageProcessor, aiSdkTextProcessor } from 'ua-outages/ai-sdk'

const outages = new OutageClient({
  textProcessor: aiSdkTextProcessor({ model: openai('gpt-6.1-terra') }),
  imageProcessor: aiSdkImageProcessor({ model: openai('gpt-6.1-terra') }),
})
```

```ts
// TanStack AI: any text adapter
import { openaiText } from '@tanstack/ai-openai'
import { tanstackImageProcessor, tanstackTextProcessor } from 'ua-outages/tanstack-ai'

const outages = new OutageClient({
  textProcessor: tanstackTextProcessor({ adapter: openaiText('gpt-6.1-terra') }),
  imageProcessor: tanstackImageProcessor({ adapter: openaiText('gpt-6.1-terra') }),
})
```

The two processors are set separately, so posts and pictures can go to different models. The picture defaults (1000 px, thin grids ×3) were measured with GPT-6.1 Terra; measure another model on the eval set before relying on it (`npm run eval`, see `eval/README.md`). Settings that change the answers (`providerOptions`, `modelOptions`) aren't part of the processor id by themselves: pass a `variant` so cached answers made without them aren't reused.

Any other model works too: a processor is an object with an `id` and `analyzePost(input)` / `readImage(input)` returning `{ value, usage? }`. `TEXT_SYSTEM`, `TEXT_SCHEMA`, `textPrompt()`, `IMAGE_SYSTEM`, `IMAGE_SCHEMA` and `imagePrompt()` are exported to build one on.

**Which model.** Measured on the eval set (`eval/`, 18.11.2026; text: 150 of the 784 posts, the same ones for every model; pictures: all 76):

| model             | posts read right            | pictures read right              | Zakarpattia's colour grids | $ per 1M tokens in / out |
| ----------------- | --------------------------- | -------------------------------- | -------------------------- | ------------------------ |
| GPT-6.1 Terra     | 150/150 (p17; twice at p13) | 75–76/76 (p18, 1000 px, thin ×3) | 9/9                        | 1 / 5                    |
| GPT-6.2 Sol       | —                           | 73/76 (p7, 800 px)               | 6/8                        | 2 / 10                   |
| GPT-6.2 Astra     | 135/150 (p7)                | 75–76/76 (p7, 800 px)            | 8/8                        | 8 / 40                   |
| Claude Sonnet 5.5 | 138/150 (p7)                | 68/76 (p7, 800 px)               | 3/8                        |                          |
| Claude Haiku 5.5  | 136/150 (p7)                | 65/76 (p7, 800 px)               | 1/8                        |                          |
| Claude Opus 5.5   | —                           | —                                | 2/8                        |                          |

GPT-6.1 Terra for both is the pick: as accurate on pictures as Astra at an eighth of the price, with `openaiImageProcessor`'s defaults (1000 px, Zakarpattia's 800×210 grids blown up ×3 pixel for pixel). Claude models misread the grids at any size, and a misread grid is real times in the wrong cells, which no check can catch. A case passes only when every field the SDK uses matches the label. The 0.4.8 regex readers, scored the same way on what the SDK makes of the same 150 posts (emergency announcements, and hours per queue where the schedule is taken from text), get 144/150. Text processor and image processor are set separately, so they can come from different vendors. Run `npm run eval` on your own choice of model before relying on it.

**Emergency posts read twice.** A wrong ГАВ state is the worst thing the SDK could show, so a post that starts, ends or changes one can be read by a second model as well, best another vendor's (`verifyProcessor`), and counts only when both agree on what the state machine gets: kind, action, time, queues, whether ГПВ applies, whether it is limited to an area. When they don't, a third (`judgeProcessor`) reads it and two of the three decide; with no majority the post is unclear and the state stands. `verifyPosts: 'all'` checks every post of an emergency channel, also those the first reader found nothing in.

```ts
const outages = new OutageClient({
  textProcessor: openaiTextProcessor({ client: openai, model: 'gpt-6.1-terra' }),
  verifyProcessor: anthropicTextProcessor({ client: anthropic, model: 'claude-haiku-5-5' }),
  judgeProcessor: anthropicTextProcessor({ client: anthropic, model: 'claude-opus-5-5' }),
  imageProcessor: openaiImageProcessor({ client: openai, model: 'gpt-6.1-terra' }),
})
```

On the eval's 37 posts that change an emergency state, Terra and Haiku read 3 differently (Haiku wrong each time); Opus as the judge settled all 3 right, Sonnet got one wrong and left one unclear (models of one vendor tend to share a mistake). The second reading costs ≈ $0.001 a post, for the few dozen such posts a day: about $1 a month; the judge is asked for a few a day.

**What it costs.** With GPT-6.1 Terra, standard tier: a post is ~2.5k tokens in, of which the ~2.4k of instructions and schema are the same every time and come from OpenAI's prompt cache at a twentieth of the price, and ~180 out (≈ $0.0015); a picture ~600 tokens of instructions plus the picture itself (~230–1000, ~1 token per 800 px) in and ~240 out (≈ $0.0024). The operators post ~130 posts and 15–25 schedule pictures a day: about $6 a month for the posts and $1–2 for the pictures. `onProcessed` reports each call's tokens and cached tokens.

**Parsed once.** Answers are cached by a hash of the processor id (vendor, model, prompt version) and the whole input. A post is analysed again only when its text changes (an edit); a picture is read once per content, however often it is reposted. Polling every region every 5 minutes then costs about what the operators post (an estimated ~130 posts and ~120 pictures a day across Ukraine), not what is polled. Failed answers are remembered for 10 min (asked again on the next poll after that), so a post a model can't read isn't paid for on every poll; failures of the AI API itself are not cached. Pass `processorCache` (`get` / `set`, values are JSON) to keep answers across restarts.

**Pictures are compacted first** (pure JS, no native libraries): scaled down to a long edge of 800 px by default (`maxLongEdge` on the processor; 1000 px for `openaiImageProcessor`: OpenAI bills ~1 token per 800 px, and Volyn's half-hour table needs 1000), flat margins trimmed. A thin picture, its short side under `minShortEdge` (400 px for `openaiImageProcessor`, off otherwise), is blown up pixel for pixel by the largest whole factor within 2400 px: Zakarpattia's 800×210 grid goes as 2400×630, where Terra reads every cell (at ×2 it still misplaced a boundary now and then). Only pictures that matter are read: a post's photos when its text says they are the schedule, and a bare photo only after a cheap check on a 256 px copy (`isSchedule`). `onProcessed` reports each picture's original and sent size and the tokens each call used.

**Without a processor** nothing wrong is reported. `RegionInfo.capabilities.requires` lists what a region's schedule needs:

| needs            | regions                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `textProcessor`  | `zaporizhzhia`, `kharkiv`, `cherkasy`, `dnipro-cek` (with YASNO), `kirovohrad` (with the site grid), `chernivtsi` (with the site) |
| `imageProcessor` | `volyn`                                                                                                                           |
| both             | `khmelnytskyi`, `chernihiv`, `zakarpattia`                                                                                        |

Without it, `getSchedules` throws `OutageError('config')`; where a structured source remains (`kirovohrad`, `chernivtsi`, `dnipro-cek`) that source answers and the post source is listed failed in `sources`. `getEmergency` is `state: 'unknown'` wherever the region's announcements are posts, unless YASNO (Kyiv, Dnipro) or Mykolaiv's feed answers.

**Evaluated on real posts.** `eval/` holds ~780 labelled posts from the 19 channels the SDK reads and ~75 pictures, including the ones the regex reader got wrong. `npm run eval -- --backend anthropic` (or `openai --model …`) scores a model against them; see `eval/README.md`.

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

Some operators keep a record per house of the outage there now, and it is the only place that shows emergency outages house by house. On the evening of 17.11.2026 ЦЕК had cancelled the region-wide emergency in Dnipro at 12:56, YASNO and every channel said the schedule applied, and still about one house in five of group 1.2 in the city was marked "екстрені відключення, без застосування графіку" until past midnight. `getHouseOutage` reads that record:

```ts
if (outages.region('dnipro').capabilities.houseOutage) {
  const o = await outages.getHouseOutage('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '32' })
  // { kind: 'emergency', scheduleApplies: false, reason: 'Екстренні відключення (Аварійне без застосування …)',
  //   from: '2026-11-16T10:40:00+02:00', to: '2026-11-18T00:25:00+02:00', groups: ['1.2'], … }
  // null: the operator lists no outage at the house
}
```

- `kind`: `emergency` (ГАВ / екстрені: the schedule doesn't apply to the house now, `scheduleApplies: false`), `scheduled` (the schedule's own outage, `true`), `repair` (аварійні: local damage, a drone strike), `planned` (планові роботи) or `other` (anything whose category is unclear); `reason` is the operator's wording. A category is `emergency` only where the operator itself labels it as ГАВ / СГАВ, never on a guess.
- `to` is the operator's estimate of when power returns and moves; `updatedAt` is when the site last updated its records (DTEK only, null elsewhere). `groups` may be empty where the source doesn't give them.
- Results are cached for 5 minutes (`fresh: true` skips that). Ask for the houses people asked about, not for whole cities: DTEK's sites are behind a bot check that blocks a client asking for a couple of hundred streets in a row, and the others rate-limit too.

Regions, and what each one's record can tell:

| region                                              | source                                                                                                          | per-house outage                                                                                                                                               | limits                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kyiv`, `dnipro`, `kyiv-region`, `odesa`, `donetsk` | DTEK's site (`getHomeNum`), one request per street                                                              | екстрені (`emergency`), the schedule's own, аварійні ремонтні, планові                                                                                         | `kyiv` and `dnipro` are looked up on the DTEK site by its own names, not YASNO's. Not `dnipro-cek`: a house the DTEK site marks as ЦЕК's is `not-found`                                                                                                                                                                                                                                    |
| `lviv`, `ternopil`, `zakarpattia`                   | the PowerOn list «Чому немає світла?» (`pw_accidents`), one request per street, by the address lookup's own ids | `switchSubReason` 1 / 3 → ГАВ / СГАВ (`emergency`), 2 → ГПВ (`scheduled`); else `typeOff` 0 планове, 1 аварійне (`repair`), 2 оперативні перемикання (`other`) | ГАВ / СГАВ rows have not been seen live (unverified); Lviv and Zakarpattia log no ГПВ rows. A row counts only from its start to half an hour past its planned end: the lists keep old rows (Zakarpattia's go back to 2025), so an outage that runs past its estimate drops out then. Ternopil's list was empty while this was written (its times are taken as Kyiv wall clock, unverified) |
| `zhytomyr`                                          | the same list on the operator's PowerOn copy (ztoe-poweron.inneti.net)                                          | as above; ГПВ slots are listed, with their group                                                                                                               | The copy has its own address directory: the settlement is needed (searched by name on the server), and it has no list of a street's houses, so the house is taken as typed: a misspelled number gives `null`, not `not-found`. `groups` is empty except for ГПВ rows                                                                                                                       |

Not supported, and why: Volyn (its PowerOn list `pw_accidents` is empty, also when re-checked on 17.11.2026); Khmelnytskyi (its per-address list said "no registered outage" for a house during its group's ГПВ slot, and no outage has been seen in it to read); Kirovohrad (its per-house message says which schedule applies, "Застосування ГПВ", not whether the house is off, and gives no times); Chernihiv, Kharkiv and Vinnytsia (lookups behind a captcha or Cloudflare); Chernivtsi, Rivne, Zaporizhzhia, Kherson, the railway and ЦЕК (no per-address status); Cherkasy (looked up by accounts, not addresses, and ГАВ can't be told from аварійні).

#### Is the power on at this house?

`getHouseStatus` puts the address's group, the house's own record, the region's ГАВ status and the schedule together into one answer, the one a site or a bot shows:

```ts
const s = await outages.getHouseStatus('dnipro', { city: 'Дніпро', street: 'вул. Бетховена', house: '32' })
// { state: 'off', basis: 'house-outage', until: '2026-11-18T00:25:00+02:00', groups: ['1.2'],
//   scheduled: null, nextOutage: { from: '2026-11-18T08:00:00+02:00', … },
//   houseOutage: { kind: 'emergency', … }, emergency: { state: 'inactive', … }, gaps: [], … }
```

- `state`: `off`, `maybe`, `on` or `unknown`; `basis` says what decided it: `house-outage`, `emergency`, `schedule` or `none`; `until` is when power is expected back (null when not known).
- The order: the operator's record of the house wins (the Dnipro case: the region back on the schedule, the house still off). Then a ГАВ / СГАВ in force: `off` when the operator names the queues that are off and the house's queue (from `findGroup`) is among them; `maybe` when that can't be told, unless the operator says the schedule still applies alongside (`scheduleApplies: true`) and it has the house off. A ГАВ whose named queues leave the house out falls through to the schedule, or is `on` when the operator suspended the schedule. Then the schedule of the house's first group, read only from days the operator published as `scheduled` (today and tomorrow): an outage now is `off` until the end of the run of outages (past midnight when tomorrow is published), a "possible" half hour `maybe`, a day marked emergency `maybe`, a `no-outages` day `on`, today not published `unknown`.
- `on` is said only when today's schedule is published and has no outage now, no ГАВ hits the house, and every part the region has was read: a per-house record or emergency feed that failed, or an emergency status that is `unknown`, makes it `unknown` (a read that failed is not one that found nothing). A local outage in a region without per-house records can't be seen: such a region has a `house-outage` entry in `gaps` with code `unsupported`. The schedule is never a last good copy (`staleIfError` is off for this call): a failed read is a `schedule` gap.
- `gaps` lists every part that couldn't be used (`address`, `house-outage`, `emergency`, `schedule`) with its error code; the answer is made from the rest. It throws `not-found` when no lookup finds the address (as `findGroup`, including a house the operator lists without a group, with no per-house record to fall back on), rethrows what isn't an `OutageError` (a bug), and rejects when cancelled.
- It makes the calls `findGroup`, `getHouseOutage`, `getEmergency` and `getSchedules` make, with their caches (`fresh: true` skips them, the address lookup included); in DTEK's YASNO regions the schedule channel and the house record share one session of the site. `decideHouseStatus` is the decision alone, for callers that read the parts themselves.

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

Besides the hourly schedule (ГПВ), Ukrenergo can order emergency schedules: ГАВ, СГАВ, or "екстрені відключення" as DTEK calls them. They switch whole queues off within minutes, the published schedule usually stops applying, and they are announced only as posts. `getEmergency` reads those posts with the text processor (and machine sources where there are some) and tells whether one is in force now:

```ts
if (outages.region('poltava').capabilities.emergency) {
  const s = await outages.getEmergency('poltava')
  // { state: 'active', kind: 'gav', since: '2026-11-09T09:44:00+02:00', queues: ['1','2','3','4','5'],
  //   queueCount: 5, scheduleApplies: null, area: null, inferred: false,
  //   message: { text: 'В області застосовано ГАВ! …', url: 'https://t.me/poltavaOE/4504', at: … }, source: 'telegram', … }
}
```

- `state`: `active` (in force now), `inactive` (cancelled, ended by the TTL, or nothing announced in the last 48 h), `unknown` (the newest post can't be read, no text processor is configured, or one of the region's sources failed, or its channel couldn't be read back as far as the TTL, while the others said nothing is in force). Nothing posted is never an error.
- Telling `inactive` apart: a cancellation always has `message` (the cancel post, or YASNO's own switch) and `endedAt`; a TTL end has `inferred: true`; "nothing announced" has `kind`, `message` and `endedAt` all null.
- `kind`: `gav`, `sgav`, or `emergency` when the operator doesn't say which (DTEK, "аварійні відключення").
- `since`: the time the post gives ("з 10:35", "О 9:44", "В 14:05 відміна"), else the post time. `endedAt`: the cancellation, or the inferred end.
- `queues` / `queueCount`: the ГАВ queues off now, when the operator names them ("1-5 черга", "черги 3 та 4", "в повному обсязі" = all ten, "заміна черг: знеструмлюються 6-10, вмикаються 1-5"), or just how many ("10 черг"). Compare `queues` with `GroupMatch.emergency.gav` to tell a user whether their queue is off.
- `scheduleApplies`: ГПВ continues alongside ("Також продовжують діяти ГПВ") or is suspended ("графіки не діють"); null when not said.
- `area`: when only part of the region is affected, as the operator wrote it ("м. ДНІПРО", "частині Голосієвського та Соломянського районів", "Ніжинському і Прилуцькому районах", "промислові споживачі"). Each area is its own episode: a cancel for "м. Павлоград" doesn't end Dnipro; a cancel for the whole region ends every area; a cancel naming an area when only a whole-region apply is on ("Шановні споживачі м. ДНІПРО: скасування" after "Шановні споживачі: діють") ends that one. Several areas on at once are listed in the order they started, with `queues` / `queueCount` null unless they all name the same.
- `inferred`: many operators never post a cancellation. An announcement nobody followed up on for 12 h counts as ended at that point (Sumy: at the end of its day, see below); a new post after such a gap starts a new episode. Ends read from Mykolaiv's outage feed are inferred too (its `finish_at` is often an estimate).
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
| Zakarpattia                     | @zakarpatenergyofficial, then @Ukrenergo                                                                    | no                     | unverified                            |
| Volyn, Rivne                    | @Ukrenergo only, when it names the oblast                                                                   | no                     | rarely ("лише у Харківській області") |
| Укрзалізниця (`uz-*`)           | none (Kherson isn't covered at all): `capabilities.emergency` is false, `getEmergency` throws `unsupported` |                        |                                       |

Limits worth knowing: what a post means is the text processor's reading, checked for real times, dates and queues but not for sense; the eval set (`eval/`) measures how often a model gets it right. A post whose answer fails the check is `unknown` while it is the newest word, and never ends an episode. DTEK says "екстрені відключення" for ГАВ and "аварійні" for local damage after attacks; the latter is not reported. Neither is an emergency that goes on house by house after the region-wide one ended: DTEK's sites show that per address, through `getHouseOutage`. Telegram doesn't show when a post was edited, so an "UPD … скасовано" cancellation gets the post's own time as `endedAt`, unless `previous` shows the post was still in force at the last reading (then the time of this reading). A false "cancelled" is worse than a false "still on", which the TTL ends. A partial cancel ("скасовано 5 черг") ends the episode only when the remaining queues are known to be none; a partial or area-only cancel with nothing known before it is `unknown`, not "cancelled", until the TTL has passed since (then it is history: `inactive`, a partial one with the end inferred). Queue rotations replace rather than add up: "для 6-10 черг (1-5 ввімкнені)", "замість 1 та 2 черг будуть знеструмлені 7 та 8", and "знову введені ГАВ (для 6-10 черг)" while those are off. When ГАВ and СГАВ both ended, `kind` / `endedAt` are of the one that ended last. A post that can't be read while an emergency runs keeps it running. YASNO not showing `EmergencyShutdowns` never cancels a post by itself (its `updatedOn` moves with every schedule); it ends only an emergency YASNO itself showed earlier in the same client. Ukrenergo names oblasts only sometimes, so for Zakarpattia, Volyn and Rivne a quiet `inactive` means little; for Chernivtsi its posts are merged with the operator's channel by time. YASNO groups without a known `today.status` are a failed read, never an end. Results are cached like schedules (`fresh: true` skips the cache), and a channel shared by several regions is fetched once.

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
const report = await outages.healthCheck({ address: true, houseOutage: true })
// { ok, degraded, stale, checkedAt,
//   regions: [{ region, status: 'ok' | 'stale' | 'empty' | 'error', latencyMs, groups, updatedAt, message,
//               freshness, sources, degraded, address, houseOutage }] }
```

- `empty`: the source works but publishes nothing right now (no groups, or every day `unknown` with no day cancelled by the operator). Often there are no outages then, but the SDK can't tell.
- `stale`: the data is out of date: its `freshness.state` is `stale` (see below), and `message` says why. For the health check that means the source is stuck on a past day, or hasn't changed for `staleAfterHours` (default 36) while today isn't published. Regions whose `updatedAt` is null can only be caught by the first.
- `error`: a network failure, a bot check (`blocked`), or a format change (`parse`).
- `degraded: true` next to any status but `error`: one of the region's channels failed and the others still gave a result. `message` names the channel; `sources` has the details.
- `freshness` is `assessFreshness` of what was fetched; `sources` is the schedule's `sources`.
- `houseOutage` (with `houseOutage: true`, in regions with `capabilities.houseOutage`): `getHouseOutage` of the sample address, `{ ok: true, kind }` (`kind: null` when nothing is listed there, which is fine) or `{ ok: false, message }`. It catches a per-house source that changed or went quiet. It asks one or two more requests per region, and DTEK's sites are behind a bot check: run it every few hours, not every few minutes.

`report.ok` is false when a region is `error`, or an address lookup or house outage check failed. `report.stale` and `report.degraded` say whether any region is stale or degraded; with `healthCheck({ strict: true })` those make `ok` false too. Other options: `regions`, `staleAfterHours`, `tomorrowExpectedAt` (passed to `assessFreshness`), `concurrency` (default 6), `signal`. The health check always asks the operator: it uses neither the cache nor `staleIfError`.

From the terminal: `npm run health` (`-- --address`, `-- --house-outage`, `-- --strict`, `-- --json`, `-- --skip a,b`, `-- kyiv lviv`). It prints one line per region with today's and tomorrow's coverage and the age of the data, and one line per entry of `sources`. Exit code 0: every source works; 1: a source, an address lookup or a house outage check is broken; 2 (only with `--strict`): nothing is broken, but something is stale or degraded.

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

Each region is a provider in `src/providers/` that reads the operator's own channels: a JSON API where one exists (YASNO, Mykolaiv, Sumy, …), otherwise the schedule page, the operator's news posts, the files it publishes (posters, PDF address lists) or its official Telegram channel, read from the public preview at `t.me/s/<channel>`. Structured sources (JSON, HTML tables, PDF tables) are read by code; free text and pictures by the processors (`src/ai/`). The channel is read where the operator publishes there first or only there: Chernihiv's site shows a day's poster on the morning of that day, its channel the evening before. No third-party aggregator, bot or relay channel is read. A provider with several channels merges them with `mergeSources` (`src/providers/sources.ts`): all are read at once, each day comes from the channel that published it last, and one failing doesn't fail the region. Nothing goes around captchas or bot protection. When an operator puts one in front of its data, the SDK reports `blocked` instead.

Notes on every source (endpoints, formats, quirks) are in [`docs/sources`](docs/sources), with the measurements behind the choice of channels.

Known limits:

- `donetsk` comes back `blocked`; `kyiv-region` works only while its `/ua/ajax` endpoint or its page stays unchallenged; `vinnytsia` has a schedule only with `unofficialSources: true`, from a community mirror; Kherson has no provider (see [Why some regions are missing](#why-some-regions-are-missing)).
- No address lookup for Kharkiv (captcha) and for the railway's Donetsk and Kherson pages (no list); no autocomplete for Ivano-Frankivsk; no settlement list for Volyn.
- Lookups from lists are as good as the lists: Chernihiv's is dated 25.12.2025 and has no street types, Rivne's are free text, Cherkasy's answer is a sample of the house's accounts (see [Autocomplete](#autocomplete)).
- Posts and pictures are read by the processor you configure; the SDK checks each answer (real times, dates, the region's queues) but can't check its sense. A recent schedule post or picture whose answer fails the check fails its channel with `parse`; a correction in words without both ends of an outage marks the groups it names `unknown` until the next schedule.
- Telegram shows when a post was made, not when it was edited: an edited post keeps its first time.
- Not seen on live data yet, so unverified: a filled "tomorrow" slot of Sumy's E-Svitlo (until one is read, Sumy has today only); the picture Zakarpattia's API serves (if its layout differs from the channel's, that source reports `parse` and the channel still answers); how tomorrow appears in Zhytomyr's API (the reader takes whatever dates the rows carry).

Operators change their sites without warning. Every provider is tested against real saved responses (`test/fixtures`), and `healthCheck` catches changes in production. If a region breaks, please open an issue with the `npm run health` output.

## Development

```sh
npm install
npm test            # offline, on fixtures
npm run test:live   # hits real servers
npm run health -- --address
npm run eval -- --backend claude-cli   # the eval set on a model (see eval/README.md)
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
