import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { getPluginSpecFromEntry } from "./config-file-utils.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import type { CursorAuthData } from "./types.js";

export interface CursorAuthPresence {
  state: "missing" | "present" | "invalid";
  selectedPath?: string;
  presentPaths: string[];
  candidatePaths: string[];
  error?: string;
}

export interface CursorOpenCodeIntegration {
  pluginEnabled: boolean;
  providerConfigured: boolean;
  matchedPaths: string[];
  checkedPaths: string[];
}

export const CURSOR_CANONICAL_PLUGIN_PACKAGE = "cursor-opencode-provider";
/**
 * `cursor-opencode-provider` specs: the bare package (OpenCode 2 resolves its `./server`
 * export), its OpenCode 2 entry `/plugin/opencode2`, or `/server`, each optionally
 * version-pinned on the package or the entry, e.g. `cursor-opencode-provider@0.7.3/plugin/opencode2`.
 */
const CURSOR_PLUGIN_SPEC_PATTERN =
  /^cursor-opencode-provider(@[^/]+)?(\/plugin\/opencode2|\/server)?(@[^/]+)?$/;
const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getCursorHomeDir(): string {
  return process.env.CURSOR_ACP_HOME_DIR?.trim() || homedir();
}

export function getCursorAuthCandidatePaths(): string[] {
  const home = getCursorHomeDir();
  const authFiles = ["cli-config.json", "auth.json"];
  const paths: string[] = [];

  if (platform() === "darwin") {
    for (const file of authFiles) paths.push(join(home, ".cursor", file));
    for (const file of authFiles) paths.push(join(home, ".config", "cursor", file));
  } else {
    for (const file of authFiles) paths.push(join(home, ".config", "cursor", file));

    const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome && xdgConfigHome !== join(home, ".config")) {
      for (const file of authFiles) paths.push(join(xdgConfigHome, "cursor", file));
    }

    for (const file of authFiles) paths.push(join(home, ".cursor", file));
  }

  return dedupe(paths);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** OpenCode 2 stores Cursor OAuth tokens as `oauth`, and an API key `key` credential that our reader maps to `api`. */
function isValidCursorCredential(value: unknown): value is CursorAuthData {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.type === "oauth") {
    return hasNonEmptyString(entry.refresh) || hasNonEmptyString(entry.access);
  }
  return entry.type === "api" && hasNonEmptyString(entry.key);
}

export async function inspectCursorAuthPresence(): Promise<CursorAuthPresence> {
  const credentialDatabasePaths = getCredentialDatabasePaths();
  const legacyCandidatePaths = getCursorAuthCandidatePaths();
  const candidatePaths = dedupe([...credentialDatabasePaths, ...legacyCandidatePaths]);
  const presentPaths = candidatePaths.filter((path) => existsSync(path));
  const credentialDatabasePath = credentialDatabasePaths.find((path) => existsSync(path));
  let invalidPath: string | undefined;
  let invalidError: string | undefined;

  const cursorAuth = (await readAuthFile())?.cursor;
  if (cursorAuth) {
    if (isValidCursorCredential(cursorAuth)) {
      return {
        state: "present",
        selectedPath: credentialDatabasePath,
        presentPaths,
        candidatePaths,
      };
    }

    invalidPath = credentialDatabasePath;
    invalidError =
      "Cursor credential in the OpenCode database is missing a valid OAuth token or API key";
  }

  if (hasNonEmptyString(process.env[CURSOR_API_KEY_ENV])) {
    return {
      state: "present",
      selectedPath: `env:${CURSOR_API_KEY_ENV}`,
      presentPaths,
      candidatePaths,
    };
  }

  for (const path of legacyCandidatePaths) {
    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          state: "present",
          selectedPath: path,
          presentPaths,
          candidatePaths,
        };
      }
    } catch (error) {
      invalidPath ??= path;
      invalidError ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (invalidPath) {
    return {
      state: "invalid",
      selectedPath: invalidPath,
      presentPaths,
      candidatePaths,
      error: invalidError,
    };
  }

  return {
    state: "missing",
    presentPaths,
    candidatePaths,
  };
}

function pluginIncludesCursor(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return CURSOR_PLUGIN_SPEC_PATTERN.test(value.trim().toLowerCase());
}

function providerConfigIncludesCursor(value: unknown): boolean {
  const providerConfig = asRecord(value);
  if (!providerConfig) return false;
  return getQuotaProviderRuntimeIds("cursor").some((id) => Object.hasOwn(providerConfig, id));
}

/** OpenCode 2 reads both the legacy `plugin`/`provider` keys and the native `plugins`/`providers` keys. */
function parseOpenCodeConfig(
  raw: string,
  isJsonc: boolean,
): {
  plugin: unknown[];
  provider: Record<string, unknown> | null;
} {
  const parsed = asRecord(parseJsonOrJsonc(raw, isJsonc));
  const legacyProvider = asRecord(parsed?.provider);
  const nativeProviders = asRecord(parsed?.providers);
  return {
    plugin: [
      ...(Array.isArray(parsed?.plugin) ? parsed.plugin : []),
      ...(Array.isArray(parsed?.plugins) ? parsed.plugins.map(getPluginSpecFromEntry) : []),
    ],
    provider: legacyProvider || nativeProviders ? { ...legacyProvider, ...nativeProviders } : null,
  };
}

export async function inspectCursorOpenCodeIntegration(): Promise<CursorOpenCodeIntegration> {
  const { configDir } = getOpencodeRuntimeDirs();
  const checkedPaths = dedupe(
    [configDir, process.cwd()].flatMap((dir) => [
      join(dir, "opencode.json"),
      join(dir, "opencode.jsonc"),
    ]),
  );

  const matchedPaths: string[] = [];
  let pluginEnabled = false;
  let providerConfigured = false;

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, "utf8");
      const { plugin, provider } = parseOpenCodeConfig(raw, path.endsWith(".jsonc"));

      const matchedPlugin = plugin.some(pluginIncludesCursor);
      const matchedProvider = providerConfigIncludesCursor(provider);
      if (matchedPlugin || matchedProvider) {
        matchedPaths.push(path);
      }
      pluginEnabled ||= matchedPlugin;
      providerConfigured ||= matchedProvider;
    } catch {
      // Ignore invalid user configs here and let status output show missing matches.
    }
  }

  return {
    pluginEnabled,
    providerConfigured,
    matchedPaths,
    checkedPaths,
  };
}
