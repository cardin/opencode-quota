/**
 * OpenCode v2 credential store reader.
 *
 * OpenCode 2 keeps provider credentials in the `credential` table of
 * `opencode.db` (`packages/core/src/credential.ts`). Each row stores an
 * `integration_id` and a JSON `value` that is either:
 *
 *   { "type": "key",   "key": "oc_..." }            // API key
 *   { "type": "oauth", "access": "...", ... }        // OAuth token set
 *
 * This supersedes the legacy `auth.json` file for providers migrated by the
 * v1 -> v2 data migration. Reads are best-effort and read-only: any failure
 * yields `null` so callers can fall back to legacy sources.
 */

import { existsSync } from "fs";
import { openOpenCodeSqliteReadOnly } from "./opencode-sqlite.js";
import { getOpenCodeDbPathCandidates } from "./opencode-storage.js";

/** Source label used when a credential is resolved from the v2 store. */
export const OPENCODE_CREDENTIAL_SOURCE = "opencode.credentials" as const;
export type OpenCodeCredentialSource = typeof OPENCODE_CREDENTIAL_SOURCE;

const DEFAULT_CACHE_MAX_AGE_MS = 5_000;

/** Normalized credential entry keyed by integration id. */
export type OpenCodeCredentialEntry = Record<string, unknown>;
export type OpenCodeCredentials = Record<string, OpenCodeCredentialEntry>;

type CredentialRow = {
  integration_id?: unknown;
  value?: unknown;
};

type CacheEntry = {
  timestamp: number;
  value: OpenCodeCredentials | null;
  inFlight?: Promise<OpenCodeCredentials | null>;
};

let credentialCache: CacheEntry | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseStoredValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Normalize a stored v2 credential value into the legacy `auth.json` shape so
 * existing auth consumers can use it without special-casing the v2 format.
 *
 * Returns null for malformed or unsupported entries.
 */
export function normalizeStoredCredential(raw: unknown): OpenCodeCredentialEntry | null {
  const record = asRecord(parseStoredValue(raw));
  if (!record) return null;

  if (record.type === "key") {
    const key = typeof record.key === "string" ? record.key.trim() : "";
    return key ? { type: "api", key } : null;
  }

  if (record.type === "oauth") {
    const access = typeof record.access === "string" ? record.access : "";
    if (!access) return null;
    const refresh = typeof record.refresh === "string" ? record.refresh : "";
    const expires = typeof record.expires === "number" ? record.expires : 0;
    return { type: "oauth", access, refresh, expires };
  }

  return null;
}

async function readCredentialsFromDb(): Promise<OpenCodeCredentials | null> {
  for (const dbPath of getOpenCodeDbPathCandidates()) {
    let conn: Awaited<ReturnType<typeof openOpenCodeSqliteReadOnly>> | null = null;
    try {
      conn = await openOpenCodeSqliteReadOnly(dbPath);
    } catch {
      continue;
    }

    try {
      const rows = conn.all<CredentialRow>(
        "SELECT integration_id, value FROM credential ORDER BY time_created ASC",
      );
      const credentials: OpenCodeCredentials = {};
      for (const row of rows) {
        const integrationId =
          typeof row.integration_id === "string" ? row.integration_id.trim() : "";
        if (!integrationId) continue;
        const entry = normalizeStoredCredential(row.value);
        if (entry) credentials[integrationId] = entry;
      }
      return credentials;
    } catch {
    } finally {
      conn.close();
    }
  }

  return null;
}

/** Read every v2 credential, keyed by integration id. */
export async function readOpenCodeCredentials(): Promise<OpenCodeCredentials | null> {
  return readCredentialsFromDb();
}

/**
 * Cached v2 credential reader for hot paths. Keeps credentials fresh within
 * `maxAgeMs` while avoiding repeated SQLite opens.
 */
export async function readOpenCodeCredentialsCached(params?: {
  maxAgeMs?: number;
}): Promise<OpenCodeCredentials | null> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();

  if (credentialCache && now - credentialCache.timestamp <= maxAgeMs) {
    return credentialCache.value;
  }

  if (credentialCache?.inFlight) {
    return credentialCache.inFlight;
  }

  const inFlight = (async () => {
    const value = await readCredentialsFromDb().catch(() => null);
    credentialCache = { timestamp: Date.now(), value };
    return value;
  })();

  credentialCache = {
    timestamp: credentialCache?.timestamp ?? 0,
    value: credentialCache?.value ?? null,
    inFlight,
  };

  try {
    return await inFlight;
  } finally {
    if (credentialCache?.inFlight === inFlight) {
      credentialCache.inFlight = undefined;
    }
  }
}

/** Candidate `opencode.db` paths that exist on disk (for diagnostics). */
export function getExistingOpenCodeCredentialPaths(): string[] {
  return getOpenCodeDbPathCandidates().filter((path) => existsSync(path));
}

/** Test helper to clear cached credential state between test cases. */
export function clearOpenCodeCredentialCacheForTests(): void {
  credentialCache = null;
}
