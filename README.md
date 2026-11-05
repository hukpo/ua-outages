# ua-outages

TypeScript SDK for Ukrainian power outage schedules (графіки погодинних відключень).

- **Schedules straight from the grid operators.** No aggregators or Telegram channels in between: each region reads its oblenergo's own API or page.
- **Find a group by address.** Settlement, street and house in; the outage group ("черга") out.
- **One shape for every region.** Intervals in Kyiv time with explicit offsets, DST-safe.
- **Health check.** See in one call which sources still parse, so you notice when an operator changes its site.
- No runtime dependencies. Node 20+.

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

| id                | region                 | operator                                | schedule                                                                                                 | address lookup                                                                               | SDK reads                              | schedule   | address | notes                                                   |
| ----------------- | ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- | ------- | ------------------------------------------------------- |
| `kyiv`            | Київ                   | ДТЕК Київські електромережі (YASNO)     | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                                  | [static.yasno.ua](https://static.yasno.ua/kyiv/outages)                                      | app.yasno.ua API                       | ✅         | ✅      |                                                         |
| `dnipro`          | Дніпропетровська       | ДТЕК Дніпровські електромережі (YASNO)  | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    | app.yasno.ua API                       | ✅         | ✅      |                                                         |
| `dnipro-cek`      | Дніпропетровська (ЦЕК) | ЦЕК (YASNO)                             | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                                | [static.yasno.ua](https://static.yasno.ua/dnipro/outages)                                    | app.yasno.ua API                       | ✅         | ✅      |                                                         |
| `odesa`           | Одеська                | ДТЕК Одеські електромережі              | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                              | [dtek-oem.com.ua](https://www.dtek-oem.com.ua/ua/shutdowns)                                  | schedule page + /ua/ajax               | ✅         | ✅      |                                                         |
| `kyiv-region`     | Київська               | ДТЕК Київські регіональні електромережі | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                            | [dtek-krem.com.ua](https://www.dtek-krem.com.ua/ua/shutdowns)                                | schedule page                          | ⛔         | ⛔      | bot check                                               |
| `donetsk`         | Донецька               | ДТЕК Донецькі електромережі             | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                              | [dtek-dem.com.ua](https://www.dtek-dem.com.ua/ua/shutdowns)                                  | schedule page                          | ⛔         | ⛔      | bot check                                               |
| `lviv`            | Львівська              | Львівобленерго                          | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                                      | [poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)                                          | api.loe.lviv.ua, power-api.loe.lviv.ua | ✅         | ✅      |                                                         |
| `ternopil`        | Тернопільська          | Тернопільобленерго                      | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                                        | [poweron.toe.com.ua](https://poweron.toe.com.ua/)                                            | api-poweron.toe.com.ua                 | ✅         | ✅      | schedule read per group via a reference address         |
| `zakarpattia`     | Закарпатська           | Закарпаттяобленерго                     | [zakarpat.energy](https://zakarpat.energy/customers/break-in-electricity-supply/schedule/)               | [outage.zakarpat.energy](https://outage.zakarpat.energy/schedule_queues)                     | api-outage-zakarpat-energy.inneti.net  | image only | ✅      |                                                         |
| `ivano-frankivsk` | Івано-Франківська      | Прикарпаттяобленерго                    | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                              | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                  | be-svitlo.oe.if.ua                     | ✅         | ✅      | full address only, no autocomplete                      |
| `chernivtsi`      | Чернівецька            | Чернівціобленерго                       | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns/)                                                    | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns-search/)                                 | schedule page + district directories   | ✅         | ✅      | groups numbered 1–12                                    |
| `rivne`           | Рівненська             | Рівнеобленерго                          | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                                    | —                                                                                            | schedule page                          | ✅         | —       | addresses only in PDF                                   |
| `volyn`           | Волинська              | Волиньобленерго                         | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/) | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/) | lookup form                            | image only | ✅      | full address only, no autocomplete                      |
| `khmelnytskyi`    | Хмельницька            | Хмельницькобленерго                     | [hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)                                           | [hoe.com.ua](https://hoe.com.ua/shutdown/queue)                                              | hoe.com.ua lookup endpoints            | image only | ✅      |                                                         |
| `zhytomyr`        | Житомирська            | Житомиробленерго                        | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                              | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                  | schedule page + lookup form            | ✅         | ✅      |                                                         |
| `kirovohrad`      | Кіровоградська         | Кіровоградобленерго                     | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                                | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                    | kiroe.com.ua JSON                      | ✅ today   | ✅      |                                                         |
| `cherkasy`        | Черкаська              | Черкасиобленерго                        | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                                           | [cabinet.cherkasyoblenergo.com](https://cabinet.cherkasyoblenergo.com/)                      | news API                               | ✅         | —       | lookup server has a broken TLS chain                    |
| `sumy`            | Сумська                | Сумиобленерго                           | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                                 | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                     | soe.com.ua/next-api                    | ✅ today   | ✅      |                                                         |
| `poltava`         | Полтавська             | Полтаваобленерго                        | [poe.pl.ua](https://www.poe.pl.ua/disconnection/power-outages/)                                          | [poe.pl.ua](https://www.poe.pl.ua/)                                                          | poe.pl.ua/customs                      | ✅         | ✅      | buildings with several connections have no single group |
| `kharkiv`         | Харківська             | Харківобленерго                         | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk)                                                  | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk/gaoinfo)                              | Drupal JSON:API (news)                 | ✅         | —       | lookup needs a captcha                                  |
| `zaporizhzhia`    | Запорізька             | Запоріжжяобленерго                      | [zoe.com.ua](https://www.zoe.com.ua/outage/)                                                             | [Telegram bot](https://t.me/esozoebot)                                                       | news page                              | ✅         | —       | no web lookup                                           |
| `mykolaiv`        | Миколаївська           | Миколаївобленерго                       | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                            | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                | off.energy.mk.ua API                   | ✅         | ✅      |                                                         |

**Not covered**

| region       | operator          | schedule                                                                       | address lookup                                                 | why                                                                  |
| ------------ | ----------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Вінницька    | Вінницяобленерго  | [voe.com.ua](https://www.voe.com.ua/disconnection/detailed)                    | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/)  | schedule and lookup behind Cloudflare                                |
| Чернігівська | Чернігівобленерго | [interruptions.energy.cn.ua](https://interruptions.energy.cn.ua/interruptions) | [chernihivoblenergo.com.ua](https://chernihivoblenergo.com.ua) | schedule behind a captcha; image at /files/other/schedule_groups.jpg |
| Херсонська   | Херсонобленерго   | [ksoe.com.ua](https://ksoe.com.ua/)                                            | —                                                              | no public schedule                                                   |

Луганська область and Crimea are not covered. "today" means the operator publishes only the current day.
<!-- regions:end -->

"Address" means the SDK can turn an address into a group. Regions marked "image only" publish the schedule only as a picture; the SDK still finds the group, but `getSchedules` throws `unsupported`.

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
