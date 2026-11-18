# Changelog

Older versions are summarised under "Upgrading from …" in the README.

## 0.5.0

Posts and pictures are read by AI processors you plug in, instead of patterns and pixel readers. Breaking: regions that publish that way need a processor.

### Added

- `OutageClientOptions.textProcessor` and `imageProcessor`, two separate pluggable processors (`TextProcessor`: `PostInput` → `PostAnalysis`; `ImageProcessor`: `ImageInput` → `ImageReading`), plus `processorCache`, `onProcessed` and `processorConcurrency`.
- `ua-outages/ai-sdk` (`aiSdkTextProcessor`, `aiSdkImageProcessor`: any model of the Vercel AI SDK 7) and `ua-outages/tanstack-ai` (`tanstackTextProcessor`, `tanstackImageProcessor`: any TanStack AI text adapter); `ai` and `@tanstack/ai` are optional peer dependencies.
- `ua-outages/anthropic` (`anthropicTextProcessor`, `anthropicImageProcessor`; Claude Haiku 5.5 by default) and `ua-outages/openai` (`openaiTextProcessor`, `openaiImageProcessor`), on structured outputs. `@anthropic-ai/sdk` and `openai` are optional peer dependencies; the core has no runtime dependency and holds no key.
- Every answer is validated (`validatePostAnalysis`, `validateImageReading`): times and dates must exist and be near the post, queues must exist in the region, a schedule picture must give every queue. A failed answer is `parse`, never a guess.
- Each post and picture is parsed once: answers are cached by a hash of the processor id and the whole input (a picture by its bytes), concurrent callers share one call, failed answers are remembered for 30 min. `MemoryProcessorCache` is the default; pass your own to persist.
- Pictures are compacted before they are sent (`compactImage`, pure JS): scaled down to a long edge of 800 px by default (`maxLongEdge` per processor; 1000 px for the OpenAI, AI SDK and TanStack adapters), margins of one flat colour trimmed (as drawn on white), and a thin one (short side under `minShortEdge`: 400 px for those adapters, off otherwise) blown up pixel for pixel by the largest whole factor within 2400 px, so thin grid cells stay legible (Zakarpattia's 800×210 grid goes as 2400×630). Bare photos are checked cheaply on a 256 px copy before a full read; a post's photos are read only when its text says they are the schedule.
- `ProcessorUsage` reports `cachedInputTokens` and the vendor's service `tier`.
- `verifyProcessor`, `judgeProcessor` and `verifyPosts`: a post that changes an emergency state is read by a second model and counts only when both agree; a third settles a disagreement by majority, and with none the post is unclear (`AiRuntime.analyzeEmergencyPost`). `ProcessedEvent.role` tells the second and third readings apart.
- `RegionInfo.capabilities.requires`: the processors a region's schedule needs.
- `OutageError` code `config`: a processor is needed and none is configured.
- `TelegramPost.replyTo`: the post a reply quotes. A post reaches the text processor as one unit with it (Zaporizhzhia 17.11: 3629 explains 3628's cancel).
- `PostEvent.untilFurtherNotice` ("скасовано до окремого розпорядження").
- The eval set (`eval/`, ~780 posts from the 19 channels the SDK reads and ~75 pictures, labelled) and `npm run eval`.
- `normalizeGroup` reads "1/1".
- `SourceStatus.unread` (and `SourceRead` days' `unread`): the days whose newest post on a channel couldn't be read, and why. They are `unknown`, and published as such as of that post, so an older version on another channel doesn't win them.

### Changed

- `sumy` reads `@SumyEnergo`'s schedule pictures with the image processor: tomorrow, from the evening before (its API has today only).
- `sumy`: `getEmergency` holds a ГАВ apply to the end of its Kyiv day (was 6 h after the last word: Sumyoblenergo never posts a cancel, and its ГАВ run for hours, announced anew each morning; 18.11.2026 it showed none from 14:09 while Ukrenergo still named Sumy at 10:37), and reads @Ukrenergo as well.
- `zakarpattia`: `getEmergency` reads the operator's own channel `@zakarpatenergyofficial` first, `@Ukrenergo` after.
- A source left unread because no processor is configured (`config` in `sources`) doesn't count as failed in `assessFreshness` (`source-failed`) or `healthCheck` (`degraded`).

- `getEmergency` reads posts with the text processor. Without one it is `unknown` wherever announcements are posts (it used to read them with patterns). Fixed by this: Kropyvnytskyi's "В 14:05 відміна дії графіку ГАВ" (0.4.3 read it as ГАВ in force) and Zaporizhzhia's explainer 3629 ("… запроваджуються …", read by 0.4.8 as a new ГАВ).
- `EmergencyStatus.area` is as the operator wrote it ("м. ДНІПРО"; was normalised to "м. Дніпро").
- Without `textProcessor`: `zaporizhzhia`, `kharkiv`, `cherkasy` throw `config`; `kirovohrad`, `chernivtsi`, `dnipro-cek` answer from the structured source only, the post source failed in `sources`. Without `imageProcessor`: `volyn` throws `config`; `khmelnytskyi`, `chernihiv`, `zakarpattia` need both.
- Chernihiv: a correction in words is applied when it gives both ends of an outage, otherwise the queues it names are `unknown` until the next poster (0.4.4 made an open-ended start `maybe` up to the poster's next outage).
- Cherkasy: every post the site's search finds since yesterday is fetched (up to 20) and read; the processor tells schedules from notices (was: picked by title).
- Lviv: the schedule text, which LOE's system writes from a fixed template, is read exactly with no processor (`lvivTemplate`); a text that strays from the template in any line goes to the text processor, or is `parse` without one. A slot with only a picture (the format before 30.10.2025) is `parse`, as before.
- An album may split the queues over its pictures; they are put together.
- A post that can't be read (the processor fails, its answer fails validation, its picture doesn't read) makes the days it may be about `unknown` (a day it names; its own day and the next when it names none), until a later whole day: a list or picture for the whole day, or a cancellation. An update for part of the day ("з 14:00 до 18:00", a re-issue posted during the day) doesn't stand in for it. The source still answers its other days; `sources[].unread` says why. A post that announces a schedule picture and has none counts as unread; so does a list on a page without times that names no day.
- A day is whole or not known: shown from posts only when a whole list was published for it. A correction, a window or an update "з 15:00" with nothing under it (or after a cancellation) leaves the day `unknown`; a group the base list didn't name stays `unknown` after a correction. `dnipro-cek` honours a cancelled day and takes a correction from its stated time; Kirovohrad treats a partial change with no list under it as `parse`.
- A picture with nothing read before it for its day (Zakarpattia's morning poster) is the whole day; a caption's "діє з 15:00" is where a re-issue's hours start.
- `dnipro-cek`, `kirovohrad`, `zakarpattia`: a channel read that doesn't reach back to the list it builds on is `parse`, as it already was for the other channels.
- `getEmergency`: a post the processors read as unclear (they disagree, or it fails validation) makes the state `unknown` until a post made after it about the same kind (ГАВ and СГАВ apart), and doesn't extend an episode; an event dated without a time starts at the start of its day.
- `getEmergency`: "заміна черг: тепер 3 та 4" replaces the queues off (a start or "додатково" adds to them); "тепер 2 черги" with nothing before is on, two queues; a cancel announced for later ("о 12:00 скасовуються") stands over a word that took effect before it; "до 14:00" of an apply at 23:00 is the next day; on a channel of several regions the second reading is asked whatever region the first put the post under; an apply from one channel while the other one, which may have cancelled it, is down is `unknown`.
- Emergency answers: queues must be a list and `allQueues` a boolean; "all queues" with only some of them, a range as one queue ("1,2-4"), an event naming no region on a channel of several are `parse`; every queue of a fixed set named one by one is all of them.
- Pictures: the prompt (p18) asks for a queue's name alone when its row can't be read for certain (that is `parse`), never a best guess; "not a schedule" with a schedule's rows is `parse`; transparency is drawn on white before scaling; a whole PNG the decoder doesn't read (4-bit, interlaced) is sent as it is.
- The processor cache: an answer the validator refuses now is remembered as a misread (asked again after 30 min) and reported so in `onProcessed`; a store that fails is no cache.
- Adapters: an API error keeps its HTTP status wherever the vendor SDK puts it; a 400/413/415/422 on the input is `parse` (the post won't read), not `http`. Processor ids include a hash of the options that change answers, so the cache isn't shared across them.
- Site articles without a time of their own (Zaporizhzhia, Khmelnytskyi, and Lviv's off-template texts) are read against today's noon, so each is analysed at most once a day.

### Removed

- The regex readers of free text: `src/emergency/classify.ts`, the text parts of `providers/posts.ts`, `ua-text.ts` (`findUaDates`, `parseGroupLines`, `parseGroupBlocks`, `parseGroupPost`), `kirovohrad-telegram.ts`, `cek-telegram.ts`, and of the Zaporizhzhia, Kharkiv, Cherkasy, Khmelnytskyi, Chernivtsi, Chernihiv, Zakarpattia and Lviv providers; the DTEK prefix and area patterns in `emergency/regions.ts`.
- The pixel readers: `src/image/{table,grid,queue-table,glyphs,cards,template-codec,digit-model}.ts` and `scripts/train-digits.ts`. The PNG and JPEG decoders stay, for compaction.
- Structured sources are unchanged: JSON APIs (YASNO, DTEK, PowerOn, Sumy, Mykolaiv, …), HTML tables, PDF address lists.
