import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFiles, mockAuth, testPaths } = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".cursor-detection-test");
  const home = join(root, "home");
  const config = join(root, "config");
  return {
    mockFiles: new Map<string, string>(),
    mockAuth: { value: null as Record<string, unknown> | null },
    testPaths: {
      home,
      credentialDatabase: join(root, "opencode.db"),
      cursorAuth: join(home, ".config", "cursor", "auth.json"),
      config,
      opencodeConfig: join(config, "opencode.json"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      state: join(root, "state"),
    },
  };
});

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => mockFiles.has(path)),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    if (!mockFiles.has(path)) {
      throw new Error(`missing: ${path}`);
    }
    return mockFiles.get(path)!;
  }),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => testPaths.home,
    platform: () => "linux",
  };
});

vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: () => [testPaths.credentialDatabase],
  readAuthFile: vi.fn(async () => mockAuth.value),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: testPaths.data,
    configDir: testPaths.config,
    cacheDir: testPaths.cache,
    stateDir: testPaths.state,
  }),
}));

describe("cursor detection", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockAuth.value = null;
    vi.resetModules();
    delete process.env.CURSOR_ACP_HOME_DIR;
  });

  it("prefers the Cursor OAuth credential in the OpenCode database", async () => {
    mockFiles.set(testPaths.credentialDatabase, "");
    mockAuth.value = {
      cursor: {
        type: "oauth",
        refresh: "refresh-token",
      },
    };
    mockFiles.set(testPaths.cursorAuth, JSON.stringify({ accessToken: "legacy-token" }));

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("present");
    expect(result.selectedPath).toBe(testPaths.credentialDatabase);
    expect(result.presentPaths).toContain(testPaths.credentialDatabase);
    expect(result.presentPaths).toContain(testPaths.cursorAuth);
  });

  it("falls back to Cursor's own auth file when the database credential is invalid", async () => {
    mockFiles.set(testPaths.credentialDatabase, "");
    mockAuth.value = { cursor: { type: "oauth" } };
    mockFiles.set(testPaths.cursorAuth, JSON.stringify({ accessToken: "legacy-token" }));

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("present");
    expect(result.selectedPath).toBe(testPaths.cursorAuth);
  });

  it("reports an invalid Cursor credential in the OpenCode database", async () => {
    mockFiles.set(testPaths.credentialDatabase, "");
    mockAuth.value = { cursor: { type: "oauth" } };

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("invalid");
    expect(result.selectedPath).toBe(testPaths.credentialDatabase);
    expect(result.error).toBe(
      "Cursor credential in the OpenCode database is missing a valid oauth token payload",
    );
  });

  it("detects the canonical Cursor companion package and provider.cursor config", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugin: ["@playwo/opencode-cursor-oauth"],
        provider: {
          cursor: {
            name: "Cursor",
          },
        },
      }),
    );

    const { CURSOR_CANONICAL_PLUGIN_PACKAGE, inspectCursorOpenCodeIntegration } = await import(
      "../src/lib/cursor-detection.js"
    );
    const result = await inspectCursorOpenCodeIntegration();

    expect(CURSOR_CANONICAL_PLUGIN_PACKAGE).toBe("@playwo/opencode-cursor-oauth");
    expect(result.pluginEnabled).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });

  it("detects the Cursor companion and provider in OpenCode 2 native plugins and providers", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugins: [{ package: "@playwo/opencode-cursor-oauth", options: {} }],
        providers: { cursor: { name: "Cursor" } },
      }),
    );

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorOpenCodeIntegration();

    expect(result.pluginEnabled).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });

  it("keeps legacy Cursor plugin names as compatibility aliases", async () => {
    const aliases = [
      "opencode-cursor-oauth",
      "opencode-cursor",
      "cursor-acp",
      "open-cursor",
      "@rama_nigg/open-cursor",
      "PoolPirate/opencode-cursor",
    ];

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");

    for (const alias of aliases) {
      mockFiles.clear();
      mockFiles.set(
        testPaths.opencodeConfig,
        JSON.stringify({
          plugin: [alias],
        }),
      );

      const result = await inspectCursorOpenCodeIntegration();

      expect(result.pluginEnabled, alias).toBe(true);
      expect(result.providerConfigured, alias).toBe(false);
      expect(result.matchedPaths, alias).toEqual([testPaths.opencodeConfig]);
    }
  });

  it("detects legacy cursor runtime ids in provider config without treating them as plugins", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugin: ["some-other-plugin"],
        provider: {
          "cursor-acp": {
            name: "Cursor ACP",
          },
        },
      }),
    );

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorOpenCodeIntegration();

    expect(result.pluginEnabled).toBe(false);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });
});
