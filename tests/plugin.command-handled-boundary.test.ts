import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginTestContext,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getSyntheticText,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-command-boundary-tests";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

async function setupPlugin(
  options: { modelID?: string; providerID?: string; directory?: string } = {},
) {
  const { QuotaToastPlugin } = await import("../src/plugin.js");
  const context = createPluginTestContext({
    directory: options.directory ?? process.cwd(),
    modelID: options.modelID,
    providerID: options.providerID,
  });
  await QuotaToastPlugin.setup(context as never);
  return context;
}

async function buildDialogOutput(params: {
  command: "quota" | "pricing_refresh" | "tokens_daily" | "tokens_session_all";
  client: ReturnType<typeof createClient>;
  sessionID?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  return buildQuotaDialogCommandOutput({
    command: params.command,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
  });
}

describe("plugin command handled boundary", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { enabled: true },
      resetPluginState: true,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers deterministic slash commands for the server/web command surface", async () => {
    const context = await setupPlugin();
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");

    expect(QUOTA_DIALOG_COMMANDS).toHaveLength(12);
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((spec) => spec.id)).size).toBe(12);
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((spec) => spec.slashName)).size).toBe(12);
    expect(context.registeredCommands).toHaveLength(12);
    for (const spec of QUOTA_DIALOG_COMMANDS) {
      expect(context.registeredCommands.find((command) => command.name === spec.slashName)).toEqual(
        expect.objectContaining({
          name: spec.slashName,
          description: spec.description,
        }),
      );
    }
    // V2 commands are registered as first-class capabilities; they never
    // inject through the V1 session.prompt/noReply path or a handled sentinel.
    expect(context.session.synthetic).not.toHaveBeenCalled();
  });

  /**
   * OpenCode 2 migration note
   * ------------------------
   * V1 relied on the `config` hook to remap a `default_agent` whose
   * zero-width-normalized name matched exactly one agent key. V2 resolves
   * agents from the agent registry (`ctx.agent`) and no longer hands raw
   * config through plugin hooks, so that remap has no equivalent. The test
   * below documents the V2 behavior: command registration is independent of
   * any config hook and never mutates agent state.
   */
  it("registers slash commands without a config hook or agent remap (V2)", async () => {
    const context = await setupPlugin({ providerID: "openai" });

    // The V2 plugin does not mutate agent state while registering commands.
    expect(context.agent.transform).not.toHaveBeenCalled();
    expect(context.tool.hook).not.toHaveBeenCalled();

    // A previous V1-only config hook would have injected a command catalog;
    // in V2 the catalog is registered directly through ctx.command.transform.
    expect(context.command.transform).toHaveBeenCalledOnce();
    expect(context.registeredCommands).toHaveLength(12);
  });

  it("leaves non-quota server commands untouched", async () => {
    const context = await setupPlugin();

    expect(context.registeredCommands.some((command) => command.name === "project_notes")).toBe(
      false,
    );
    expect(context.session.synthetic).not.toHaveBeenCalled();
  });

  it("handles server /quota by injecting deterministic output", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);

    const context = await setupPlugin();
    await context.runCommand("quota", "", "session-2");

    expect(context.session.synthetic).toHaveBeenCalledTimes(1);
    expect(context.session.synthetic).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "session-2",
        // V2 renders `description` in the transcript and treats `text` as
        // model-facing input, so deterministic output lives in `description`
        // with an empty `text` and `resume: false` (no model turn).
        description: expect.stringContaining("Quota unavailable"),
        text: "",
        resume: false,
      }),
    );
    expect(getSyntheticText(context)).toContain("Quota unavailable");
    expect(getSyntheticText(context)).toContain("No provider data available");
  });

  it("injects clean plain text when /quota has no current model", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        onlyCurrentModel: false,
        showSessionTokens: false,
        tuiCommandDisplay: "dialog",
      }),
    );
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            name: "OpenAI Weekly",
            group: "OpenAI",
            label: "Weekly:",
            percentRemaining: 80,
          },
        ],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const context = await setupPlugin();
    await context.runCommand("quota", "", "session-zero-model");

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    const text = getSyntheticText(context);
    expect(text).toMatch(/\n {2}Week quota\s+[█░]{10}\s+80% left/u);
    expect(text).toMatch(/^Quota \(\/quota\)/u);
    expect(text).not.toContain("```");
    expect(text).not.toMatch(/^#{1,6} /mu);
    expect(text).not.toContain("No enabled quota providers matched");
  });

  it("handles /tokens_between arguments through one inline injection", async () => {
    const context = await setupPlugin();
    await context.runCommand("tokens_between", "not-a-date-range", "session-between");

    expect(context.session.synthetic).toHaveBeenCalledTimes(1);
    expect(getSyntheticText(context)).toContain("Invalid arguments for /tokens_between");
  });

  it("injects inline usage output when /tokens_between arguments are missing", async () => {
    const context = await setupPlugin();
    await context.runCommand("tokens_between", "", "session-between-missing");

    expect(context.session.synthetic).toHaveBeenCalledTimes(1);
    expect(getSyntheticText(context)).toContain("Invalid arguments for /tokens_between");
    expect(getSyntheticText(context)).toContain("Expected: /tokens_between YYYY-MM-DD YYYY-MM-DD");
  });

  it("propagates slash command injection failures and logs them", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);
    const injectionError = new Error("synthetic unavailable");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const context = await setupPlugin();
    context.session.synthetic.mockRejectedValueOnce(injectionError);

    await expect(context.runCommand("quota", "", "session-inject-fails")).rejects.toBe(
      injectionError,
    );

    expect(isCommandHandledError(injectionError)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[quota-toast] Failed to inject raw output",
      expect.objectContaining({ error: "synthetic unavailable" }),
    );
    errorSpy.mockRestore();
  });

  it("still builds deterministic quota dialog output without session injection", async () => {
    const isAvailable = vi.fn().mockRejectedValue(new Error("boom"));
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable,
        fetch: vi.fn(),
      },
    ]);
    const client = createClient();

    const result = await buildDialogOutput({ command: "quota", client, sessionID: "session-2" });

    expect(result.state).toBe("output");
    expect(result.state === "output" ? result.output : "").toContain("Quota unavailable");
    expect(result.state === "output" ? result.output : "").toContain("No provider data available");
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles disabled deterministic server commands without injecting output", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const context = await setupPlugin();

    await context.runCommand("tokens_daily", "", "session-disabled");
    await context.runCommand("tokens_session_all", "", "session-disabled-tree");

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(context.session.synthetic).not.toHaveBeenCalled();
  });

  it("returns no-op dialog result for disabled deterministic commands", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const daily = await buildDialogOutput({
      command: "tokens_daily",
      client,
      sessionID: "session-disabled",
    });
    const tree = await buildDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "session-disabled-tree",
    });

    expect(daily).toEqual({ state: "noop", command: "tokens_daily", reason: "disabled" });
    expect(tree).toEqual({ state: "noop", command: "tokens_session_all", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles server /pricing_refresh by refreshing pricing and injecting output", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });

    const context = await setupPlugin();
    await context.runCommand("pricing_refresh", "", "session-pricing-refresh");

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(context.session.synthetic).toHaveBeenCalledTimes(1);
    expect(getSyntheticText(context)).toContain("Pricing Refresh (/pricing_refresh)");
  });

  it("still builds /pricing_refresh dialog output without throwing a handled sentinel", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });

    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-pricing-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(result.state === "output" ? result.output : "").toContain(
      "Pricing Refresh (/pricing_refresh)",
    );
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles disabled server /pricing_refresh as a no-op", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const context = await setupPlugin();

    await context.runCommand("pricing_refresh", "", "session-disabled-refresh");

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(context.session.synthetic).not.toHaveBeenCalled();
  });

  it("treats /pricing_refresh as a dialog no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-disabled-refresh",
    });

    expect(result).toEqual({ state: "noop", command: "pricing_refresh", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});
