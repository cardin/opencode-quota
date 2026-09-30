import type { CredentialValue, IntegrationDomain, IntegrationDraft } from "./types.js";
/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `auth` hook (`methods` + `loader`).
 *
 * Unlike the 1.18 v2 API (where OAuth registration is Effect-valued), 2.0 takes
 * plain Promises, so the PKCE flow from `src/auth.ts` ports across unchanged.
 */
export declare const CURSOR_OAUTH_METHOD_ID = "oauth";
/** Env vars that can supply a Cursor API key without running /connect. */
export declare const CURSOR_ENV_NAMES: string[];
/** Register the Cursor integration and its three connection methods. */
export declare function applyCursorIntegration(draft: IntegrationDraft): void;
/**
 * Turn a stored credential into a Cursor access token.
 *
 * OAuth credentials already hold a JWT (the host refreshes them via `refresh`
 * above). A `key` credential is the raw `crsr_…` API key, which Cursor requires us
 * to exchange for a short-lived JWT — mirroring the classic plugin's behavior.
 */
export declare function accessTokenFromCredential(credential: CredentialValue | undefined): Promise<string | undefined>;
/** Resolve the active Cursor connection into an access token, if any. */
export declare function resolveCursorAccessToken(integration: IntegrationDomain): Promise<string | undefined>;
