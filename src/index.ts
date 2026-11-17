export { OutageClient } from './client.js'
export type {
  EmergencyOptions,
  HealthCheckOptions,
  HealthReport,
  OutageClientOptions,
  ScheduleOptions,
  SearchOptions,
  StaleIfError,
} from './client.js'
export { OutageError, isOutageError } from './errors.js'
export { assessFreshness } from './freshness.js'
export type { FreshnessOptions } from './freshness.js'
export { fuzzyScore, rankByName } from './fuzzy.js'
export type { NameKind } from './fuzzy.js'
export type { OutageErrorCode } from './errors.js'
export type { FetchLike } from './http.js'
export { createProviders } from './providers/index.js'
export type { Provider, ProviderContext } from './providers/provider.js'
export { mergeSources } from './providers/sources.js'
export type { MergeOptions, SourceRead, SourceSpec } from './providers/sources.js'
export { compareGroups, intervalAt, minutesOf, nextOutage, normalizeGroup, stateAt } from './schedule.js'
export type { PowerState } from './schedule.js'
export { kyivDate } from './time.js'
export type * from './types.js'
export { validateSchedule } from './validate.js'
