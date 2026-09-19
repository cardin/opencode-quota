import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readOpenCodeCredentialsCached: vi.fn(),
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getAuthPaths: mocks.getAuthPaths,
  readAuthFileCached: mocks.readAuthFileCached,
  readOpenCodeCredentialsCached: mocks.readOpenCodeCredentialsCached,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/tmp/data"],
    configDirs: ["/tmp/config"],
    cacheDirs: ["/tmp/cache"],
    stateDirs: ["/tmp/state"],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/data",
    configDir: "/tmp/config",
    cacheDir: "/tmp/cache",
    stateDir: "/tmp/state",
  }),
}));

vi.mock("fs", () => ({ existsSync: vi.fn(() => false) }));

import { createProviderApiKeyResolver } from "../src/lib/api-key-resolver.js";
import { OPENCODE_CREDENTIAL_SOURCE } from "../src/lib/opencode-credential-store.js";

type SimpleSource = "env:TEST_KEY" | "auth.json" | "opencode.credentials";
type InvalidSource = "auth.json" | "opencode.credentials";

function createSimpleResolver(readAuth: () => Promise<unknown | null>) {
  return createProviderApiKeyResolver<SimpleSource>({
    envVars: [{ name: "TEST_KEY", source: "env:TEST_KEY" }],
    providerKeys: ["provider"],
    configJsonSource: "auth.json",
    configJsoncSource: "auth.json",
    getConfigCandidates: () => [],
    auth: {
      readAuth,
      authKeys: ["provider"],
      authSource: "auth.json",
    },
  });
}

function createInvalidAwareResolver(readAuth: (maxAgeMs: number) => Promise<unknown | null>) {
  return createProviderApiKeyResolver<InvalidSource, InvalidSource>({
    envVars: [],
    providerKeys: ["provider"],
    configJsonSource: "auth.json",
    configJsoncSource: "auth.json",
    getConfigCandidates: () => [],
    auth: {
      policy: "invalid-aware-api-key",
      authKeys: ["provider"],
      authSource: "auth.json",
      displayName: "Provider",
      defaultMaxAgeMs: 5_000,
      readAuth,
      getAuthPaths: () => ["/tmp/auth.json"],
    },
  });
}

describe("api-key-resolver v2 credential store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TEST_KEY;
    mocks.readOpenCodeCredentialsCached.mockResolvedValue(null);
  });

  it("prefers a v2 key credential over auth.json", async () => {
    mocks.readOpenCodeCredentialsCached.mockResolvedValue({
      provider: { type: "api", key: "oc_v2_key" },
    });
    const readAuth = vi.fn().mockResolvedValue({ provider: { type: "api", key: "auth-key" } });

    await expect(createSimpleResolver(readAuth).resolve()).resolves.toEqual({
      key: "oc_v2_key",
      source: OPENCODE_CREDENTIAL_SOURCE,
    });
    expect(readAuth).not.toHaveBeenCalled();
  });

  it("keeps environment ahead of the v2 credential store", async () => {
    process.env.TEST_KEY = "env-key";
    mocks.readOpenCodeCredentialsCached.mockResolvedValue({
      provider: { type: "api", key: "oc_v2_key" },
    });

    await expect(createSimpleResolver(vi.fn()).resolve()).resolves.toEqual({
      key: "env-key",
      source: "env:TEST_KEY",
    });
    expect(mocks.readOpenCodeCredentialsCached).not.toHaveBeenCalled();
  });

  it("ignores v2 oauth entries and falls back to auth.json", async () => {
    mocks.readOpenCodeCredentialsCached.mockResolvedValue({
      provider: { type: "oauth", access: "token" },
    });
    const readAuth = vi.fn().mockResolvedValue({ provider: { type: "api", key: "auth-key" } });

    await expect(createSimpleResolver(readAuth).resolve()).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
    expect(readAuth).toHaveBeenCalledOnce();
  });

  it("falls back to auth.json when the v2 store is unavailable", async () => {
    mocks.readOpenCodeCredentialsCached.mockResolvedValue(null);
    const readAuth = vi.fn().mockResolvedValue({ provider: { type: "api", key: "auth-key" } });

    await expect(createSimpleResolver(readAuth).resolve()).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
  });

  it("resolves invalid-aware providers from the v2 store with diagnostics source", async () => {
    mocks.readOpenCodeCredentialsCached.mockResolvedValue({
      provider: { type: "api", key: "oc_v2_key" },
    });
    const readAuth = vi.fn().mockResolvedValue(null);
    const resolver = createInvalidAwareResolver(readAuth);

    await expect(resolver.resolve()).resolves.toEqual({
      state: "configured",
      apiKey: "oc_v2_key",
    });
    await expect(resolver.diagnostics()).resolves.toEqual({
      state: "configured",
      source: OPENCODE_CREDENTIAL_SOURCE,
      checkedPaths: [],
      authPaths: ["/tmp/auth.json"],
    });
    expect(readAuth).not.toHaveBeenCalled();
  });

  it("preserves invalid-aware auth.json behavior when v2 has no key", async () => {
    mocks.readOpenCodeCredentialsCached.mockResolvedValue({ provider: { type: "oauth" } });
    const resolver = createInvalidAwareResolver(
      vi.fn().mockResolvedValue({ provider: { type: "api", key: "auth-key" } }),
    );

    await expect(resolver.resolve()).resolves.toEqual({
      state: "configured",
      apiKey: "auth-key",
    });
    await expect(resolver.diagnostics()).resolves.toEqual({
      state: "configured",
      source: "auth.json",
      checkedPaths: [],
      authPaths: ["/tmp/auth.json"],
    });
  });
});
