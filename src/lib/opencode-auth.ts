/**
 * OpenCode credential database reader
 *
 * Shared helper to read credentials from OpenCode's SQLite database.
 * Providers should prefer this to duplicating database/path parsing.
 */

import { existsSync } from "fs";

import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { openOpenCodeSqliteReadOnly, type SqliteConn } from "./opencode-sqlite.js";

import type { AuthData } from "./types.js";

const DEFAULT_AUTH_CACHE_MAX_AGE_MS = 5_000;

type AuthCacheEntry = {
  timestamp: number;
  value: AuthData | null;
  inFlight?: Promise<AuthData | null>;
};

export type CredentialRow = {
  id: string;
  integrationId: string;
  label: string;
  active: boolean;
  value: Record<string, unknown>;
};

/**
 * Connection labels OpenCode assigns when the user never named the connection:
 * `default` for a new connection, and `OAuth` / `API key` for credentials
 * imported from the legacy auth.json. They say nothing about the account, so
 * they must not appear in headers like `[OpenAI OAuth]`.
 */
const GENERIC_CREDENTIAL_LABELS: ReadonlySet<string> = new Set(["default", "oauth", "api key"]);

export function formatCredentialDisplayNames(
  providerName: string,
  credentials: ReadonlyArray<{ row: CredentialRow; fallbackName: string }>,
): string[] {
  const counts = new Map<string, number>();
  return credentials.map(({ row, fallbackName }) => {
    const alias = row.label.trim();
    const redundantAlias =
      !alias ||
      GENERIC_CREDENTIAL_LABELS.has(alias.toLowerCase()) ||
      alias.toLowerCase() === providerName.toLowerCase();
    const fallbackCategory = fallbackName
      .trim()
      .replace(new RegExp(`^${providerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*`, "iu"), "")
      .trim()
      .replace(/^\((.*)\)$/u, "$1")
      .trim();
    const aliasKey = redundantAlias ? "" : alias;
    const duplicate = aliasKey ? (counts.get(aliasKey) ?? 0) + 1 : 1;
    if (aliasKey) counts.set(aliasKey, duplicate);
    const numberedAlias = duplicate === 1 ? aliasKey : `${aliasKey} ${duplicate}`;
    const base = `[${providerName}${numberedAlias ? ` ${numberedAlias}` : ""}]`;
    const category = fallbackCategory ? ` (${fallbackCategory})` : "";
    const active = row.active || (credentials.length === 1 && !credentials[0]!.row.active);
    return `${base}${category}${active ? "*" : ""}`;
  });
}

let authCache: AuthCacheEntry | null = null;

/**
 * OpenCode credential database paths: the one resolved database, or none when
 * `OPENCODE_DB` is `:memory:`.
 */
export function getCredentialDatabasePaths(): string[] {
  const path = getOpenCodeDbPath();
  return path === ":memory:" ? [] : [path];
}

export async function readAuthFile(): Promise<AuthData | null> {
  const rows = await readCredentialRows();
  const auth: Record<string, unknown> = {};
  for (const row of rows) {
    if (!(row.integrationId in auth)) auth[row.integrationId] = row.value;
  }
  return Object.keys(auth).length > 0 ? (auth as AuthData) : null;
}

export async function readCredentialRows(): Promise<CredentialRow[]> {
  const [path] = getCredentialDatabasePaths();
  return path ? readCredentialDatabase(path) : [];
}

function canonicalCredentialValueKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCredentialValueKey(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalCredentialValueKey(nested)}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * Collapse credential rows that represent the same upstream connection.
 *
 * Rows holding identical credential values are the same connection (e.g. the
 * same workspace key stored under the `opencode-go` integration and its legacy
 * `opencode` alias), and rows under `primaryIntegrationId` take precedence over
 * alias rows so a real credential for another integration that shares the key
 * is not reported as an additional connection. Input order is preserved
 * otherwise.
 */
export function selectConnectionCredentialRows(
  rows: readonly CredentialRow[],
  primaryIntegrationId: string,
): CredentialRow[] {
  const primaryRows = rows.filter((row) => row.integrationId === primaryIntegrationId);
  const candidates = primaryRows.length > 0 ? primaryRows : [...rows];
  const seen = new Set<string>();
  const selected: CredentialRow[] = [];
  for (const row of candidates) {
    const key = canonicalCredentialValueKey(row.value);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
  }
  return selected;
}

async function readCredentialDatabase(path: string): Promise<CredentialRow[]> {
  if (!existsSync(path)) return [];

  let database: SqliteConn | undefined;
  try {
    database = await openOpenCodeSqliteReadOnly(path);
    const rows = database.all<Record<string, unknown>>(
      "SELECT id, integration_id, label, active, value FROM credential WHERE integration_id IS NOT NULL ORDER BY active DESC, time_updated DESC, id DESC",
    );
    const credentials: CredentialRow[] = [];

    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.integration_id !== "string" ||
        typeof row.label !== "string" ||
        typeof row.value !== "string"
      )
        continue;
      const value = parseCredentialValue(row.value);
      if (value) {
        credentials.push({
          id: row.id,
          integrationId: row.integration_id,
          label: row.label,
          active: row.active === 1,
          value,
        });
      }
    }

    return credentials;
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function parseCredentialValue(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const credential = parsed as Record<string, unknown>;
    const metadata = credential.metadata;
    const authEntry = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      ...credential,
    };
    if (authEntry.type === "key" && typeof authEntry.key === "string") {
      authEntry.type = "api";
    }
    return authEntry;
  } catch {
    return null;
  }
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
    const value = await readAuthFile();
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
