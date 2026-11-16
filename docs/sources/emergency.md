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
  ~20 posts; `?before=<id>` pages back. The reader goes back 48 h (at most 5 pages). An edited
  post shows its latest text and "edited", without the edit time.
- **Classifier** (`src/emergency/classify.ts`): per sentence, an emergency term plus an apply or
  cancel verb; the first such sentence decides. Explainers ("Чому…?", "Нагадаємо…"), future or
  negated cancels ("будуть скасовані після стабілізації", "не вдається скасувати") and reposted
  national summaries (other oblasts named) don't count. DTEK's dialect drops "аварійні" (local
  damage).
- **Folding** (`src/emergency/status.ts`): ГАВ, СГАВ and unnamed emergency shutdowns are followed
  separately, one episode per area (null = whole region); a cancel for an area ends that area, a
  whole-region cancel ends all. More queues while one runs add up; a partial cancel ends it only
  when nothing is known to remain. TTL: 12 h after the last word (Sumy 6 h).
- **YASNO** `planned-outages` (Kyiv 25/902, Dnipro 3/301): any group with `today.status =
EmergencyShutdowns` is active. YASNO not showing it ends nothing by itself (`updatedOn` moves
  with every schedule publish, and YASNO doesn't flag partial-area emergencies); only an episode
  this client saw as EmergencyShutdowns and that YASNO stopped showing is ended. ЦЕК (3/303)
  isn't used: it stayed `WaitingForSchedule` through ЦЕК's own emergency of 15.11 13:39–15:27.
- **Mykolaiv outage feed** `POST https://www.energy.mk.ua/outage/api/v1/outage` (whole region,
  12 h window; oldest first, so past 8 pages the newest are read; `AVARIYA` rows skipped; an
  active @mk_energy_ua post wins over finished rows): rows whose `reason` starts "Графік аварійних відключень", minus mislabelled
  "ГПВ ч 5,2" and a neighbour's "ГАО Кіровоград Обленерго". Running rows = active; their queue
  from "ГАВ черга 3" / "ГАВ 3 черга".
- **@Ukrenergo**: only for Zakarpattia, Volyn, Rivne and Chernivtsi (after its own channel), by
  oblast name in the same sentence; "аварійні відключення продовжують діяти лише у Харківській
  області" ends it for the others.

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
