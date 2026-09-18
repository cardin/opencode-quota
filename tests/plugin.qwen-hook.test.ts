import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginTestClient,
  createPluginTestContext,
  createPricingModuleMock,
  createQwenAuthModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
  readAuthFile: vi.fn(),
  getAuthPath: vi.fn(() => "/tmp/auth.json"),
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  clearReadAuthFileCacheForTests: vi.fn(),
}));
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

/**
 * OpenCode 2 migration note
 * ------------------------
 * The V1 server plugin registered a `tool.execute.after` hook that forwarded
 * successful `question` tool calls to the toast runtime. OpenCode 2 removed
 * server-side tool hooks and moved toast emission into the CLI/TUI plugin
 * (`src/lib/tui-toast-bridge.ts`). The accounting boundary this file guarded
 * ("a question tool result is not a completed model request") now lives in the
 * shared toast runtime's trigger gate, which is exercised by the second test.
 */
describe("plugin question hook accounting boundary", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { showOnQuestion: false },
    });
  });

  it("does not register a server-side tool.execute.after question hook", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const context = createPluginTestContext({
      modelID: "qwen3-coder-plus",
      providerID: "qwen-code",
    });

    await QuotaToastPlugin.setup(context as never);

    // V2 server plugins register no tool hooks: the question trigger is owned
    // by the CLI toast bridge, and this server plugin must not observe tool
    // executions at all.
    expect(context.tool.hook).not.toHaveBeenCalled();
    expect(context.event.subscribe).not.toHaveBeenCalled();
    expect(context.session.get).not.toHaveBeenCalled();
    expect(mocks.resolveQwenLocalPlanCached).not.toHaveBeenCalled();
    expect(mocks.resolveAlibabaCodingPlanAuthCached).not.toHaveBeenCalled();
  });

  it("keeps the question trigger behind the showOnQuestion gate in the shared runtime", async () => {
    const { createQuotaToastRuntime } = await import("../src/lib/quota-toast-runtime.js");
    const client = createPluginTestClient({
      modelID: "qwen3-coder-plus",
      providerID: "qwen-code",
    });
    const showToast = vi.fn().mockResolvedValue({});
    const runtime = createQuotaToastRuntime({
      client: client as never,
      roots: () => ({
        workspaceRoot: process.cwd(),
        configRoot: process.cwd(),
        fallbackDirectory: process.cwd(),
      }),
      resolveSessionMeta: async () => ({
        modelID: "qwen3-coder-plus",
        providerID: "qwen-code",
      }),
      isSubagentSession: async () => false,
      reconcileDetectedProviders: vi.fn().mockResolvedValue(undefined),
      setSessionTokenError: vi.fn(),
      showToast: showToast as never,
      log: vi.fn().mockResolvedValue(undefined),
      onInitialized: vi.fn(),
    });

    // A successful question-tool completion is only a trigger; with
    // showOnQuestion disabled it must not consult local plan auth or emit a
    // toast, so it cannot be mistaken for a completed model request.
    await runtime.handleTrigger({ sessionID: "session-1", trigger: "question" });

    expect(mocks.resolveQwenLocalPlanCached).not.toHaveBeenCalled();
    expect(mocks.resolveAlibabaCodingPlanAuthCached).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("still respects the configured trigger matrix for question events", async () => {
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnCompact: false,
        showOnQuestion: false,
      }),
    );
    const { createQuotaToastRuntime } = await import("../src/lib/quota-toast-runtime.js");
    const client = createPluginTestClient({
      modelID: "qwen3-coder-plus",
      providerID: "qwen-code",
    });
    const showToast = vi.fn().mockResolvedValue({});
    const runtime = createQuotaToastRuntime({
      client: client as never,
      roots: () => ({
        workspaceRoot: process.cwd(),
        configRoot: process.cwd(),
        fallbackDirectory: process.cwd(),
      }),
      resolveSessionMeta: async () => ({ modelID: "qwen3-coder-plus", providerID: "qwen-code" }),
      isSubagentSession: async () => false,
      reconcileDetectedProviders: vi.fn().mockResolvedValue(undefined),
      setSessionTokenError: vi.fn(),
      showToast: showToast as never,
      log: vi.fn().mockResolvedValue(undefined),
      onInitialized: vi.fn(),
    });

    await runtime.handleTrigger({ sessionID: "session-1", trigger: "session.idle" });
    expect(showToast).not.toHaveBeenCalled();
  });
});
