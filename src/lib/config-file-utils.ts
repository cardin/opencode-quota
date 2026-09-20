import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export type ConfigFileKind = "opencode" | "tui";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  sourcePath: string;
  format: ConfigFileFormat;
  existed: boolean;
  removeSourcePath?: string;
}

export interface RuntimeContextRootHints {
  workspaceRoot?: string | null;
  worktreeRoot?: string | null;
  activeDirectory?: string | null;
  configRoot?: string | null;
  fallbackDirectory: string;
}

export interface RuntimeContextRoots {
  workspaceRoot: string;
  configRoot: string;
}

export function dedupeNonEmptyStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function pickFirstNonEmptyString(items: Array<string | null | undefined>): string | null {
  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Returns the effective config root directory.
 *
 * Priority:
 * 1. `OPENCODE_CONFIG_DIR` environment variable (if set and non-empty)
 * 2. The provided fallback directory
 *
 * This matches OpenCode's own behavior: when `OPENCODE_CONFIG_DIR` is set,
 * config files are resolved relative to it rather than the current working directory.
 */
export function getEffectiveConfigRoot(fallback: string): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (!envDir) {
    return fallback;
  }

  if (isAbsolute(envDir)) {
    return envDir;
  }

  return resolve(fallback, envDir);
}

export function resolveRuntimeContextRoots(params: RuntimeContextRootHints): RuntimeContextRoots {
  const workspaceRoot =
    pickFirstNonEmptyString([
      params.workspaceRoot,
      params.worktreeRoot,
      params.activeDirectory,
      params.fallbackDirectory,
    ]) ?? params.fallbackDirectory;
  const explicitConfigRoot = pickFirstNonEmptyString([params.configRoot]);
  const computedConfigRoot =
    pickFirstNonEmptyString([workspaceRoot, params.activeDirectory]) ?? workspaceRoot;
  const configRoot = explicitConfigRoot ?? getEffectiveConfigRoot(computedConfigRoot);

  return { workspaceRoot, configRoot };
}

export function findGitWorktreeRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getConfigFileCandidatePaths(dir: string, kind: ConfigFileKind): string[] {
  return [join(dir, `${kind}.jsonc`), join(dir, `${kind}.json`)];
}

export function resolveExistingConfigPath(dir: string, kind: ConfigFileKind): string | null {
  return getConfigFileCandidatePaths(dir, kind).find((path) => existsSync(path)) ?? null;
}

export function resolveEditableConfigPath(params: {
  dir: string;
  kind: ConfigFileKind;
  preferredFormat?: ConfigFileFormat;
  convertJsonToJsonc?: boolean;
}): EditableConfigPath {
  const jsoncPath = join(params.dir, `${params.kind}.jsonc`);
  if (existsSync(jsoncPath)) {
    return {
      path: jsoncPath,
      sourcePath: jsoncPath,
      format: "jsonc",
      existed: true,
    };
  }

  const jsonPath = join(params.dir, `${params.kind}.json`);
  if (existsSync(jsonPath)) {
    if (params.preferredFormat === "jsonc" && params.convertJsonToJsonc) {
      return {
        path: jsoncPath,
        sourcePath: jsonPath,
        format: "jsonc",
        existed: true,
        removeSourcePath: jsonPath,
      };
    }

    return {
      path: jsonPath,
      sourcePath: jsonPath,
      format: "json",
      existed: true,
    };
  }

  const format = params.preferredFormat ?? "jsonc";
  const path = join(params.dir, `${params.kind}.${format}`);
  return {
    path,
    sourcePath: path,
    format,
    existed: false,
  };
}

export function getPluginSpecFromEntry(entry: unknown): string | null {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : null;

  if (typeof spec !== "string") {
    return null;
  }

  const trimmed = spec.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Plugin and provider maps use different key names in OpenCode V1 (`plugin`,
 * `provider`) and OpenCode V2 (`plugins`, `providers`). V2 reads both shapes.
 * Every key is listed here so readers and writers stay in sync.
 */
export const PLUGIN_CONFIG_KEYS = ["plugins", "plugin"] as const;
export const PROVIDER_CONFIG_KEYS = ["providers", "provider"] as const;

export type PluginConfigKey = (typeof PLUGIN_CONFIG_KEYS)[number];
export type ProviderConfigKey = (typeof PROVIDER_CONFIG_KEYS)[number];

/**
 * Picks the key to write for a plugin container, preferring the native V2
 * `plugins` key and falling back to legacy `plugin`. New documents default to
 * `plugins`.
 */
export function resolvePluginConfigKey(root: Record<string, unknown>): PluginConfigKey {
  if (root.plugins !== undefined) {
    return "plugins";
  }
  if (root.plugin !== undefined) {
    return "plugin";
  }
  return "plugins";
}

/**
 * Picks the key to write for a provider map, preferring the native V2
 * `providers` key and falling back to legacy `provider`. New documents default
 * to `providers`.
 */
export function resolveProviderConfigKey(root: Record<string, unknown>): ProviderConfigKey {
  if (root.providers !== undefined) {
    return "providers";
  }
  if (root.provider !== undefined) {
    return "provider";
  }
  return "providers";
}

function collectArrayEntries(target: Record<string, unknown>, keys: readonly string[]): unknown[] {
  const entries: unknown[] = [];
  for (const key of keys) {
    const value = target[key];
    if (Array.isArray(value)) {
      entries.push(...value);
    }
  }
  return entries;
}

export function extractPluginSpecsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const pluginEntries = collectArrayEntries(root, PLUGIN_CONFIG_KEYS);

  if (root.tui && typeof root.tui === "object" && !Array.isArray(root.tui)) {
    pluginEntries.push(
      ...collectArrayEntries(root.tui as Record<string, unknown>, PLUGIN_CONFIG_KEYS),
    );
  }

  return dedupeNonEmptyStrings(
    pluginEntries
      .map((entry) => getPluginSpecFromEntry(entry))
      .filter((entry): entry is string => typeof entry === "string"),
  );
}

export function extractProviderIdsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const providerIds: string[] = [];
  for (const key of PROVIDER_CONFIG_KEYS) {
    const value = root[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      providerIds.push(...Object.keys(value));
    }
  }

  return dedupeNonEmptyStrings(providerIds);
}

export function isQuotaPluginSpec(spec: string, kind: ConfigFileKind): boolean {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("@cardinal4/opencode-quota")) {
    return true;
  }

  if (normalized.includes("/opencode-quota") && !normalized.includes("/opencode-quota/dist/")) {
    return true;
  }

  return kind === "tui"
    ? normalized.includes("opencode-quota/dist/tui.tsx")
    : normalized.includes("opencode-quota/dist/index.js");
}
