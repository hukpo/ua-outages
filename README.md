# ua-outages

TypeScript SDK for Ukrainian power outage schedules (графіки погодинних відключень).

- **Schedules straight from the grid operators.** No aggregators or Telegram channels in between: each region reads its oblenergo's own API or page.
- **Find a group by address.** Settlement, street and house in; the outage group ("черга") out.
- **One shape for every region.** Intervals in Kyiv time with explicit offsets, DST-safe.
- **Health check.** See in one call which sources still parse, so you notice when an operator changes its site.
- No runtime dependencies. Node 20+.

**See it running: [hukpo.github.io/ua-outages](https://hukpo.github.io/ua-outages/).** A live map of Ukraine where every light is a house in one of the groups and goes dark when its group is scheduled off, plus a countdown for your group, calendar feeds, shared "power everywhere" windows for several addresses, and an archive. It is a static page rebuilt by GitHub Actions every 15 minutes from this SDK (`site/`, `.github/workflows/site.yml`).

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

| id                | region                  | operator                                | SDK reads                                                      | schedule      | address       | notes                                                                                                            | schedule                                                                                                 | address lookup                                                                               |
| ----------------- | ----------------------- | --------------------------------------- | -------------------------------------------------------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kyiv`            | Київ                    | ДТЕК Київські електромережі (YASNO)     | app.yasno.ua API                                               | ✅            | ✅            |                                                                                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                      |
| `dnipro`          | Дніпропетровська (ДТЕК) | ДТЕК Дніпровські електромережі (YASNO)  | app.yasno.ua API                                               | ✅            | ✅            |                                                                                                                  | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `dnipro-cek`      | Дніпропетровська (ЦЕК)  | ЦЕК (YASNO)                             | app.yasno.ua API                                               | ✅            | ✅            |                                                                                                                  | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    |
| `odesa`           | Одеська                 | ДТЕК Одеські електромережі              | schedule page + /ua/ajax                                       | ✅            | ✅            |                                                                                                                  | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                              | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                  |
| `kyiv-region`     | Київська                | ДТЕК Київські регіональні електромережі | schedule page + /ua/ajax (same provider as Odesa)              | ⚠️ code ready | ⚠️ code ready | the site answers automated clients with a bot check, so requests come back `blocked`; untested against live data | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                            | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                |
| `donetsk`         | Донецька                | ДТЕК Донецькі електромережі             | schedule page + /ua/ajax (same provider as Odesa)              | ⚠️ code ready | ⚠️ code ready | the site answers automated clients with a bot check, so requests come back `blocked`; untested against live data | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                              | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                  |
| `lviv`            | Львівська               | Львівобленерго                          | api.loe.lviv.ua, power-api.loe.lviv.ua                         | ✅            | ✅            |                                                                                                                  | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                                      | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                          |
| `ternopil`        | Тернопільська           | Тернопільобленерго                      | api-poweron.toe.com.ua                                         | ✅            | ✅            | schedule read per group via a reference address                                                                  | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                                        | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                            |
| `zakarpattia`     | Закарпатська            | Закарпаттяобленерго                     | api-outage-zakarpat-energy.inneti.net                          | ✅ / image    | ✅            | no outages while no picture is published; a published picture is reported as `unsupported`                       | [zakarpat.energy](https://zakarpat.energy/customers/break-in-electricity-supply/schedule/)               | [outage.zakarpat.energy](https://outage.zakarpat.energy/schedule_queues)                     |
| `ivano-frankivsk` | Івано-Франківська       | Прикарпаттяобленерго                    | be-svitlo.oe.if.ua                                             | ✅            | ✅            | full address only, no autocomplete                                                                               | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                              | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                  |
| `chernivtsi`      | Чернівецька             | Чернівціобленерго                       | schedule page + district directories                           | ✅            | ✅            | groups numbered 1–12                                                                                             | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns/)                                                    | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns-search/)                                 |
| `rivne`           | Рівненська              | Рівнеобленерго                          | schedule page                                                  | ✅            | —             | addresses only in PDF                                                                                            | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                                    | —                                                                                            |
| `volyn`           | Волинська               | Волиньобленерго                         | inneti archive API + table image (read by colour), lookup form | ✅ image      | ✅            | full address only, no autocomplete                                                                               | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/) | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/) |
| `khmelnytskyi`    | Хмельницька             | Хмельницькобленерго                     | archive page + table image (read by colour)                    | ✅ image      | ✅            |                                                                                                                  | [hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)                                           | [hoe.com.ua](https://hoe.com.ua/shutdown/queue)                                              |
| `chernihiv`       | Чернігівська            | Чернігівобленерго                       | schedule poster (times read from the picture)                  | ✅ image      | —             | the schedule API and the lookup need a captcha; the same schedule is published as a poster                       | [chernihivoblenergo.com.ua](https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg)           | [interruptions.energy.cn.ua](https://interruptions.energy.cn.ua/interruptions)               |
| `zhytomyr`        | Житомирська             | Житомиробленерго                        | schedule page + lookup form                                    | ✅            | ✅            |                                                                                                                  | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                              | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                  |
| `kirovohrad`      | Кіровоградська          | Кіровоградобленерго                     | kiroe.com.ua JSON                                              | ✅ today      | ✅            |                                                                                                                  | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                                | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                    |
| `cherkasy`        | Черкаська               | Черкасиобленерго                        | news API                                                       | ✅            | —             | lookup server has a broken TLS chain                                                                             | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                                           | [cabinet.cherkasyoblenergo.com](https://cabinet.cherkasyoblenergo.com/)                      |
| `sumy`            | Сумська                 | Сумиобленерго                           | soe.com.ua/next-api                                            | ✅ today      | ✅            |                                                                                                                  | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                                 | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                     |
| `poltava`         | Полтавська              | Полтаваобленерго                        | poe.pl.ua/customs                                              | ✅            | ✅            | buildings with several connections have no single group                                                          | [poe.pl.ua](https://www.poe.pl.ua/disconnection/power-outages/)                                          | [poe.pl.ua](https://www.poe.pl.ua/)                                                          |
| `kharkiv`         | Харківська              | Харківобленерго                         | Drupal JSON:API (news)                                         | ✅            | —             | lookup needs a captcha                                                                                           | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk)                                                  | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk/gaoinfo)                              |
| `zaporizhzhia`    | Запорізька              | Запоріжжяобленерго                      | news page                                                      | ✅            | —             | no web lookup                                                                                                    | [zoe.com.ua](https://www.zoe.com.ua/outage/)                                                             | [Telegram bot](https://t.me/esozoebot)                                                       |
| `mykolaiv`        | Миколаївська            | Миколаївобленерго                       | off.energy.mk.ua API                                           | ✅            | ✅            |                                                                                                                  | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                            | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                |

**АТ «Укрзалізниця»** is a distribution operator too: homes near stations and along the lines are wired to the railway's grid and get its own schedule, which differs from the oblenergo's. It has one region per oblast page on [uz.gov.ua](https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen/): `uz-kyiv`, `uz-kyiv-region`, `uz-dnipro`, … (`uz-<region id>`), and two branches each in Vinnytsia (`uz-vinnytsia`, `uz-vinnytsia-odesa`) and Sumy (`uz-sumy`, `uz-sumy-south`). Today's schedule only, read from the HTML table; a page with no table means no outages. The page also lists each group's addresses (no lookup yet).

**Not covered**

| region     | operator         | why                                   | schedule                                                    | address lookup                                                |
| ---------- | ---------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Вінницька  | Вінницяобленерго | schedule and lookup behind Cloudflare | [voe.com.ua](https://www.voe.com.ua/disconnection/detailed) | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/) |
| Херсонська | Херсонобленерго  | no public schedule                    | [ksoe.com.ua](https://ksoe.com.ua/)                         | —                                                             |

Луганська область and Crimea are not covered. "today" means the operator publishes only the current day. "⚠️ code ready" means the provider is implemented but the operator currently blocks automated requests. "image" means the schedule is read from the table picture the operator publishes.
<!-- regions:end -->

"Address" means the SDK can turn an address into a group. Zakarpattia publishes its schedule only as a picture: while none is published `getSchedules` returns no groups (no outages announced); once one is, it throws `unsupported` with the picture's address. Its address lookup works either way.

### Why some regions are missing

Kyiv region and Donetsk (DTEK sites) answer automated clients with a bot check, so these providers report `blocked`. Vinnytsia keeps its data behind a bot check, and Kherson publishes no schedule, so they have no provider. This SDK does not try to get around access controls.

If an operator grants you access (an allowlisted server, an API key, a data-sharing agreement), pass a `fetch` that applies it. Providers make every request through it:

```ts
const outages = new OutageClient({
  fetch: (url, init) => {
    // e.g. route DTEK requests through the server the operator allowlisted for you
    if (url.startsWith('https://www.dtek-krem.com.ua/'))
      return fetch(url.replace('https://www.dtek-krem.com.ua', ALLOWLISTED_PROXY), init)
    return fetch(url, init)
  },
})
```

In interactive tools (a CLI, a desktop app, a script you run yourself), `fetch` can also be backed by a visible browser window: the person using the tool passes the site's check themselves, and the requests then run in that same browser session. This SDK doesn't ship such a fetch and never solves checks on anyone's behalf. Expect the session to expire and the check to come back. It doesn't fit servers or cron jobs, where nobody is there to pass it.

The same option works for proxies, caching, logging and tests. When an operator opens its data publicly, as YASNO did for Kyiv and Dnipro, support follows; issues and contacts at operators are welcome.

## API

### `new OutageClient(options?)`

| option       | default                  |                                                                                                                          |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `cacheTtlMs` | `300000`                 | Reuse a region's schedule for this long. `0` turns caching off. Concurrent requests for one region share a single fetch. |
| `timeoutMs`  | `15000`                  | Per request.                                                                                                             |
| `retries`    | `1`                      | Extra attempts after a network error or a 5xx.                                                                           |
| `fetch`      | `globalThis.fetch`       | Bring your own (proxy, logging, tests).                                                                                  |
| `userAgent`  | `ua-outages (+repo url)` |                                                                                                                          |
| `providers`  | built-in                 | Replace or extend the regions.                                                                                           |

### Schedules

```ts
outages.regions() // RegionInfo[]: id, name, operator, capabilities
await outages.getSchedules('lviv') // every group: { groups, schedules: { '1.1': DaySchedule[] }, updatedAt }
await outages.getSchedule('lviv', '3.1') // one group; accepts "GPV3.1", "черга 3.1", …
```

A `DaySchedule` is `{ date: 'YYYY-MM-DD', status, intervals }`:

- `status` is `scheduled`, `no-outages`, `emergency` (the plan doesn't apply) or `unknown` (not published yet).
- `intervals` are sorted and merged: `{ from, to, kind }`, where `kind` is `off` or `maybe` ("можливе відключення", switching time).

`updatedAt` is when the operator last changed the schedule, when the source says so.

### Schedules published as pictures

Khmelnytskyi and Volyn publish the schedule only as a table image. The SDK reads those itself: it decodes the PNG, finds the grid and classifies each cell by colour, with no dependencies. When an operator posts a text announcement as an image under the same date, it is skipped. A colour the SDK doesn't know is reported as a `parse` error instead of being guessed.

Chernihiv publishes a poster of twelve cards, one per group, with the off times written out ("00:00 - 02:30"). The SDK reads those too, without OCR: it decodes the JPEG, finds the orange cards, cuts each time line into glyphs and matches the digits against a model of the poster font, trained on hand-checked posters (`scripts/train-digits.ts`). The date comes from the poster header. A digit it isn't sure about, a time line it can't read or a date that isn't current gives a `parse` error, never a guess. On 30 older posters the model hadn't seen (Telegram copies at 40% of the original size), it read 24 exactly and refused the other 6. The original on the site is full size.

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

#### Autocomplete

```ts
await outages.prefetch('lviv') // optional: load the settlement list before the user types

const [city] = await outages.searchCities('lviv', 'Львов')
const streets = await outages.searchStreets('lviv', 'Городоцк', { city, limit: 10 })
// [{ id, name: 'Городоцька', score: 0.92 }, { name: 'Суха-Городоцька', score: 0.74 }, …]
const houses = await outages.searchHouses('lviv', streets[0])
const match = await outages.groupOf('lviv', houses[0], streets[0], city)
```

Results come back ranked, best first, each with a `score` from 0 to 1. Most operators publish a whole directory: the SDK downloads it once and searches it locally, so later keystrokes cost nothing. For operators whose server does the searching (YASNO streets, Sumy, Khmelnytskyi), a misspelled query is also sent as word fragments, so a typo still finds the street. `capabilities.streetSearch` tells you whether a region supports autocomplete. Ivano-Frankivsk and Volyn only check a complete address, so there `findGroup` works but autocomplete doesn't.

### Helpers

```ts
stateAt(days, at?)       // power state at an instant
intervalAt(days, at?)    // the interval covering an instant
nextOutage(days, from?, { kinds?, includeCurrent? })  // joins outages across midnight
minutesOf(day, kind?)    // total scheduled minutes
normalizeGroup('Черга 3.1') // '3.1'
fuzzyScore('Хрищатик', 'вул. Хрещатик') // 0..1, the matcher behind the search
```

### Health check

```ts
const report = await outages.healthCheck({ address: true })
// { ok, checkedAt, regions: [{ region, status: 'ok' | 'stale' | 'empty' | 'error', latencyMs, groups, updatedAt, message, address }] }
```

- `empty`: the source works but publishes nothing right now. Usually it means there are no outages.
- `stale`: the schedule hasn't changed for `staleAfterHours` (default 72).
- `error`: a network failure, a bot check (`blocked`), or a format change (`parse`).

From the terminal: `npm run health` (`-- --address`, `-- --json`, `-- kyiv lviv`). The `Source health` workflow runs it daily.

### Errors

Everything throws `OutageError` with a `code`:

| code          | meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `network`     | DNS, timeout, connection reset                                  |
| `http`        | non-2xx from the operator                                       |
| `blocked`     | a firewall or bot check answered instead of the operator        |
| `parse`       | the response arrived, but its format changed                    |
| `unsupported` | unknown region, or the operator doesn't offer this              |
| `not-found`   | unknown group, or the address couldn't be matched unambiguously |

## How it works and its limits

Each region is a provider in `src/providers/` that reads the operator's own source: a JSON API where one exists (YASNO, Mykolaiv, Sumy, …), otherwise the schedule page or the operator's news posts. Nothing goes around captchas or bot protection. When an operator puts one in front of its data, the SDK reports `blocked` instead.

Notes on every source (endpoints, formats, quirks) are in [`docs/sources`](docs/sources).

Operators change their sites without warning. Every provider is tested against real saved responses (`test/fixtures`), and `healthCheck` catches changes in production. If a region breaks, please open an issue with the `npm run health` output.

## Development

```sh
npm install
npm test            # offline, on fixtures
npm run test:live   # hits real servers
npm run health -- --address
```

Adding a region: implement `Provider` (`src/providers/provider.ts`) with `getSchedules` and, if the operator has a lookup, the address methods. Save real responses as fixtures, write tests next to the others, and register the provider in `src/providers/index.ts`.

## License

MIT
