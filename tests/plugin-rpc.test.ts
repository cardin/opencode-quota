import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-rpc-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
  reconcileDetectedProvidersInGlobalConfig: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);
vi.mock("../src/lib/opencode-config-providers.js", () => ({
  reconcileDetectedProvidersInGlobalConfig: mocks.reconcileDetectedProvidersInGlobalConfig,
}));

type Handler = (input: unknown, context: unknown) => Promise<unknown>;
type RegisteredCommand = {
  name: string;
  execute: (invocation: { sessionID: string; prompt: { text: string } }) => Promise<void>;
};

const callContext = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data?: unknown) => ({ type, message, data }),
};

function useConfig(overrides: Partial<typeof DEFAULT_CONFIG>): void {
  mocks.loadConfig.mockResolvedValue(
    makeQuotaToastTestConfig({
      enabled: true,
      enabledProviders: ["copilot"],
      minIntervalMs: 0,
      showSessionTokens: false,
      maintainerAnnouncements: { enabled: false, home: false },
      ...overrides,
    }),
  );
}

async function setupServer(sessionGet = vi.fn().mockResolvedValue({})) {
  const { default: server } = await import("../src/plugin.js");
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } }));
  const commands: RegisteredCommand[] = [];
  const ctx = {
    location: { directory: process.cwd() },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "copilot" }] }) },
    session: { get: sessionGet, wait: vi.fn(), prompt: vi.fn(), hook: vi.fn() },
    tool: { transform: vi.fn() },
    command: {
      transform: vi.fn(async (callback) => {
        callback({ add: (command: RegisteredCommand) => commands.push(command) });
      }),
    },
    rpc: { register },
  };
  await server.setup(ctx as never);
  expect(register).toHaveBeenCalledOnce();
  const [definition, handlers] = register.mock.calls[0] as unknown as [
    { id: string; methods: Record<string, unknown> },
    Record<string, Handler>,
  ];
  const call = async (method: string, input: unknown) => {
    const output = await handlers[method](input, callContext);
    // Outputs travel over HTTP to every client; they must never carry login secrets.
    expect(JSON.stringify(output)).not.toMatch(/"(access|refresh|apiKey)"/);
    // OpenCode's RPC route rejects any output that is not a JSON value (HTTP 400), so an
    // undefined field or a non-finite number must never reach it.
    expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
    return output;
  };
  return { ctx, definition, handlers, commands, call };
}

describe("server quota RPC", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
          errors: [],
        }),
      },
    ]);
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({ changed: false });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers the quota RPC with its four methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual([
      "surface",
      "footer",
      "writeExport",
      "command",
    ]);
    expect(Object.keys(handlers)).toEqual(Object.keys(definition.methods));
  });

  it("serves the sidebar panel and the idle toast", async () => {
    useConfig({ enableToast: true, showOnIdle: true, toastDurationMs: 7000 });
    const { call } = await setupServer();

    const sidebar = (await call("surface", { surface: "sidebar", sessionID: "session-1" })) as {
      quota: { message: string };
    };
    expect(sidebar).toEqual({
      quota: expect.objectContaining({ duration: 7000, activeProviderCount: 1 }),
    });
    expect(sidebar.quota.message).toContain("Copilot");

    const idle = (await call("surface", { surface: "idle", sessionID: "session-1" })) as {
      quota: { message: string };
    };
    expect(idle).toEqual({
      quota: expect.objectContaining({ duration: 7000, activeProviderCount: 1 }),
    });
    expect(idle.quota.message).toContain("Copilot");
  });

  it("returns a null quota when the surface is turned off", async () => {
    useConfig({ enableToast: true, showOnIdle: false });
    const { call } = await setupServer();

    await expect(call("surface", { surface: "idle", sessionID: "session-1" })).resolves.toEqual({
      quota: null,
    });
  });

  it("serves the session prompt line and the Home compact line", async () => {
    useConfig({
      tuiPromptBar: { enabled: true },
      tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: false, maxWidth: 96 },
    });
    const { call } = await setupServer();

    const prompt = (await call("footer", { surface: "prompt", sessionID: "session-1" })) as {
      lines: string[];
    };
    expect(prompt.lines).toHaveLength(1);
    expect(prompt.lines[0]).toContain("Copilot");
    await expect(call("footer", { surface: "prompt" })).resolves.toEqual({ lines: [] });

    const home = (await call("footer", { surface: "home" })) as { lines: string[] };
    expect(home.lines).toHaveLength(1);
    expect(home.lines[0]).toContain("Copilot");
  });

  it("writes the export file only when the export is enabled", async () => {
    const exportPath = `${TEST_RUNTIME_ROOT}/quota-export.json`;
    useConfig({ export: { enabled: false, path: exportPath } });
    const disabled = await setupServer();
    await expect(disabled.call("writeExport", {})).resolves.toEqual({ written: false });
    expect(existsSync(exportPath)).toBe(false);

    useConfig({ export: { enabled: true, path: exportPath } });
    const enabled = await setupServer();
    await expect(enabled.call("writeExport", {})).resolves.toEqual({ written: true });
    expect(existsSync(exportPath)).toBe(true);
  });

  it("runs palette commands on the server and returns their output", async () => {
    useConfig({});
    const { call } = await setupServer();

    const output = (await call("command", { command: "quota", sessionID: "session-1" })) as {
      output: string;
    };
    expect(output).toEqual(
      expect.objectContaining({
        state: "output",
        command: "quota",
        title: "OpenCode Quota",
        dialogSize: "xlarge",
      }),
    );
    expect(output.output).toContain("Copilot");
  });

  it("never writes detected providers to the global config from the palette", async () => {
    useConfig({ enabledProviders: "auto" });
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["copilot"]);
      return {
        state: "output",
        command: params.command,
        title: "OpenCode Quota Status",
        output: "status",
        dialogSize: "xlarge",
      };
    });
    const { call, commands } = await setupServer();

    await call("command", { command: "quota_status", sessionID: "session-1" });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).not.toHaveBeenCalled();

    const slash = commands.find((command) => command.name === "quota_status");
    await slash?.execute({ sessionID: "session-1", prompt: { text: "" } });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: process.cwd(),
      detectedProviderIds: ["copilot"],
    });
  });

  it("returns a failed palette command as output instead of an RPC error", async () => {
    useConfig({});
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockRejectedValue(
      new Error("quota \u001b[31mbroke"),
    );
    const { call } = await setupServer();

    await expect(call("command", { command: "quota" })).resolves.toEqual({
      state: "output",
      command: "quota",
      title: "OpenCode Quota",
      output: "quota broke",
      dialogSize: "xlarge",
    });
  });

  it("treats a session the server cannot find as a session without a model", async () => {
    useConfig({ onlyCurrentModel: true });
    const input = { surface: "sidebar", sessionID: "missing" };
    const withoutModel = await setupServer(vi.fn().mockResolvedValue({}));
    const expected = await withoutModel.call("surface", input);
    const sessionGet = vi.fn().mockRejectedValue(new Error("Session not found"));
    const missing = await setupServer(sessionGet);

    await expect(missing.call("surface", input)).resolves.toEqual(expected);
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "missing" });
  });
});
