/**
 * OpenCode 2 adapter for the quota runtime client.
 *
 * The quota engine (`loadConfig`, provider definitions, telemetry) was written
 * against a narrow slice of the OpenCode 1 SDK client:
 *
 * - `client.config.get()`       -> legacy `experimental.quotaToast` fallback
 * - `client.config.providers()` -> known provider ids for auto-detection
 *
 * OpenCode 2 splits those capabilities across the plugin context. These helpers
 * rebuild the V1-shaped slice from V2 data so the engine stays untouched.
 */

import type { QuotaRuntimeClient } from "./quota-runtime-context.js";

/** Minimal shape returned by `QuotaRuntimeClient["config"]["providers"]`. */
export type QuotaProviderIdList = Array<{ id: string }>;

export type ProviderIdSource = {
  providerList: () => Promise<{ data?: Array<{ id: string }> }>;
};

/**
 * Build a `QuotaRuntimeClient` compatible object from a V2 provider list source.
 *
 * `config.get()` intentionally returns an empty object: in OpenCode 2 the
 * plugin-specific configuration is read from the `opencode-quota/*.jsonc`
 * sidecar and from `experimental.quotaToast` in discovered OpenCode config
 * files, both of which `loadConfig` already reads from disk before it ever
 * consults the client fallback. There is no V2 equivalent of the V1
 * `client.config.get()` payload that also carries `experimental.quotaToast`.
 */
export function createV2QuotaClient(source: ProviderIdSource): QuotaRuntimeClient {
  return {
    config: {
      get: async () => ({ data: {} }),
      providers: async () => {
        try {
          const response = await source.providerList();
          return { data: { providers: response.data ?? [] } };
        } catch {
          return { data: { providers: [] } };
        }
      },
    },
  };
}
