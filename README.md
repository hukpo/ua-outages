# ua-outages

TypeScript SDK for Ukrainian power outage schedules (графіки погодинних відключень).

- **Schedules straight from the grid operators.** No aggregators or Telegram channels in between: each region reads its oblenergo's own API or page.
- **Find a group by address.** Settlement, street and house in; the outage group ("черга") out.
- **One shape for every region.** Intervals in Kyiv time with explicit offsets, DST-safe.
- **Health check.** See in one call which sources still parse, so you notice when an operator changes its site.
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
| `zakarpattia`     | Закарпатська            | Закарпаттяобленерго                     | api-outage-zakarpat-energy.inneti.net                          | ✅ / image    | ✅            | groups `unknown` while no picture is published; a published picture is reported as `unsupported`                 | [zakarpat.energy](https://zakarpat.energy/customers/break-in-electricity-supply/schedule/)               | [outage.zakarpat.energy](https://outage.zakarpat.energy/schedule_queues)                     |
| `ivano-frankivsk` | Івано-Франківська       | Прикарпаттяобленерго                    | be-svitlo.oe.if.ua                                             | ✅            | ✅            | full address only, no autocomplete                                                                               | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                              | [svitlo.oe.if.ua](https://svitlo.oe.if.ua/)                                                  |
| `chernivtsi`      | Чернівецька             | Чернівціобленерго                       | schedule page + district directories                           | ✅            | ✅            | groups numbered 1–12                                                                                             | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns/)                                                    | [oblenergo.cv.ua](https://oblenergo.cv.ua/shutdowns-search/)                                 |
| `rivne`           | Рівненська              | Рівнеобленерго                          | schedule page                                                  | ✅            | —             | addresses only in PDF                                                                                            | [roe.vsei.ua](https://www.roe.vsei.ua/disconnections)                                                    | —                                                                                            |
| `volyn`           | Волинська               | Волиньобленерго                         | inneti archive API + table image (read by colour), lookup form | ✅ image      | ✅            | full address only, no autocomplete                                                                               | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/) | [energy.volyn.ua](https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/) |
| `khmelnytskyi`    | Хмельницька             | Хмельницькобленерго                     | page text, else archive table image (read by colour)           | ✅ text/image | ✅            |                                                                                                                  | [hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)                                           | [hoe.com.ua](https://hoe.com.ua/shutdown/queue)                                              |
| `chernihiv`       | Чернігівська            | Чернігівобленерго                       | schedule poster (times read from the picture)                  | ✅ image      | —             | the schedule API and the lookup need a captcha; the same schedule is published as a poster                       | [chernihivoblenergo.com.ua](https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg)           | [interruptions.energy.cn.ua](https://interruptions.energy.cn.ua/interruptions)               |
| `zhytomyr`        | Житомирська             | Житомиробленерго                        | schedule page + lookup form                                    | ✅            | ✅            |                                                                                                                  | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                              | [ztoe.com.ua](https://www.ztoe.com.ua/unhooking-search.php)                                  |
| `kirovohrad`      | Кіровоградська          | Кіровоградобленерго                     | kiroe.com.ua JSON                                              | ✅ today      | ✅            |                                                                                                                  | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                                | [kiroe.com.ua](https://kiroe.com.ua/electricity-blackout)                                    |
| `cherkasy`        | Черкаська               | Черкасиобленерго                        | news API                                                       | ✅            | —             | lookup server has a broken TLS chain                                                                             | [cherkasyoblenergo.com](https://www.cherkasyoblenergo.com/off)                                           | [cabinet.cherkasyoblenergo.com](https://cabinet.cherkasyoblenergo.com/)                      |
| `sumy`            | Сумська                 | Сумиобленерго                           | soe.com.ua/next-api                                            | ✅ today      | ✅            |                                                                                                                  | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                                 | [soe.com.ua](https://www.soe.com.ua/consumers/shutdowns)                                     |
| `poltava`         | Полтавська              | Полтаваобленерго                        | poe.pl.ua/customs                                              | ✅            | ✅            | buildings with several connections have no single group                                                          | [poe.pl.ua](https://www.poe.pl.ua/disconnection/power-outages/)                                          | [poe.pl.ua](https://www.poe.pl.ua/)                                                          |
| `kharkiv`         | Харківська              | Харківобленерго                         | Drupal JSON:API (news)                                         | ✅            | —             | lookup needs a captcha                                                                                           | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk)                                                  | [oblenergo.kharkiv.ua](https://oblenergo.kharkiv.ua/uk/gaoinfo)                              |
| `zaporizhzhia`    | Запорізька              | Запоріжжяобленерго                      | news page                                                      | ✅            | —             | no web lookup                                                                                                    | [zoe.com.ua](https://www.zoe.com.ua/outage/)                                                             | [Telegram bot](https://t.me/esozoebot)                                                       |
| `mykolaiv`        | Миколаївська            | Миколаївобленерго                       | off.energy.mk.ua API                                           | ✅            | ✅            |                                                                                                                  | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                            | [off.energy.mk.ua](https://off.energy.mk.ua/)                                                |

**АТ «Укрзалізниця»** is a distribution operator too: homes near stations and along the lines are wired to the railway's grid and get its own schedule, which differs from the oblenergo's. It has one region per oblast page on [uz.gov.ua](https://www.uz.gov.ua/about/activity/electropostachannia/electro_consumers/temporary_shutdown/grafikiobmezhen/): `uz-kyiv`, `uz-kyiv-region`, `uz-dnipro`, … (`uz-<region id>`), and two branches each in Vinnytsia (`uz-vinnytsia`, `uz-vinnytsia-odesa`) and Sumy (`uz-sumy`, `uz-sumy-south`). Today's schedule only, read from the HTML table; a page with no table publishes nothing, so every group comes back `unknown` for today. The page also lists each group's addresses (no lookup yet).

**Not covered**

| region     | operator         | why                                   | schedule                                                    | address lookup                                                |
| ---------- | ---------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Вінницька  | Вінницяобленерго | schedule and lookup behind Cloudflare | [voe.com.ua](https://www.voe.com.ua/disconnection/detailed) | [disconnection.voe.com.ua](https://disconnection.voe.com.ua/) |
| Херсонська | Херсонобленерго  | no public schedule                    | [ksoe.com.ua](https://ksoe.com.ua/)                         | —                                                             |

Луганська область and Crimea are not covered. "today" means the operator publishes only the current day. "⚠️ code ready" means the provider is implemented but the operator currently blocks automated requests. "image" means the schedule is read from the table picture the operator publishes.
<!-- regions:end -->

"Address" means the SDK can turn an address into a group. Zakarpattia publishes its schedule only as a picture: while none is published `getSchedules` lists its groups as `unknown` (not "no outages"); once one is, it throws `unsupported` with the picture's address. Its address lookup works either way.

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

| option       | default                  |                                                                                                                                                                         |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheTtlMs` | `300000`                 | Reuse a region's schedule for this long. `0` turns caching off. Concurrent requests for one region share a single fetch (except calls with a `signal`, see Cancelling). |
| `timeoutMs`  | `15000`                  | Per request.                                                                                                                                                            |
| `retries`    | `1`                      | Extra attempts after a network error or a 5xx. A bot-check page is never retried, whatever its status.                                                                  |
| `fetch`      | `globalThis.fetch`       | Bring your own (proxy, logging, tests).                                                                                                                                 |
| `userAgent`  | `ua-outages (+repo url)` |                                                                                                                                                                         |
| `providers`  | built-in                 | Replace or extend the regions.                                                                                                                                          |

### Schedules

```ts
outages.regions() // RegionInfo[]: id, name, operator, capabilities (schedule, addressSearch, streetSearch, emergency)
await outages.getSchedules('lviv') // every group: { groups, schedules: { '1.1': DaySchedule[] }, updatedAt }
await outages.getSchedule('lviv', '3.1') // one group; accepts "GPV3.1", "черга 3.1", …
```

A `DaySchedule` is `{ date: 'YYYY-MM-DD', status, intervals }`:

- `status` is `scheduled`, `no-outages`, `emergency` (the plan doesn't apply) or `unknown` (not published yet).
- `intervals` are sorted and merged: `{ from, to, kind }`, where `kind` is `off` or `maybe` ("можливе відключення", switching time).

`updatedAt` is when the operator last changed the schedule, when the source says so.

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

#### Cancelling

```ts
// stop as soon as your own deadline passes
const s = await outages.getSchedules('sumy', { fresh: true, signal: AbortSignal.timeout(20_000) })
```

`getSchedules`, `getSchedule` and `healthCheck` take a `signal`. When it aborts, the call rejects right away with the signal's reason (an `AbortError` by default, not an `OutageError`). The work that call started is stopped: its request in flight is cancelled, and nothing more is sent to the operator for it, no further groups, pages or retries. With a `Promise.race` cap of your own, pass a signal too, otherwise the losing call keeps running in the background.

Work shared with other callers keeps going for them: a call with a signal that is answered from the cache, or that waits for a session another call is opening, just stops waiting. Shared work is cancelled only when every caller waiting for it has given up. To keep one caller's cancellation from reaching others, a call with a signal doesn't share its own fetch through the cache while it runs (its result is cached when it arrives). Address search doesn't take a signal yet.

### Schedules published as pictures

Volyn publishes the schedule only as a table image, and Khmelnytskyi does when it doesn't post it as text on its schedule page (the text wins for its date). The SDK reads those itself: it decodes the PNG, finds the grid and classifies each cell by colour, with no dependencies. When an operator posts a text announcement as an image under the same date, it is skipped. A colour the SDK doesn't know is reported as a `parse` error instead of being guessed.

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

Where the operator's lookup also says which emergency queues an address is in, the match carries them in `emergency` (omitted when the operator says nothing):

```ts
await outages.findGroup('sumy', { city: 'Конотоп', street: 'провулок 2-Й Миру', house: '3' })
// { region: 'sumy', group: '2.2', …, emergency: { gav: ['6'], sgav: ['2'], achr: ['3'] } }
```

`gav` (ГАВ, the emergency schedule), `sgav` (СГАВ, the special one) and `achr` (АЧР, automatic load shedding by frequency) are numbered separately from ГПВ groups: "1" … "10", Lviv also "20", Mykolaiv also reserve queues "1(Р)". Values are distinct and sorted; a building with several accounts or connections can be in several. Regions that return them: Lviv, Ternopil, Zakarpattia (`chergGav`, `chergSgav`, `chergAchr`), Ivano-Frankivsk (ГАВ, СГАВ), Volyn ("Черга у ГАВ"), Khmelnytskyi (ГАВ, often empty), Sumy (ГАВ, АЧР, СГАВ), Poltava (ГАВ; "черга 0" counts as none) and Mykolaiv (ГАВ, СГАВ). The others publish no address → ГАВ mapping (Kharkiv says it can't by law), or hide it behind a captcha (Chernihiv) or a personal account number (Cherkasy).

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

Limits worth knowing: the posts are free text, read with patterns built from the operators' real wording; a new phrasing may read as nothing (`inactive`) or `unknown` until the patterns learn it. DTEK says "екстрені відключення" for ГАВ and "аварійні" for local damage after attacks; the latter is not reported. Telegram doesn't show when a post was edited, so an "UPD … скасовано" cancellation gets the post's own time as `endedAt`, unless `previous` shows the post was still in force at the last reading (then the time of this reading). Negated, conditional and future wording ("не скасовано", "скасовано не буде", "можуть бути скасовані", "після скасування") is never read as a cancellation, and "аварійні відключення не застосовуються" is ignored rather than read as one: a false "cancelled" is worse than a false "still on", which the TTL ends. A partial cancel ("скасовано 5 черг") ends the episode only when the remaining queues are known to be none; a partial or area-only cancel with nothing known before it is `unknown`, not "cancelled", until the TTL has passed since (then it is history: `inactive`, a partial one with the end inferred). Queue rotations replace rather than add up: "для 6-10 черг (1-5 ввімкнені)", "замість 1 та 2 черг будуть знеструмлені 7 та 8", and "знову введені ГАВ (для 6-10 черг)" while those are off. When ГАВ and СГАВ both ended, `kind` / `endedAt` are of the one that ended last. Conditions, purposes and the past ("у разі перевищення … будуть застосовані", "щоб уникнути застосування", "вчора було застосовано", "можуть бути застосовані") are not applies ("було застосовано" with a time of the last day, "о 07:35 … було застосовано ГАВ", is; so is "Щоб уникнути аварій, застосовано ГАВ"), and ГПВ being cancelled ("ГПВ скасовано, діють ГАВ") is not an emergency cancel. National wording reposted by an operator ("в окремих регіонах України запроваджені", "у більшості регіонів скасовано", "по всій країні") says nothing about its region unless the sentence names an oblast; neither does a post about the schedules as documents ("набрали чинності оновлені графіки (ГПВ, ГАВ та СГАВ)"). A post that can't be read while an emergency runs keeps it running. YASNO not showing `EmergencyShutdowns` never cancels a post by itself (its `updatedOn` moves with every schedule); it ends only an emergency YASNO itself showed earlier in the same client. Ukrenergo names oblasts only sometimes, so for Zakarpattia, Volyn and Rivne a quiet `inactive` means little; for Chernivtsi its posts are merged with the operator's channel by time. YASNO groups without a known `today.status` are a failed read, never an end. Results are cached like schedules (`fresh: true` skips the cache), and a channel shared by several regions is fetched once.

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

- `empty`: the source works but publishes nothing right now (no groups, or every day `unknown`). Often there are no outages then, but the SDK can't tell.
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

## Releasing

Bump the version and push the tag; the Release workflow (`.github/workflows/release.yml`) tests, builds and publishes it to npm with provenance:

```sh
npm version patch   # or minor / major
git push --follow-tags
```

## License

MIT
