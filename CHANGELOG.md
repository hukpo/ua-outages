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
- Pictures are compacted before they are sent (`compactImage`, pure JS): scaled down to a long edge of 800 px by default (`maxLongEdge` per processor; 1000 px for `openaiImageProcessor`), flat margins trimmed, and a thin one (short side under `minShortEdge`: 400 px for `openaiImageProcessor`, off otherwise) blown up pixel for pixel by the largest whole factor within 2400 px, so thin grid cells stay legible (Zakarpattia's 800×210 grid goes as 2400×630). Bare photos are checked cheaply on a 256 px copy before a full read; a post's photos are read only when its text says they are the schedule.
- `ProcessorUsage` reports `cachedInputTokens` and the vendor's service `tier`.
- `RegionInfo.capabilities.requires`: the processors a region's schedule needs.
- `OutageError` code `config`: a processor is needed and none is configured.
- `TelegramPost.replyTo`: the post a reply quotes. A post reaches the text processor as one unit with it (Zaporizhzhia 17.11: 3629 explains 3628's cancel).
- `PostEvent.untilFurtherNotice` ("скасовано до окремого розпорядження").
- The eval set (`eval/`, ~780 posts from the 19 channels the SDK reads and ~75 pictures, labelled) and `npm run eval`.
- `normalizeGroup` reads "1/1".

### Changed

- `sumy` reads `@SumyEnergo`'s schedule pictures with the image processor: tomorrow, from the evening before (its API has today only).
- `zakarpattia`: `getEmergency` reads the operator's own channel `@zakarpatenergyofficial` first, `@Ukrenergo` after.
- A source left unread because no processor is configured (`config` in `sources`) doesn't count as failed in `assessFreshness` (`source-failed`) or `healthCheck` (`degraded`).

- `getEmergency` reads posts with the text processor. Without one it is `unknown` wherever announcements are posts (it used to read them with patterns). Fixed by this: Kropyvnytskyi's "В 14:05 відміна дії графіку ГАВ" (0.4.3 read it as ГАВ in force) and Zaporizhzhia's explainer 3629 ("… запроваджуються …", read by 0.4.8 as a new ГАВ).
- `EmergencyStatus.area` is as the operator wrote it ("м. ДНІПРО"; was normalised to "м. Дніпро").
- Without `textProcessor`: `zaporizhzhia`, `kharkiv`, `cherkasy` throw `config`; `kirovohrad`, `chernivtsi`, `dnipro-cek` answer from the structured source only, the post source failed in `sources`. Without `imageProcessor`: `volyn` throws `config`; `khmelnytskyi`, `chernihiv`, `zakarpattia` need both.
- Chernihiv: a correction in words is applied when it gives both ends of an outage, otherwise the queues it names are `unknown` until the next poster (0.4.4 made an open-ended start `maybe` up to the poster's next outage).
- Cherkasy: every post the site's search finds since yesterday is fetched (up to 12) and read; the processor tells schedules from notices (was: picked by title).
- Lviv: the schedule text, which LOE's system writes from a fixed template, is read exactly with no processor (`lvivTemplate`); a text that strays from the template in any line goes to the text processor, or is `parse` without one. A slot with only a picture (the format before 30.10.2025) is `parse`, as before.
- An album may split the queues over its pictures; they are put together.
- Site articles without a time of their own (Zaporizhzhia, Khmelnytskyi, and Lviv's off-template texts) are read against today's noon, so each is analysed at most once a day.

### Removed

- The regex readers of free text: `src/emergency/classify.ts`, the text parts of `providers/posts.ts`, `ua-text.ts` (`findUaDates`, `parseGroupLines`, `parseGroupBlocks`, `parseGroupPost`), `kirovohrad-telegram.ts`, `cek-telegram.ts`, and of the Zaporizhzhia, Kharkiv, Cherkasy, Khmelnytskyi, Chernivtsi, Chernihiv, Zakarpattia and Lviv providers; the DTEK prefix and area patterns in `emergency/regions.ts`.
- The pixel readers: `src/image/{table,grid,queue-table,glyphs,cards,template-codec,digit-model}.ts` and `scripts/train-digits.ts`. The PNG and JPEG decoders stay, for compaction.
- Structured sources are unchanged: JSON APIs (YASNO, DTEK, PowerOn, Sumy, Mykolaiv, …), HTML tables, PDF address lists.
