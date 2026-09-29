/**
 * OpenCode auth reader (legacy `auth.json` + OpenCode 2 credential store)
 *
 * Reads provider credentials from `~/.local/share/opencode/auth.json`
 * (or platform equivalent) and layers the OpenCode 2 `credential` table of
 * `opencode.db` on top of it: v2 entries are authoritative per integration id
 * because OpenCode refreshes OAuth tokens in the database, while keys that only
 * exist in the legacy file keep working as a fallback. Providers should prefer
 * this to duplicating file/path parsing.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import {
  type OpenCodeCredentialEntry,
  readOpenCodeCredentialsCached,
} from "./opencode-credential-store.js";
import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "./opencode-runtime-paths.js";

import type { AuthData } from "./types.js";

export {
  clearOpenCodeCredentialCacheForTests,
  getExistingOpenCodeCredentialPaths,
  normalizeStoredCredential,
  OPENCODE_CREDENTIAL_SOURCE,
  type OpenCodeCredentialEntry,
  type OpenCodeCredentialSource,
  type OpenCodeCredentials,
  readOpenCodeCredentials,
  readOpenCodeCredentialsCached,
} from "./opencode-credential-store.js";

const DEFAULT_AUTH_CACHE_MAX_AGE_MS = 5_000;

type AuthCacheEntry = {
  timestamp: number;
  value: AuthData | null;
  inFlight?: Promise<AuthData | null>;
};

let authCache: AuthCacheEntry | null = null;

/**
 * Get candidate auth.json paths in priority order.
 * Some OpenCode installations use Linux-style paths even on macOS,
 * so we check multiple locations.
 */
export function getAuthPaths(): string[] {
  // OpenCode stores auth at `${Global.Path.data}/auth.json`.
  // We generate candidates based on OpenCode runtime dir semantics (xdg-basedir)
  // plus platform fallbacks for alternate/legacy installs.
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  return dataDirs.map((d) => join(d, "auth.json"));
}

/** Returns OpenCode's primary auth.json path (for display/logging) */
export function getAuthPath(): string {
  return join(getOpencodeRuntimeDirs().dataDir, "auth.json");
}

async function readLegacyAuthFile(): Promise<AuthData | null> {
  const paths = getAuthPaths();

  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as AuthData;
    } catch {
      // Try next path
    }
  }

  return null;
}

/** Credential fields a v2 store row replaces wholesale when merging. */
const CREDENTIAL_FIELDS = ["type", "key", "access", "refresh", "expires"];

/**
 * Merge one OpenCode 2 credential-store entry over its legacy `auth.json` entry.
 *
 * The stored row wins for every credential field it carries (OpenCode refreshes
 * OAuth tokens in the database), while non-credential metadata from `auth.json`
 * (for example `email` or an enterprise host) survives when the row omits it.
 * Legacy credential fields are dropped so a stale file token can never mix with
 * the stored credential of the same integration id.
 */
function mergeStoredAuthEntry(
  legacy: Record<string, unknown> | undefined,
  stored: OpenCodeCredentialEntry,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(legacy ?? {})) {
    if (CREDENTIAL_FIELDS.includes(key)) continue;
    merged[key] = value;
  }
  return { ...merged, ...stored };
}

/**
 * Read provider auth from the OpenCode 2 credential store, falling back to the
 * legacy `auth.json`.
 *
 * Returns `null` only when neither source yields any credential.
 */
export async function readAuthFile(params?: { maxAgeMs?: number }): Promise<AuthData | null> {
  const legacy = await readLegacyAuthFile();

  let stored: Record<string, OpenCodeCredentialEntry> | null = null;
  try {
    stored = await readOpenCodeCredentialsCached({ maxAgeMs: params?.maxAgeMs ?? 0 });
  } catch {
    // A missing/unreadable opencode.db must never block the legacy file.
    stored = null;
  }
  if (!stored || Object.keys(stored).length === 0) return legacy;

  const legacyRecord = (legacy ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...legacyRecord };
  for (const [integrationId, entry] of Object.entries(stored)) {
    merged[integrationId] = mergeStoredAuthEntry(
      legacyRecord[integrationId] as Record<string, unknown> | undefined,
      entry,
    );
  }
  return merged as AuthData;
}

/**
 * Cached auth reader for frequently triggered code paths (e.g. per-question hooks).
 * This avoids repeated filesystem reads while keeping auth updates visible quickly.
 */
export async function readAuthFileCached(params?: { maxAgeMs?: number }): Promise<AuthData | null> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_AUTH_CACHE_MAX_AGE_MS);
  const now = Date.now();

  if (authCache && now - authCache.timestamp <= maxAgeMs) {
    return authCache.value;
  }

  if (authCache?.inFlight) {
    return authCache.inFlight;
  }

  const inFlight = (async () => {
    const value = await readAuthFile({ maxAgeMs });
    authCache = { timestamp: Date.now(), value };
    return value;
  })();

  authCache = {
    timestamp: authCache?.timestamp ?? 0,
    value: authCache?.value ?? null,
    inFlight,
  };

  try {
    return await inFlight;
  } finally {
    if (authCache?.inFlight === inFlight) {
      authCache.inFlight = undefined;
    }
  }
}

/** Test helper to clear cached auth state between test cases. */
export function clearReadAuthFileCacheForTests(): void {
  authCache = null;
}
