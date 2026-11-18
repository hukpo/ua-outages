# AI processor eval set

## Results (18.11.2026, prompts p7–p13)

`npm run eval -- --backend <claude-cli|codex-cli|anthropic|openai|replay> --model <id> [--sample 150] [--long-edge 600,800] [--min-short-edge 400] [--effort high]`.
The CLI backends run the models through `claude -p` / `codex exec` (no API key; slower). Text on
`--sample 150`, the same 150 cases for every model; pictures on all 76.

| model             | text                     | pictures, 800 px            | 600 px | 1100 px |
| ----------------- | ------------------------ | --------------------------- | ------ | ------- |
| GPT-6.1 Terra     | 150/150 ×2 (p13), 143 p7 | 71/76; 75/76 at p10 below   |        |         |
| GPT-6.2 Astra     | 135/150                  | 75–76/76                    | 73/76  |         |
| Claude Sonnet 5.5 | 138/150                  | 68/76                       |        | 66/76   |
| Claude Haiku 5.5  | 136/150                  | 65/76                       |        | 62/76   |
| Claude Opus 5.5   |                          | Zakarpattia grids only: 2/8 |        |         |
| GPT-6.2 Sol       |                          | 73/76                       |        |         |

**Pictures, p10, `--long-edge 1000 --min-short-edge 400`** (the `openaiImageProcessor` defaults): GPT-6.1 Terra 75/76, the miss Zakarpattia 9718 (two cells off). At 800 px it lost Volyn's 1.1 10:00–12:00; 1000 and 1200 px read it. 1600 px with every small picture ×2 also gave 75/76 at three times the image tokens. OpenAI counts ~1 token per 800 px: Chernihiv's 471×800 poster ~470, Zakarpattia's grid ~230 (800×210) or ~860 (×2), Volyn's table ~620 (800 px) or ~2360 (1600 px).

**Text, p13**: GPT-6.1 Terra 150/150 in two runs in a row. p9–p13 came from its misses on these 150: ЦЕК's "до 22:00 відключаються черги" (a change), "діють ЕКСТРЕНІ … ГПВ не діють" (an emergency start), "повертаємось до графіків" (the emergency ends), "по області (крім …)" (no area), "станом на" as the time of the action, gpvApplies, a change's start time. `photosAreSchedules` is now scored only for the channels whose photos the SDK reads (Chernihiv, Zakarpattia, Sumy). An emergency change naming queues counts as a start (the state machine does the same with both).

**Regex readers of 0.4.8** on the same 150, scored on what the SDK makes of a post (emergency announcements; hours per queue per date where the schedule is taken from text): 144/150, against 150/150 for Terra p13 on the same measure. Its misses: ЦЕК's "+ черга 1.1 з 06:00", Ukrenergo's "у більшості регіонів скасовано" read as a cancel in four oblasts, two ministry briefings naming Poltava, Cherkasy's two schedules in one post (half the queues unknown), Chernihiv's "ГПВ діють" after a ГАВ cancel.

**Tokens** (GPT-6.1 Terra, exact output from `codex exec --json`, input counted with o200k): a post ~1972 (instructions) + 494 (schema) + ~477 (the post, compact JSON) in, ~180 out; a picture ~700 + image in, ~290 out. Answers as "HH:MM-HH:MM" strings instead of objects cut picture output from ~406 to ~290 tokens.

- Claude models misread Zakarpattia's 48-cell colour grids at Telegram's 800×210 (Haiku 1/8, Sonnet 3/8, Opus 2/8); the GPT models read them (Astra 8/8, Terra 7/8).
- On the full 784 posts, Haiku went from 554 (prompt p4, scored strictly) to 627 after the scoring compared only what the SDK uses; prompts p5–p7 fixed the patterns behind most remaining misses.
- Haiku's tokens per post, via the CLI: ~1.9k in / ~1.4k out (mostly thinking); per picture ~1.6k in / ~1.7k out.

The answers behind the last runs are in `test/fixtures/ai/` and replayed offline by `test/ai/replay.test.ts`.

Labelled ground truth for choosing a text/image model and a downscale size for the `src/ai`
processors. The labels follow `TEXT_SYSTEM` / `IMAGE_SYSTEM` in `src/ai/prompts.ts` as of
**PROMPT_VERSION p3**, plus the conventions below where the prompt leaves things open.

## What's here

- `raw/<channel>.json`: posts scraped from `https://t.me/s/<channel>`, about 3 pages per channel, on
  2026-11-18 (`TelegramPost[]`, photo-only posts included with `text: ''`).
  `raw/regression/<channel>.json` holds the posts of `test/fixtures/telegram/posts.json`, refetched
  for their metadata (edited, replyTo, photos). Refresh with `npx tsx scripts/collect-eval.ts`
  (`--pages N`, `--around Channel/id`, `--regression`).
- `text/<channel>-<id>.json`: 784 post cases.
- `image/<name>.json`: 76 picture cases. `image/files/`: 21 Telegram photos they reference; the
  others reference images under `test/fixtures/`.

## Case format

```jsonc
// text/*.json
{ "input": PostInput,            // exactly as the SDK builds it: regions = channelRegions(channel, first region)
  "expected": PostAnalysis,      // every event has all 17 fields
  "tags": ["gav", "cancel"], "note": "why / the deciding phrase", "uncertain": false }
// image/*.json
{ "input": { "url", "caption", "publishedAt", "region": PostRegion, "file": "path from repo root" },
  "expected": ImageReading, "tags", "note", "uncertain" }
```

Every `expected` passes `validatePostAnalysis` / `validateImageReading` unchanged, except the 8
listed under "Known validator rejects".

## Label conventions

- **Kind "other"** is never labelled. A post that is only "other" (explainer, appeal, damage,
  repairs, ГОП, warnings with «можуть / у разі / прогнозується», national news naming none of the
  input's regions) has `events: []`. In a mixed post only the other events are listed.
- **Times** are `HH:MM`. "00-02" becomes 00:00–02:00, and the end of the day is "24:00". Text
  schedules keep intervals **as written, unmerged, in text order**. Image schedules are merged
  (IMAGE_SYSTEM). Hours with power («графік заживлення», Chernivtsi) are turned into the hours
  without power in between, and an open «з 22:30» means on until 24:00.
- **gpv start / change (p2):**
  - `start` is a day's schedule, new or re-issued: «внесено зміни до ГПВ … станом на», «оновлено»,
    «ОНОВЛЕННЯ», or a list for the rest of the day «з 16:00 до 24:00». It also covers a caption
    whose hours are only in the photo or on a site (`schedule: []`).
  - `at` is set only for a partial-day replacement («з 16:00», «(з 17:30)»). A whole-day «з 00:00
    до 24:00» gives `at: null`.
  - `change` is a correction to some queues: «з 6:00 до 8:00 додатково … 1/1 та 1/2», «до 17:00
    продовжується … 4/1», «з 12:30 до 16:00 відключаються черги …». It lists only those queues,
    with `intervals: null` when only one end is given. `additive` stays false on a change (the
    field is documented for start).
  - Queue names: "1/1" and "1-1" are written "1.1".
- **Re-issues that list only some queues** (Kropyvnytskyi 1787 etc.): only the listed queues
  appear, and the omitted ones (presumably no outages) are not invented. These are tagged `tricky`.
- **date** is null when the event is about the post's own Kyiv date.
- **at** is only a time the text gives for the action. **statedAt** is only «станом на / оновлено
  HH:MM» as the time the post was issued. «Станом на 19:05 … відновлено» (a status line) is not
  `statedAt`.
- **area** is copied verbatim, case and inflection included («м. ДНІПРО», «Павлограді, частині…»);
  compare it loosely. «по всій … області» gives `area: null`.
- **allQueues** is only for «в повному обсязі / всі черги». «10 черг» gives `queueCount: 10`, and
  «1-10 черг» lists the queues.
- **gpvApplies** sits on the emergency events («Продовжують діяти ГПВ», «ГПВ не діють»). A
  `"gpv"` event is not added for it.
- **addedInEdit** requires `input.edited` and a visibly appended line («UPD:», «‼️Скасовано …»).
  The labels also count an UPD line put _above_ the original (ztoe, Lviv).
- **untilFurtherNotice** (p3) is true only on a cancel saying «до окремого/особливого
  розпорядження». Only one case has it: `SvitloKropyvnytskyiMisto-1818`. A start «ГАВ діє до
  окремого розпорядження» has it false.
- **photosAreSchedules** was decided by looking at the photos. Many channels attach a stock banner
  («Діятиме графік погодинних відключень») that is _not_ a schedule (Zaporizhzhia, Chernihiv
  change posts, Poltava, Kharkiv, Zhytomyr).
- **Ukrenergo** inputs only cover chernivtsi/zakarpattia/volyn/rivne, so national posts get events
  only when they name one of those.

### Suggested scoring

- Match events regardless of order, by (kind, action, regions, area, date).
- Merge adjacent text intervals before comparing.
- Treat gpv-start `at` "00:00" as equal to null.
- Compare `area` loosely.
- Score `additive` only on starts, and treat `allQueues` as equal to listing every emergency queue.

## Tags

`gav sgav gpv gpv-schedule emergency cancel edit reply album multi-region national explainer
negative tricky regression` (text); `gpv negative fixture telegram album tricky` (image).

## Coverage and selection

- **Text:** every keyword post (ГАВ/СГАВ/ГПВ/аварійн/екстрен/графік/черг/відключ/скасов/відмін) of
  the 18 windows, plus about 3 negatives per channel, plus all 123 regression posts (tag
  `regression`; their outcomes come from the old `test/emergency/*` assertions, re-labelled to the
  prompt where the old tests inferred things the text doesn't say).
- **Holovanivsk:** @SvitloHolovanivskohoRayonu mirrors @SvitloKropyvnytskyiMisto post for post, so
  only 5 samples are kept: 1792, which is unique, and 4 mirrors.
- **Images:**
  - Chernihiv posters (36) and not-schedules (7).
  - Zakarpattia (8), Volyn (2), Khmelnytskyi (2).
  - 21 Telegram photos: 10 schedules (Chernihiv, Sumy, Lviv, Chernivtsi, Kropyvnytskyi clock
    dials) and 11 negatives.
  - The window had no Zakarpattia schedule picture.

## Known validator rejects (the label is the truth; the SDK can't express it yet)

- `text/cek_info-4362, 4375, 4388, 4393`: Pavlohrad's own two-queue city ГПВ ("1 черга", "2
  черга"), which are not queues of dnipro-cek.
- `text/mk_energy_ua-22542, 22543`: «графік оновлено, дивіться на сайті» with no photo, so the
  gpv start has no schedule.
- `image/oe_cv_ua-4059-0, -1`: a 2-picture album splitting Chernivtsi's 12 groups 6+6. Each
  picture is labelled with only its own groups.

## Uncertain cases

- `text/SumyEnergo-3848`: "введені ГАВ для 6-10 черг споживачів (1-5 ввімкнені)": a rotation, labelled change (types.ts: "the set of queues off changed"); "введені" could also be read as start with queuesRestored.
- `text/SvitloHolovanivskohoRayonu-1792`: Unique to this channel (Kropyvnytskyi has only "ГПВ та ГОП скасовано до окремого розпорядження", which this channel also mirrors). "скасовано ГПВ станом на 20:00 15.11.2026:" ends with a colon and …
- `text/Ukrenergo-5608`: "У більшості регіонів … скасовано аварійні відключення" + "продовжують діяти лише у Харківській області": names none of chernivtsi/zakarpattia/volyn/rivne. Old classifyUkrenergo read it as a CANCEL …
- `text/Zaporizhzhyaoblenergo_news-3601`: Restoration news; «наразі діють дещо більші за прогнозовані на сьогодні обсяги графіки погодинних відключень» → gpv in force (start, no schedule). Could be read as change (bigger volumes) or as …
- `text/Zaporizhzhyaoblenergo_news-3603`: Appeal about anonymous polls; item 1 states «сьогодні, 15 листопада, по Запорізькій області діють графіки погодинних відключень». Labelled gpv start (no schedule) per "діють" = start; arguably the …
- `text/Zaporizhzhyaoblenergo_news-3614`: Long news quote: «сьогодні вранці по регіону запроваджувалися … (ГАВ та СГАВ), станом на 09:00 вони вже були скасовані». Retrospective cancel (already posted in 3613 at 09:17). at null: "станом на …
- `text/cek_info-4341`: "ЕКСТРЕНІ ВІДКЛЮЧЕННЯ тривають … ГАВ та СГАВ введенні в повному обсязі. ГПВ не діє." Two starts (one per schedule); no separate emergency event since ГАВ/СГАВ are named. Old test: a single gav apply …
- `text/cek_info-4362`: Pavlohrad's separate city schedule names its queues "1 черга"/"2 черга", not in the region's queue list (1.1…6.2); labelled verbatim as "1","2" per "or the region's own names" — the SDK validator …
- `text/cek_info-4375`: Pavlohrad's separate city schedule names its queues "1 черга"/"2 черга", not in the region's queue list (1.1…6.2); labelled verbatim as "1","2" per "or the region's own names" — the SDK validator …
- `text/cek_info-4388`: Pavlohrad's separate city schedule names its queues "1 черга"/"2 черга", not in the region's queue list (1.1…6.2); labelled verbatim as "1","2" per "or the region's own names" — the SDK validator …
- `text/cek_info-4393`: Павлоград's separate two-queue ГПВ for 15 Nov (posted 14 Nov). Queues "1"/"2" are the city's own names, not in the region's 1.1…6.2 list — the SDK validator would reject them; how it should be …
- `text/chernigivoblenergo-4930`: "додатково застосовано ще 5 черг ГАВ. Наразі діє 10 черг ГАВ одночасно." Labelled as the stated total (queueCount 10, additive false), as the old test did. The alternative (additive true, queueCount …
- `text/chernigivoblenergo-5583`: "відмінено дію ГАВ (typo Чернгівщині). Однак тепер маємо зміни у ГПВ. З 13:00 відключилися черги 2/1 і 2/2. До 17:00 продовжаться відключення для черг 1/1 і 1/2." Queues written "2/1" → "2.1". Only …
- `text/dtek_ua-4678`: "Київщина: повертаємось до графіків відключень" without naming the emergency; read as the emergency ending (old test: cancel). Photos are ГПВ cards.
- `text/dtek_ua-4808`: explainer post that states a fact: "На Київщині сьогодні запровадили екстрені відключення, під час яких графіки не діють" (past tense — still in force at 17:31?); "в більшості областей діють …
- `text/khmelnytskoblenergo-1059`: "сьогодні, 22.01.2026, окрім ГПВ, додатково запроваджено ГАВ": "додатково" is in addition to ГПВ (gpvApplies true), not more ГАВ queues — additive left false.
- `text/khmelnytskoblenergo-1868`: "Тож графіки погодинних відключень (ГПВ) запроваджено і на Хмельниччині. Нагадуємо, що ж таке ГПВ?" — an explainer of what ГПВ is; no date/hours. Could be read as a gpv start (no schedule).
- `text/khmelnytskoblenergo-1890`: "оновлено ГПВ на <date>" → change. "оновлено ГПВ на 15 листопада (16:00)": read "(16:00)" as from 16:00 (cf. 1891 "(з 17:30)"); could be statedAt instead. Only 10 subqueues listed (2.1, 2.2 absent)
- `text/lvivoblenergo-2719`: "у Львові та області діють аварійні відключення обсягом 10 черг": per the rule it names neither ГАВ nor СГАВ → emergency, though the queue count makes it effectively ГАВ.
- `text/lvivoblenergo-2977`: "30 червня прогнозується введення ГПВ … з 16:00 до 22:00 … У випадку впровадження ГПВ" — a forecast, conditional ("у випадку"): no start. Photo is a warning banner, not a schedule. Alternative …
- `text/lvivoblenergo-3002`: "аварійне відключення в електромережах 110кВ … частково знеструмлені споживачі в центральній частині Львова": a local network fault (damage), not a grid-ordered emergency outage → other. TEXT_SYSTEM …
- `text/lvivoblenergo-3003`: "аварійне відключення в електромережах 110кВ … частково знеструмлені споживачі в центральній частині Львова": a local network fault (damage), not a grid-ordered emergency outage → other. TEXT_SYSTEM …
- `text/mk_energy_ua-21455`: "оновлені графіки (ГПВ, ГАВ та СГАВ)" took effect 1 Oct (explainer), and "Станом на ранок 1 жовтня 2026 року ГПВ в Миколаївській області НЕ застосовуються" → gpv cancel (status, no HH:MM so statedAt …
- `text/mk_energy_ua-22542`: "Час відключення для деяких підчерг змінено" UNCERTAIN: no photo and no hours ("дивіться на off.energy.mk.ua"), so validate.ts rejects a schedule-less gpv start ("a ГПВ start without any queue"). …
- `text/mk_energy_ua-22543`: "ГПВ на поточну добу ОНОВЛЕНО. Актуальний станом на 19:45" UNCERTAIN: no photo and no hours ("дивіться на off.energy.mk.ua"), so validate.ts rejects a schedule-less gpv start ("a ГПВ start without …
- `text/mk_energy_ua-22544`: "Попередній прогноз … Погодинні графіки діятимуть з 06:00 до 23:59": treated as start (a stated plan, not conditional); at "06:00" from "діятимуть з 06:00" although some subqueues start 05:30; "21:00 …
- `text/mk_energy_ua-22570`: "Попередній прогноз … Погодинні графіки діятимуть з 06:00 до 23:59": treated as start (a stated plan, not conditional); at "06:00" from "діятимуть з 06:00" although some subqueues start 05:30; "21:00 …
- `text/mk_energy_ua-22606`: "Попередній прогноз … Погодинні графіки діятимуть з 06:00 до 23:59": treated as start (a stated plan, not conditional); at "06:00" from "діятимуть з 06:00" although some subqueues start 05:30; "21:00 …
- `text/pat_cherkasyoblenergo-2025`: "знеструмлені споживачі в Уманському районі – там графіки погодинних відключень тимчасово не діють": read as gpv cancel for the area (power is out after an attack). Could also be read as damage → …
- `text/pat_cherkasyoblenergo-2028`: "в частині Уманського району ... застосовуються тимчасові індивідуальні графіки відключень" with hours for 1.2…6.2 only: read as gpv start for that area; area string is a judgment call
- `text/pat_cherkasyoblenergo-2032`: two schedules: the region "крім ВСП «Уманські енергетичні мережі», …" (area null, it is the rest of the region) and the individual one for that part (area). Area strings and area-null for "the region …
- `text/poltavaOE-4518`: Ministry briefing repost: "у м. Києві, Харківській, Полтавській та Сумській областях вимушено застосовуються аварійні відключення" names the oblast. Stale: Poltava cancelled its ГАВ at 10:52 (4517), …
- `text/poltavaOE-4519`: Ukrenergo repost: "У … Полтавській … областях зранку застосовувалися графіки аварійних відключень" is past tense (not said to be still on); ГПВ "у частині областей" names no oblast
- `text/poltavaOE-4528`: gpv by volume per time span ("з 08:00 по 22:00 … в обсязі 4 черги"): no queue hours in the text, schedule; text says "10 листопада" though posted 10.11 21:43 and otherwise matches the 11.11 post 4525 …
- `text/poltavaOE-4552`: Ukrenergo repost: "У Харківській та Полтавській областях зранку застосовувалися графіки аварійних відключень": past tense, not said to be still on
- `text/poltavaOE-4557`: "О 21:07 скасовано ГАВ (6-10 черги. О 20:45 відміна СГАВ." Edited post; the СГАВ sentence may have been added by the edit but is not marked as such: addedInEdit false
- `text/prykarpattyaoblenergo_official-3078`: "сьогодні з 18:30 введені дві черги ГАВ – пʼята та шоста" (ordinal words). Photos are ГАВ tables of settlements per queue without hours: labelled photosAreSchedules false — not sure that is wanted.
- `text/prykarpattyaoblenergo_official-3081`: "Окрім 7 черги ГАВ, додатково … буде введена 8 черга … до окремої вказівки про скасування" — not a cancel. Photos: ГАВ settlement tables (no hours) → false, unsure.
- `text/prykarpattyaoblenergo_official-3091`: "станом на 22:02 деактивовані всі черги ГАВ": "станом на" is listed as statedAt in the prompt, but here it is also the only time of the cancel. Labelled both at and statedAt 22:02.
- `text/ternopiloblenerho-1868`: "На Кременеччині на період аварійно-відновлювальних робіт застосовуватимуться почергові обмеження електропостачання … у визначених населених пунктах": local rotating limits during repairs after an …
- `text/ztoe_ua-1814`: Prepended "UPD: … аварійні відключення скасовані" over "запроваджено аварійні відключення електроенергії (СпецГАВ)". The cancel says only "аварійні відключення"; labelled sgav because it lifts the …
- `text/ztoe_ua-1869`: "Аварійні відключення на Житомирщині скасовано. Повертаємось до графіків." + "маємо зміни у ГПВ". Kind emergency per prompt (operator means ГАВ)
- `text/ztoe_ua-1877`: "Аварійні відключення на Житомирщині скасовано." Kind emergency per the prompt rule (names neither ГАВ nor СГАВ), though this operator's "аварійні відключення" are its ГАВ — a scorer may accept gav
- `text/ztoe_ua-1885`: "Аварійні відключення на Житомирщині скасовано." Kind emergency per the prompt rule (names neither ГАВ nor СГАВ), though this operator's "аварійні відключення" are its ГАВ — a scorer may accept gav
- `text/ztoe_ua-1891`: "Аварійні відключення на Житомирщині скасовано." Kind emergency per the prompt rule (names neither ГАВ nor СГАВ), though this operator's "аварійні відключення" are its ГАВ — a scorer may accept gav
- `text/ztoe_ua-1893`: "Аварійні відключення на Житомирщині скасовано." Kind emergency per the prompt rule (names neither ГАВ nor СГАВ), though this operator's "аварійні відключення" are its ГАВ — a scorer may accept gav
- `text/ztoe_ua-1907`: "Аварійні відключення на Житомирщині скасовано." "Повертаємось до графіків" → gpvApplies true Kind emergency per the prompt rule (names neither ГАВ nor СГАВ), though this operator's "аварійні …
- `image/khmelnytskyi-announcement-2026-10-17-1658`: a text screenshot ("збільшено обсяги відключень: підчерга 2.1 з 16:00 до 17:00; 6.2 з 14:00 до 16:00") uploaded under the caption of a schedule: not a table of hours per queue, so isSchedule false. …
- `image/oe_cv_ua-4059-0`: Chernivtsi "Орієнтовний графік заживлення" lists hours WITH power (ON 00:00–14:00, 16:30–20:00, з 22:30): expected = the hours without power in between. "Станом на 19:22 17.11.2026" for 18.11. The …
- `image/oe_cv_ua-4059-1`: Chernivtsi "Орієнтовний графік заживлення" lists hours WITH power (ON 00:00–14:00, 16:30–20:00, з 22:30): expected = the hours without power in between. "Станом на 19:22 17.11.2026" for 18.11. The …
