# Emergency schedules (ГАВ / СГАВ / АЧР)

How `getEmergency` and `GroupMatch.emergency` read the operators, November 2026. The full
research per region (verbatim posts, probes of endpoints that didn't work) is in
`research/<region>/GAV.md`; the fixtures used by the tests are in `test/fixtures/telegram/`.

## Background

Ukrenergo orders ГАВ (графік аварійних відключень), СГАВ (спеціальний ГАВ) and ГОП through its
regional dispatch centres. An operator switches the ordered volume ("5 черг", "в повному обсязі")
within 15 minutes and lifts it on a new command. ГАВ queues are numbered 1..10 separately from ГПВ
subqueues; which queues are off at a moment is rarely published. There are no per-queue hourly
tables: a ГАВ is a list of feeders, not a timetable.

## Address → emergency queues

| region          | field                                                                   | notes                                                                           |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Lviv            | `pw_accounts` rows: `chergGav`, `chergSgav`, `chergAchr`                | one row per account: a building has several; "Не входить" = none; "10 (48.2Гц)" |
| Ternopil        | `pw-accounts/building-names`: `chergGav`, `chergSgav`, `chergAchr`      | the SPA doesn't show it                                                         |
| Zakarpattia     | `pw_address_queues` rows: `chergGav`, `chergSgav`, `chergAchr`          | per row of houses                                                               |
| Ivano-Frankivsk | `schedule-by-search` `current.gav.queue`, `current.sgav.queue`          | null for many addresses and for HTTP 300                                        |
| Volyn           | `cherga` table, 6th column "Черга у ГАВ"                                | "Не залучено" = none                                                            |
| Khmelnytskyi    | `/shutdown-queues`, the alert with "(ГАВ)" → `<strong>8, 8, 3</strong>` | often empty                                                                     |
| Sumy            | `queues-by-street` row index 0 ГАВ, 1 АЧР, 2 СГАВ                       | order from the site's JS type map                                               |
| Poltava         | `gav_message` "залучено до ГАВ (черга 10), ГПВ (черга 3-1)"             | СГАВ/АЧР/САВН are bare memberships; "черга 0" (meaning UNVERIFIED) = none       |
| Mykolaiv        | `addr/dom/{id}/outage-queue`, `outageType.id` 1 ГАВ, 2 СГАВ             | reserve queues "1(Р)".."10(Р)"                                                  |

Not available: Chernihiv (`number_queue` returns `type_queue` 1/2/3 but needs a Turnstile token
and an account number), Cherkasy (`disconn_by_ls` QUEUE_INFO needs a personal account number;
the provider has no address lookup), DTEK/YASNO, ЦЕК, Kharkiv, Zhytomyr, Kirovohrad, Rivne,
Chernivtsi, Zaporizhzhia, Укрзалізниця.

## Live status

Sources per region are configured in `src/emergency/regions.ts` (`EMERGENCY_REGIONS`).

- **Telegram previews** (`src/emergency/telegram.ts`): `https://t.me/s/<channel>` lists the newest
  ~20 posts; `?before=<id>` pages back. The reader goes back 48 h (at most 5 pages) and says how
  far it got: when the pages run out before the region's TTL is covered, an apply on an older
  page may be missed, so "nothing in force" from such a read is `unknown`. An edited post shows
  its latest text and "edited", without the edit time: when `previous` was that post in force,
  the "UPD … скасовано" end is the first reading that sees the edit, else the post time.
- **Reading** (since 0.5.0): each post goes to the client's text processor as one unit (its
  text, the post it replies to, its photo count, the regions its channel covers) and comes back
  as `PostEvent`s, validated and mapped to announcements (`src/ai/map.ts`). Up to 0.4.8 a regex
  classifier did this per sentence (`src/emergency/classify.ts`, removed); the posts it was
  tested on are in the eval set (`eval/text/`, tag `regression`), including the two it got
  wrong in November 2026: Kropyvnytskyi 1834 «В 14:05 відміна дії графіку ГАВ» and Zaporizhzhia
  3629, an explainer replying to the 3628 cancel. A post whose answer fails validation is an
  "unclear" event: `unknown` while it is the newest word, never an end.
- **Folding** (`src/emergency/status.ts`): ГАВ, СГАВ and unnamed emergency shutdowns are followed
  separately, one episode per area (null = whole region); a cancel for an area ends that area, a
  whole-region cancel ends all, and an area cancel with only a whole-region episode on (ЦЕК 09.11:
  untagged "Діють" 18:42, "м. ДНІПРО … скасування" 20:49) ends that one. More queues while one
  runs add up; switched-on queues ("(1-5 ввімкнені)", "замість 1 та 2 черг … 7 та 8") come off
  the set, and "знову введені ГАВ (для 6-10 черг)" while 6-10 are off replaces it (Sumy never
  posts the lift in between). A partial cancel ends it only when nothing is known to remain; an
  area or partial cancel whose apply left the window is `unknown` within the TTL, history after.
  Several areas on: listed by start, queues only when they agree. Inactive shows the episode that
  ended last (Kirovohrad 22.01: СГАВ cancelled 12:58, ГАВ ended by the TTL at 20:25). TTL: 12 h
  after the last word, applied between posts too, so a new post after the gap starts a new
  episode (Sumy 6 h: it never cancels, and the same commands last minutes to ~4 h in Poltava;
  Kharkiv stays 12 h: its own episodes ran from ~1 h to ~16 h, 10.10.2025 07:56 → "станом на
  23:54", and Ukrenergo still listed it on 04.11.2026 after the 02.11 apply). Posts that take
  effect later count from their time.
- **YASNO** `planned-outages` (Kyiv 25/902, Dnipro 3/301): any group with `today.status =
EmergencyShutdowns` is active. YASNO not showing it ends nothing by itself (`updatedOn` moves
  with every schedule publish, and YASNO doesn't flag partial-area emergencies); only an episode
  this client saw as EmergencyShutdowns and that YASNO stopped showing is ended (also after a
  restart, from `previous`, even an `unknown` one carrying YASNO's end). Groups without a known
  `today.status` (ScheduleApplies, WaitingForSchedule, NoOutages) are a parse error, not an end.
  While t.me is down and YASNO still shows it, `previous` keeps the episode's details. ЦЕК (3/303)
  isn't used: it stayed `WaitingForSchedule` through ЦЕК's own emergency of 15.11 13:39–15:27.
- **Mykolaiv outage feed** `POST https://www.energy.mk.ua/outage/api/v1/outage` (whole region,
  12 h window; oldest first, so past 8 pages the newest are read; `AVARIYA` rows skipped; an
  active @mk_energy_ua post wins over finished rows, a channel cancel only when posted after the
  feed episode started; while the feed is down `previous` keeps its queues): rows whose `reason`
  starts "Графік аварійних відключень", minus mislabelled
  "ГПВ ч 5,2" and a neighbour's "ГАО Кіровоград Обленерго". Running rows = active; their queue
  from "ГАВ черга 3" / "ГАВ 3 черга".
- **@Ukrenergo**: only for Zakarpattia, Volyn, Rivne and Chernivtsi (merged with its own channel
  by time), by oblast name in the same sentence, in any form ("Волинській області", "на Волині",
  "на Закарпатті", "Рівненщині"); "аварійні відключення продовжують діяти лише у Харківській
  області" ends it for the others; "можуть бути застосовані" is nothing.

Not used: Poltava's `dynamic-unloading-info.php` (start times only, end is a 23:59 placeholder,
misses re-applications: the channel is better), Mykolaiv `outage-queue/by-type/1` `enabled`
(never seen set), the DTEK site banner (Incapsula for most DTEK sites), Lviv/Zhytomyr
`pw_accidents` `switchSubReason` (ГАВ rows UNVERIFIED), Vinnytsia (not an SDK region).

## Known gaps

- Kirovohrad has no main channel; the city's channel (`SvitloKropyvnytskyiMisto`) stands for the
  21 identical district channels.
- Chernivtsi deleted its channel history; the 2026 wording is UNVERIFIED.
- Sumy, Cherkasy and Khmelnytskyi never post a cancel; Kharkiv rarely. Their end is the TTL.
- Zakarpattia, Volyn and Rivne have no operator channel that announces ГАВ.
