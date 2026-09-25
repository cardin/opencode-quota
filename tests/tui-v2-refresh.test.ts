import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildQuotaExport, collectQuotaRenderData, resolveQuotaRuntimeContext, writeQuotaExport } =
  vi.hoisted(() => ({
    buildQuotaExport: vi.fn(),
    collectQuotaRenderData: vi.fn(),
    resolveQuotaRuntimeContext: vi.fn(),
    writeQuotaExport: vi.fn(),
  }));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return { ...actual, collectQuotaRenderData };
});

vi.mock("../src/lib/quota-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-runtime-context.js")>(
    "../src/lib/quota-runtime-context.js",
  );
  return { ...actual, resolveQuotaRuntimeContext };
});

vi.mock("../src/lib/quota-export.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-export.js")>(
    "../src/lib/quota-export.js",
  );
  return { ...actual, buildQuotaExport, createExportProviderContext: vi.fn(), writeQuotaExport };
});

import plugin from "../src/tui-v2.tsx";

const REFRESH_INTERVAL_MS = 60_000;

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function setupFooterSlots(): Map<string, () => unknown> {
  const renderers = new Map<string, () => unknown>();
  plugin.setup({
    data: { on: vi.fn(() => vi.fn()) },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim) => {
        renderers.set(claim.append, claim.render);
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      dialog: { alert: vi.fn(), prompt: vi.fn(), set: vi.fn() },
    },
  } as any);
  return renderers;
}

function mountSlot(render: (() => unknown) | undefined): () => void {
  return createRoot((dispose) => {
    render?.();
    return dispose;
  });
}

describe("V2 footer refresh timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown> | null) =>
        typeof type === "function" ? type(props ?? {}) : { type, props },
    });
    resolveQuotaRuntimeContext.mockReset();
    collectQuotaRenderData.mockReset();
    buildQuotaExport.mockReset();
    writeQuotaExport.mockReset();
    resolveQuotaRuntimeContext.mockResolvedValue({
      client: {},
      config: {
        enabled: true,
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        minIntervalMs: 60_000,
        maintainerAnnouncements: { enabled: false, home: false },
        tuiPromptBar: { enabled: false },
        tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: true, maxWidth: 80 },
        export: { enabled: true, path: "/tmp/opencode-quota-refresh-test.json" },
      },
      configMeta: {},
      providers: [],
      resolveRuntimeProviderIds: vi.fn(),
      session: {},
    });
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: { entries: [{ name: "Copilot", percentRemaining: 50 }], errors: [] },
    });
    buildQuotaExport.mockResolvedValue({ version: 2 });
    writeQuotaExport.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes the Home footer and writes the export every minute until unmount", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);
    expect(writeQuotaExport).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1);
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(2);
    expect(writeQuotaExport).toHaveBeenCalledTimes(2);

    dispose();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(2);
    expect(writeQuotaExport).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt footer every minute without writing the export", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("prompt.footer"));
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(2);

    dispose();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(2);
    expect(writeQuotaExport).not.toHaveBeenCalled();
  });
});
