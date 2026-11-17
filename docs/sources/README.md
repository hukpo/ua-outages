# Source notes

How each grid operator publishes its schedule and address lookup: endpoints, formats, quirks and
failure modes, as found while writing the providers (November 2026). Read the region's note before
fixing a broken provider. Notes marked UNVERIFIED were not confirmed against a live response.

The real responses used as test fixtures are in `test/fixtures/<region>/`.

Emergency schedules (ГАВ / СГАВ / АЧР) for all regions: [emergency.md](emergency.md).

АТ «Укрзалізниця» (`uz-*`, one page per oblast): [uz.md](uz.md).

Which channel each operator publishes on first, and how complete the address sources are, was measured in November 2026; each region's note gives the result. The raw measurements are in `research/freshness/` (`CHANNELS-A.md`, `CHANNELS-B.md`, `ADDRESS-COVERAGE.md`, saved responses per region) and `research/aggregators/FRESHNESS.md` (how the official channels compare with third-party aggregators, which the SDK doesn't read). `research/` is in `.gitignore`: it exists only in the working copy the research was done in.
