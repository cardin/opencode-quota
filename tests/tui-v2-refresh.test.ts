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

function setupFooterSlots(
  handlers = new Map<string, (event: unknown) => void>(),
): Map<string, (props?: any) => unknown> {
  const renderers = new Map<string, (props?: any) => unknown>();
  plugin.setup({
    data: {
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        handlers.set(event, handler);
        return vi.fn();
      }),
    },
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

function mountSlot(render: ((props?: any) => unknown) | undefined, props?: unknown): () => void {
  return createRoot((dispose) => {
    render?.(props);
    return dispose;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

  it("loads Home for every enabled provider without a session, even with onlyCurrentModel", async () => {
    const runtime = await resolveQuotaRuntimeContext();
    resolveQuotaRuntimeContext.mockResolvedValue({
      ...runtime,
      config: { ...runtime.config, onlyCurrentModel: true, showSessionTokens: true },
      session: { sessionID: "ses_1", sessionMeta: { modelID: "m", providerID: "p" } },
    });
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();

    const params = collectQuotaRenderData.mock.calls[0][0];
    expect(params.config).toMatchObject({ onlyCurrentModel: false, showSessionTokens: false });
    expect(params.request).toEqual({ sessionID: undefined, sessionMeta: undefined });
    dispose();
  });

  it("drops a Home result and skips the export when the view unmounts mid-load", async () => {
    const load = deferred<unknown>();
    collectQuotaRenderData.mockReturnValueOnce(load.promise);
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);

    dispose();
    load.resolve({ active: [], data: { entries: [], errors: [] } });
    await flushPromises();
    expect(writeQuotaExport).not.toHaveBeenCalled();
  });

  it("coalesces refreshes that arrive while a footer load is running into one follow-up load", async () => {
    const load = deferred<unknown>();
    collectQuotaRenderData.mockReturnValueOnce(load.promise);
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);

    load.resolve({ active: [], data: { entries: [], errors: [] } });
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(2);
    expect(writeQuotaExport).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("stops sidebar refreshes and drops their results after unmount", async () => {
    const runtime = await resolveQuotaRuntimeContext();
    resolveQuotaRuntimeContext.mockResolvedValue({
      ...runtime,
      config: { ...runtime.config, tuiSidebarPanel: { enabled: true } },
    });
    const load = deferred<unknown>();
    collectQuotaRenderData.mockReturnValueOnce(load.promise);
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    const dispose = mountSlot(renderers.get("sidebar.content"), { sessionID: "ses_1" });
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    dispose();
    load.resolve({ active: [], data: undefined });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
    await flushPromises();
    expect(collectQuotaRenderData).toHaveBeenCalledTimes(1);
  });
});
