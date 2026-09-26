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
    delete process.env.CURSOR_API_KEY;
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
      "Cursor credential in the OpenCode database is missing a valid OAuth token or API key",
    );
  });

  it("accepts a Cursor API key credential in the OpenCode database", async () => {
    mockFiles.set(testPaths.credentialDatabase, "");
    // The credential reader maps OpenCode 2's stored `{ type: "key", key }` to `type: "api"`.
    mockAuth.value = { cursor: { type: "api", key: "crsr_test-key" } };

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("present");
    expect(result.selectedPath).toBe(testPaths.credentialDatabase);
  });

  it("reports a Cursor API key credential without a key as invalid", async () => {
    mockFiles.set(testPaths.credentialDatabase, "");
    mockAuth.value = { cursor: { type: "api", key: " " } };

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("invalid");
    expect(result.selectedPath).toBe(testPaths.credentialDatabase);
  });

  it("accepts the CURSOR_API_KEY environment variable", async () => {
    process.env.CURSOR_API_KEY = "crsr_env-key";

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("present");
    expect(result.selectedPath).toBe("env:CURSOR_API_KEY");
  });

  it("detects the cursor-opencode-provider plugin and provider.cursor config", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugin: ["cursor-opencode-provider/plugin/opencode2"],
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

    expect(CURSOR_CANONICAL_PLUGIN_PACKAGE).toBe("cursor-opencode-provider");
    expect(result.pluginEnabled).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });

  it("detects the Cursor plugin and provider in OpenCode 2 native plugins and providers", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugins: [{ package: "cursor-opencode-provider/plugin/opencode2", options: {} }],
        providers: { cursor: { name: "Cursor" } },
      }),
    );

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorOpenCodeIntegration();

    expect(result.pluginEnabled).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });

  it("detects every cursor-opencode-provider entry and version-pinned spec", async () => {
    const specs = [
      "cursor-opencode-provider",
      "cursor-opencode-provider/plugin/opencode2",
      "cursor-opencode-provider/server",
      "cursor-opencode-provider@0.7.3",
      "cursor-opencode-provider@latest/plugin/opencode2",
      "cursor-opencode-provider/plugin/opencode2@0.7.3",
      "cursor-opencode-provider@0.7.3/server",
      " Cursor-OpenCode-Provider/Plugin/OpenCode2 ",
    ];

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");

    for (const spec of specs) {
      mockFiles.clear();
      mockFiles.set(testPaths.opencodeConfig, JSON.stringify({ plugin: [spec] }));

      const result = await inspectCursorOpenCodeIntegration();

      expect(result.pluginEnabled, spec).toBe(true);
      expect(result.providerConfigured, spec).toBe(false);
      expect(result.matchedPaths, spec).toEqual([testPaths.opencodeConfig]);
    }
  });

  it("no longer detects OpenCode 1-only Cursor companions or other entries", async () => {
    const specs = [
      "@playwo/opencode-cursor-oauth",
      "opencode-cursor-oauth",
      "opencode-cursor",
      "cursor-acp",
      "open-cursor",
      "@rama_nigg/open-cursor",
      "PoolPirate/opencode-cursor",
      "cursor-opencode-provider/plugin",
      "cursor-opencode-provider/plugin/v2",
      "@someone/cursor-opencode-provider",
    ];

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");

    for (const spec of specs) {
      mockFiles.clear();
      mockFiles.set(testPaths.opencodeConfig, JSON.stringify({ plugin: [spec] }));

      const result = await inspectCursorOpenCodeIntegration();

      expect(result.pluginEnabled, spec).toBe(false);
      expect(result.matchedPaths, spec).toEqual([]);
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
