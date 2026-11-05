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

| id                | region                         | source                                       | schedule   | address | notes                                                     |
| ----------------- | ------------------------------ | -------------------------------------------- | ---------- | ------- | --------------------------------------------------------- |
| `kyiv`            | Київ                           | ДТЕК Київські електромережі via YASNO API    | ✅         | ✅      |                                                           |
| `dnipro`          | Дніпропетровська область       | ДТЕК Дніпровські електромережі via YASNO API | ✅         | ✅      |                                                           |
| `dnipro-cek`      | Дніпропетровська область (ЦЕК) | ЦЕК via YASNO API                            | ✅         | ✅      |                                                           |
| `odesa`           | Одеська область                | ДТЕК Одеські електромережі, schedule page    | ✅         | ✅      |                                                           |
| `kyiv-region`     | Київська область               | ДТЕК Київські регіональні електромережі      | ⛔         | ⛔      | site answers with a bot check                             |
| `donetsk`         | Донецька область               | ДТЕК Донецькі електромережі                  | ⛔         | ⛔      | site answers with a bot check                             |
| `lviv`            | Львівська область              | Львівобленерго API                           | ✅         | ✅      |                                                           |
| `ternopil`        | Тернопільська область          | Тернопільобленерго API                       | ✅         | ✅      | schedule is read per group via one reference address each |
| `zakarpattia`     | Закарпатська область           | Закарпаттяобленерго API                      | image only | ✅      |                                                           |
| `ivano-frankivsk` | Івано-Франківська область      | Прикарпаттяобленерго API                     | ✅         | ✅      | free-text address lookup                                  |
| `chernivtsi`      | Чернівецька область            | Чернівціобленерго, schedule page             | ✅         | ✅      | groups are numbered 1–12                                  |
| `rivne`           | Рівненська область             | Рівнеобленерго, schedule page                | ✅         | —       | address list is PDF only                                  |
| `volyn`           | Волинська область              | Волиньобленерго                              | image only | ✅      |                                                           |
| `khmelnytskyi`    | Хмельницька область            | Хмельницькобленерго                          | image only | ✅      |                                                           |
| `zhytomyr`        | Житомирська область            | Житомиробленерго, schedule page              | ✅         | ✅      |                                                           |
| `kirovohrad`      | Кіровоградська область         | Кіровоградобленерго API                      | ✅ today   | ✅      |                                                           |
| `cherkasy`        | Черкаська область              | Черкасиобленерго news API                    | ✅         | —       | lookup server has a broken TLS chain                      |
| `sumy`            | Сумська область                | Сумиобленерго API                            | ✅ today   | ✅      |                                                           |
| `poltava`         | Полтавська область             | Полтаваобленерго, schedule fragment          | ✅         | ✅      | buildings with several connections have no single group   |
| `kharkiv`         | Харківська область             | Харківобленерго news API                     | ✅         | —       | lookup needs a captcha                                    |
| `zaporizhzhia`    | Запорізька область             | Запоріжжяобленерго news page                 | ✅         | —       | no lookup published                                       |
| `mykolaiv`        | Миколаївська область           | Миколаївобленерго API                        | ✅         | ✅      |                                                           |

Not covered: Вінницька and Чернігівська (schedule and lookup behind a captcha), Херсонська (no public schedule), Луганська, АР Крим. "today" means the operator publishes only the current day.
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
await outages.findGroup('dnipro', { city: 'Дніпро', street: 'просп. Дмитра Яворницького', house: '41' })
// { region: 'dnipro', group: '5.1', address: { city, street, house } }
```

Names are matched loosely: street types in any position, any apostrophe, latin/cyrillic look-alikes in house numbers ("12a" = "12А"). When the input fits several streets equally ("Яворницького" is both a вулиця and a проспект), `findGroup` throws `not-found` and lists the candidates; include the street type to disambiguate. Some buildings belong to more than one group; you get them in `otherGroups`.

For an autocomplete UI, use the steps directly:

```ts
const [city] = await outages.searchCities('dnipro', 'Дніпро')
const streets = await outages.searchStreets('dnipro', 'Яворн', { city })
const houses = await outages.searchHouses('dnipro', streets[0])
const match = await outages.groupOf('dnipro', houses[0], streets[0], city)
```

### Helpers

```ts
stateAt(days, at?)       // power state at an instant
intervalAt(days, at?)    // the interval covering an instant
nextOutage(days, from?, { kinds?, includeCurrent? })  // joins outages across midnight
minutesOf(day, kind?)    // total scheduled minutes
normalizeGroup('Черга 3.1') // '3.1'
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
