import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestContext,
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  getSyntheticText,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-announcements-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const ANNOUNCEMENT_TOAST_MESSAGE =
  "Notice: Maintainer announcement available. Run /quota_announcements.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  providerIds: ["copilot"],
}));

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
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

const announcementMocks = vi.hoisted(() => ({
  getMaintainerAnnouncementsSummary: vi.fn(),
}));

const tuiDiagnosticsMocks = vi.hoisted(() => ({
  inspectTuiConfig: vi.fn(),
}));

const resetMocks = vi.hoisted(() => ({
  observeQuotaResetNotifications: vi.fn(),
  formatQuotaResetNotification: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/tui-config-diagnostics.js", () => ({
  inspectTuiConfig: tuiDiagnosticsMocks.inspectTuiConfig,
}));
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  formatMaintainerAnnouncementHomeCountLine: (activeCount: number) => {
    if (activeCount <= 0) return "";
    if (activeCount === 1) return ANNOUNCEMENT_TOAST_MESSAGE;
    return `Notice: ${activeCount} maintainer announcements available. Run /quota_announcements.`;
  },
  getMaintainerAnnouncementsSummary: announcementMocks.getMaintainerAnnouncementsSummary,
}));
vi.mock("../src/lib/quota-reset-notifications.js", () => ({
  observeQuotaResetNotifications: resetMocks.observeQuotaResetNotifications,
  formatQuotaResetNotification: resetMocks.formatQuotaResetNotification,
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

async function setupPlugin() {
  const { QuotaToastPlugin } = await import("../src/plugin.js");
  const context = createPluginTestContext({ directory: process.cwd() });
  await QuotaToastPlugin.setup(context as never);
  return context;
}

async function createRuntime(
  overrides: { showToast: (body: unknown) => Promise<unknown> },
  client: ReturnType<typeof createClient>,
) {
  const { createQuotaToastRuntime } = await import("../src/lib/quota-toast-runtime.js");
  return createQuotaToastRuntime({
    client: client as never,
    roots: () => ({
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    }),
    resolveSessionMeta: async (sessionID) => {
      const response = await client.session.get({ path: { id: sessionID } });
      return {
        modelID: response.data?.model?.id,
        providerID: response.data?.model?.providerID,
      };
    },
    isSubagentSession: async (sessionID) => {
      const response = await client.session.get({ path: { id: sessionID } });
      return Boolean(response.data?.parentID);
    },
    reconcileDetectedProviders: vi.fn().mockResolvedValue(undefined),
    setSessionTokenError: vi.fn(),
    showToast: overrides.showToast as never,
    log: vi.fn().mockResolvedValue(undefined),
    onInitialized: vi.fn(),
  });
}

async function flushMaintainerFallbackWork(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        showOnCompact: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      },
      resetPluginState: true,
    });
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(makeAnnouncementSummary());
    tuiDiagnosticsMocks.inspectTuiConfig.mockResolvedValue(
      createPluginTuiConfigInspection(TEST_RUNTIME_ROOT),
    );
    resetMocks.observeQuotaResetNotifications.mockResolvedValue([]);
    resetMocks.formatQuotaResetNotification.mockReturnValue(null);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers and builds the no-arg /quota_announcements deterministic output", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    const announcementCommand = QUOTA_DIALOG_COMMANDS.find(
      (command) => command.id === "quota_announcements",
    );
    const context = await setupPlugin();

    expect(
      context.registeredCommands.find((command) => command.name === announcementCommand?.slashName),
    ).toEqual(
      expect.objectContaining({
        name: announcementCommand?.slashName,
        description: announcementCommand?.description,
      }),
    );

    await context.runCommand("quota_announcements", "", "session-announcements");
    const output = getSyntheticText(context);

    expect(output).toBe(
      "Maintainer announcements\n\n- If you use Copilot, GitHub billing is moving to AI Credits.\n  https://github.blog/example",
    );
    expect(output).not.toContain("copilot-credits");
    expect(output).not.toContain("source:");
    expect(output).not.toContain("state");
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("renders none for provider-targeted announcements when the provider is unavailable", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);
    announcementMocks.getMaintainerAnnouncementsSummary.mockImplementation((params: any) => {
      const enabledProviders = Array.isArray(params?.enabledProviders)
        ? params.enabledProviders
        : [];
      return enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] });
    });

    const context = await setupPlugin();

    await context.runCommand("quota_announcements", "", "session-announcements");
    expect(getSyntheticText(context)).toBe("Maintainer announcements\n\nNo current announcements.");
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: [] }),
    );
  });

  it("renders none when no active announcements are available", async () => {
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(
      makeAnnouncementSummary({
        activeCount: 0,
        activeAnnouncements: [],
      }),
    );

    const context = await setupPlugin();

    await context.runCommand("quota_announcements", "", "session-announcements");
    expect(getSyntheticText(context)).toBe("Maintainer announcements\n\nNo current announcements.");
  });

  it("rejects /quota_announcements arguments", async () => {
    const context = await setupPlugin();

    await context.runCommand(
      "quota_announcements",
      "show copilot-credits",
      "session-announcements",
    );

    expect(getSyntheticText(context)).toBe(
      "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
    );
  });

  it("shows one count-only fallback toast after the first visible quota toast without TUI", async () => {
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        enableToast: true,
        enabledProviders: ["copilot"],
        showOnIdle: false,
        showOnQuestion: true,
        showOnCompact: false,
        minIntervalMs: 0,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      }),
    );
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
    const showToast = vi.fn().mockResolvedValue({});
    const client = createClient({ modelID: "copilot/gpt-4.1", providerID: "copilot" });
    const runtime = await createRuntime({ showToast }, client);

    await runtime.handleTrigger({ sessionID: "session-question", trigger: "question" });
    await flushMaintainerFallbackWork();

    expect(showToast.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining("Copilot") }),
    );
    expect(showToast.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ message: ANNOUNCEMENT_TOAST_MESSAGE }),
    );
    expect(showToast.mock.calls[1]?.[0]).not.toEqual(
      expect.objectContaining({
        message: expect.stringContaining(TEST_ANNOUNCEMENT.message),
      }),
    );
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("does not attempt fallback before or without a visible quota toast", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      }),
    );

    const showToast = vi.fn().mockResolvedValue({});
    const client = createClient();
    const runtime = await createRuntime({ showToast }, client);

    // V2 server plugins no longer observe tool executions; the CLI bridge
    // forwards only session lifecycle triggers. With every trigger disabled
    // there is no quota toast, so no count-only fallback may appear.
    await runtime.handleTrigger({ sessionID: "session-idle", trigger: "session.idle" });
    await runtime.handleTrigger({ sessionID: "session-question", trigger: "question" });

    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});
