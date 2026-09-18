/**
 * OpenCode Quota Plugin (OpenCode 2)
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */

export type {
  JsonV1Adapter,
  JsonV1Mapping,
  JsonV1Metric,
  JsonV1NumberSource,
  JsonV1Path,
  JsonV1TextSource,
  JsonV1TimestampEncoding,
  JsonV1TimestampSource,
  LocalEstimateQuotaProviderDefinition,
  LocalEstimateWindow,
  QuotaProviderDefinition,
  QuotaProviderRemoteFormat,
  RemoteApiQuotaProviderDefinition,
} from "./lib/quota-providers.js";
// Re-export types for consumers (types are erased at runtime, so safe to export)
export {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  QUOTA_PROVIDER_WINDOW_TYPES,
  validateQuotaProviders,
} from "./lib/quota-providers.js";
export type {
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
  GoogleModelId,
  GoogleModelQuota,
  GoogleQuotaResult,
  MaintainerAnnouncementsConfig,
  MiniMaxResult,
  MiniMaxResultEntry,
  PricingSnapshotSource,
  QuotaToastConfig,
  SessionTokenScope,
} from "./lib/types.js";
export { QUOTA_PLUGIN_ID, QuotaToastPlugin, QuotaToastPlugin as default } from "./plugin.js";
