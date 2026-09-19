import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildQuotaDialogCommandOutput,
  cleanupFns,
  createTuiQuotaClient,
  disposeQuotaTelemetryOwner,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} = vi.hoisted(() => ({
  buildQuotaDialogCommandOutput: vi.fn(),
  cleanupFns: [] as Array<() => void>,
  createTuiQuotaClient: vi.fn(() => ({ config: {} })),
  disposeQuotaTelemetryOwner: vi.fn(),
  getTuiRuntimeRootHints: vi.fn(() => ({
    worktreeRoot: "/tmp/worktree",
    activeDirectory: "/tmp/worktree",
    fallbackDirectory: "/tmp/worktree",
  })),
  getTuiSessionModelMeta: vi.fn(),
  loadTuiHomeBottomStatus: vi.fn(),
  loadTuiSessionQuotaSurfaces: vi.fn(),
  normalizeTuiSessionID: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() && !value.includes("{") ? value.trim() : undefined,
  ),
  resolveTuiSurfaceRegistration: vi.fn(),
  writeTuiQuotaExportIfEnabled: vi.fn(),
}));

vi.mock("../src/lib/tui-runtime.js", () => ({
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
}));

vi.mock("../src/lib/quota-telemetry.js", () => ({
  disposeQuotaTelemetryOwner,
}));

vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>();
  return {
    ...actual,
    buildQuotaDialogCommandOutput,
  };
});

const TUI_COMMAND_IDS = [
  "quota",
  "quota_status",
  "quota_announcements",
  "pricing_refresh",
  "tokens_today",
  "tokens_daily",
  "tokens_weekly",
  "tokens_monthly",
  "tokens_all",
  "tokens_session",
  "tokens_session_all",
  "tokens_between",
] as const;

const TUI_COMMAND_GROUPS = [
  ["quota", "quota_status"],
  ["quota_announcements", "pricing_refresh"],
  ["tokens_today", "tokens_daily"],
  ["tokens_weekly", "tokens_monthly"],
  ["tokens_all", "tokens_session"],
  ["tokens_session_all", "tokens_between"],
] as const;

vi.mock("solid-js", () => ({
  Show: (props: { when: unknown; children?: unknown; fallback?: unknown }) => {
    if (!props.when) return props.fallback ?? null;
    return typeof props.children === "function"
      ? (props.children as (value: unknown) => unknown)(props.when)
      : props.children;
  },
  createEffect: (fn: () => void) => fn(),
  createSignal: <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T | ((previous: T) => T)) => {
        value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
        return value;
      },
    ];
  },
  onCleanup: (fn: () => void) => {
    cleanupFns.push(fn);
  },
}));

vi.mock("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
  jsxs: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
}));

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const nextProps = {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  };
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
}

// V1 TUI event names -> V2 server event names, mirroring `tui-host.ts` so the
// smoke tests can keep emitting the V1 logical events.
const TUI_EVENT_MAP: Record<string, readonly string[]> = {
  "session.updated": [
    "session.status",
    "session.created",
    "session.renamed",
    "session.model.selected",
    "session.agent.selected",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.compacted",
  ],
  "message.updated": ["session.message.content.updated", "session.usage.updated"],
  "message.removed": ["session.message.content.updated"],
  "session.status": [
    "session.status",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
  ],
  "tui.session.select": ["tui.session.select"],
};

/**
 * Builds a fake OpenCode 2 CLI `Context` for `TuiQuotaPlugin.setup`.
 *
 * The V1 `TuiPluginApi` registered grouped slot bundles (`api.slots.register`)
 * and keymap layers (`api.keymap.registerLayer`). V2 registers individual slot
 * claims (`context.ui.slot`) and keymap layers (`context.keymap.layer`). This
 * harness records the V2 calls and exposes them through the legacy
 * `registered`/`keymapLayers` shapes so the behavioral assertions stay intact:
 * `sidebar.content` maps to the order-150 `sidebar_content` slot, and
 * `session.composer.top`/`home.footer` map to the order-90 `session_prompt`
 * and `home_bottom` slots.
 */
function createApi() {
  const keymapLayers: Array<{ commands: Array<Record<string, unknown>> }> = [];
  const dialogShow = vi.fn();
  const dialogSet = vi.fn();
  const dialogClear = vi.fn();
  const dialogPrompt = vi.fn();
  const dialog = {
    show: dialogShow,
    set: dialogSet,
    clear: dialogClear,
    prompt: dialogPrompt,
    alert: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    // V1 aliases the smoke assertions still use.
    replace: dialogShow,
    setSize: dialogSet,
  };
  const toast = vi.fn();
  (toast as unknown as { show: typeof toast }).show = toast;
  const registered: Array<{
    order?: number;
    slots: Record<string, (ctx: unknown, props: any) => unknown>;
  }> = [];
  const slotCleanups: Array<ReturnType<typeof vi.fn>> = [];
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const eventHandlers = new Map<string, Array<(event: any) => void>>();
  const kvStore: Record<string, unknown> = {};
  const kvSet = vi.fn((mutation: (draft: Record<string, unknown>) => void) => mutation(kvStore));

  const ensureCompactGroup = () => {
    const existing = registered.find((entry) => entry.order === 90);
    if (existing) return existing;
    const group: (typeof registered)[number] = { order: 90, slots: {} };
    registered.push(group);
    return group;
  };

  const slot = vi.fn((claim: { append: string; render: (input: any) => unknown }) => {
    if (claim.append === "app") {
      // OpenCode renders app slots inside the Solid owner that provides the
      // keymap context. Mount immediately so command-layer behavior is covered.
      claim.render({});
    } else if (claim.append === "sidebar.content") {
      registered.push({
        order: 150,
        slots: {
          sidebar_content: (_ctx, props) => claim.render({ sessionID: props.session_id }),
        },
      });
    } else if (claim.append === "session.composer.top") {
      ensureCompactGroup().slots.session_prompt = (_ctx, props) =>
        claim.render({ sessionID: props.session_id });
    } else if (claim.append === "prompt.footer") {
      ensureCompactGroup().slots.prompt_footer = (_ctx, props) =>
        claim.render({ sessionID: props.session_id, mode: "normal", showDetails: false });
    } else if (claim.append === "home.footer") {
      ensureCompactGroup().slots.home_bottom = () => claim.render({});
    }
    const cleanup = vi.fn();
    slotCleanups.push(cleanup);
    return cleanup;
  });

  const keymapLayer = vi.fn((resolveLayer: () => unknown) => {
    keymapLayers.push(resolveLayer() as { commands: Array<Record<string, unknown>> });
    return () => {};
  });

  const api = {
    options: {},
    location: { directory: "/tmp/worktree" },
    app: { version: "2.0.9", channel: "dev" },
    theme: { text: { base: "text", muted: "muted" } },
    client: {
      provider: { list: vi.fn().mockResolvedValue({ data: [] }) },
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        get: vi.fn(),
        synthetic: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn(),
        command: vi.fn(),
      },
    },
    data: {
      on: vi.fn((eventName: string, handler: (event: any) => void) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
        const unsubscribe = vi.fn();
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      }),
      listen: vi.fn(() => vi.fn()),
      session: {
        get: vi.fn(),
        status: vi.fn(() => "idle"),
        message: { list: vi.fn(() => []) },
      },
      location: { provider: { list: vi.fn(() => []) } },
    },
    ui: {
      slot,
      dialog,
      toast,
      router: {
        current: vi.fn(() => api.route.current),
      },
    },
    slots: { register: slot },
    lifecycle: { onDispose: vi.fn() },
    keymap: { layer: keymapLayer, registerLayer: keymapLayer },
    storage: {
      memory: vi.fn(() => [kvStore, kvSet]),
      store: vi.fn(() => [kvStore, kvSet]),
    },
    kv: {
      get: (key: string, fallback?: unknown) => (key in kvStore ? kvStore[key] : fallback),
      set: kvSet,
    },
    route: { current: { type: "session", sessionID: "session-route" } as { type: string } },
  };

  const emit = (
    eventName: string,
    payload: {
      properties?: { sessionID?: string; info?: { id?: string; sessionID?: string } };
    } = {},
  ) => {
    const properties = payload.properties ?? {};
    const sessionID = properties.info?.id ?? properties.info?.sessionID ?? properties.sessionID;
    const data = sessionID === undefined ? {} : { sessionID };
    // A V1 event maps to several V2 events; real traffic fires one, so the
    // harness dispatches only the first to keep refresh counts faithful.
    const mapped = (TUI_EVENT_MAP[eventName] ?? [eventName])[0]!;
    for (const handler of eventHandlers.get(mapped) ?? []) {
      handler({ type: mapped, data });
    }
  };

  return {
    api,
    registered,
    slotCleanups,
    unsubscribers,
    eventHandlers,
    kvStore,
    keymapLayers,
    dialog,
    emit,
  };
}

const tuiPlugin = (await import("../src/tui.tsx")).default;

async function loadTuiModule() {
  return tuiPlugin;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function startTui(
  plugin: Awaited<ReturnType<typeof loadTuiModule>>,
  api: ReturnType<typeof createApi>["api"],
): Promise<void> {
  const cleanup = await plugin.setup(api as never);
  if (typeof cleanup === "function") {
    api.lifecycle.onDispose(cleanup);
  }
  await flushPromises();
}

describe("tui plugin smoke", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).React = { createElement };
    cleanupFns.length = 0;
    buildQuotaDialogCommandOutput.mockReset();
    buildQuotaDialogCommandOutput.mockResolvedValue({
      state: "output",
      command: "quota",
      title: "OpenCode Quota",
      output: "Quota line 1\n\nQuota line 3",
      dialogSize: "xlarge",
    });
    createTuiQuotaClient.mockClear();
    disposeQuotaTelemetryOwner.mockClear();
    getTuiRuntimeRootHints.mockClear();
    getTuiSessionModelMeta.mockReset();
    getTuiSessionModelMeta.mockResolvedValue({ modelID: "gpt-5", providerID: "openai" });
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockResolvedValue({
      status: "ready",
      compact: { status: "ready", text: "Home quota" },
    });
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces.mockResolvedValue({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Session quota" },
      promptBar: {
        status: "ready",
        entry: { name: "Quota", percentRemaining: 50 },
        percentDisplayMode: "remaining",
      },
    });
    resolveTuiSurfaceRegistration.mockReset();
    writeTuiQuotaExportIfEnabled.mockReset();
    writeTuiQuotaExportIfEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
    vi.clearAllTimers();
    delete (globalThis as any).React;
    vi.useRealTimers();
  });

  it("registers stable neutral hosts before late surface resolution and activates once", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await startTui(plugin, api);

    expect(resolveTuiSurfaceRegistration).toHaveBeenCalledOnce();
    expect(keymapLayers).toHaveLength(1);
    expect(registered.map((entry) => entry.order)).toEqual([150, 90]);
    expect(Object.keys(registered[0]!.slots)).toEqual(["sidebar_content"]);
    expect(Object.keys(registered[1]!.slots)).toEqual([
      "session_prompt",
      "prompt_footer",
      "home_bottom",
    ]);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
    expect(loadTuiSessionQuotaSurfaces).not.toHaveBeenCalled();
    expect(loadTuiHomeBottomStatus).not.toHaveBeenCalled();
    keymapLayers[0]!.commands[0]!.run?.();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    // app command layer + sidebar.content + session.composer.top +
    // prompt.footer + home.footer
    expect(api.slots.register).toHaveBeenCalledTimes(5);
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.synthetic).toHaveBeenCalledOnce();
    registered[1]!.slots.session_prompt({}, { session_id: "session-1" });
    await flushPromises();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).not.toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).not.toBeNull();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();
  });

  it("keeps compatibility with the OpenCode 2.0.7 theme leaf names", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    (api as unknown as { theme: unknown }).theme = {
      text: { default: "legacy-text", subdued: "legacy-muted" },
    };

    await startTui(plugin, api);

    expect(keymapLayers).toHaveLength(1);
  });

  it("uses independent one-shot session and home registration tickets", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, emit } = createApi();
    const initialRuntimeSeed = { marker: "registration" };
    resolveTuiSurfaceRegistration.mockImplementationOnce(
      (
        _api: unknown,
        options?: { captureInitialRuntime?: (seed: typeof initialRuntimeSeed) => void },
      ) => {
        options?.captureInitialRuntime?.(initialRuntimeSeed);
        return Promise.resolve({
          commandDisplay: "inline",
          sidebar: { enabled: true },
          compact: {
            enabled: true,
            homeBottom: true,
            sessionPrompt: true,
            hasNativeProviderQuota: false,
            suppressedByNativeProviderQuota: false,
          },
          promptBar: { enabled: true },

          announcements: { homeBottom: false },
          homeBottom: true,
        });
      },
    );

    await startTui(plugin, api);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    registered[1]!.slots.session_prompt({}, { session_id: "session-1" });
    registered[1]!.slots.home_bottom({}, {});
    await flushPromises();

    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(1);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionID: "session-1",
        initialRuntimeSeed,
      }),
    );
    expect(loadTuiHomeBottomStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ initialRuntimeSeed }),
    );

    emit("message.updated", { properties: { info: { id: "session-1" } } });
    await vi.advanceTimersByTimeAsync(150);
    expect(loadTuiHomeBottomStatus).toHaveBeenNthCalledWith(2, expect.anything());
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionID: "session-1" }),
    );
  });

  it("consumes a session ticket when the initial load starts and does not pass it to a successor", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const initialRuntimeSeed = { marker: "registration" };
    loadTuiSessionQuotaSurfaces.mockRejectedValueOnce(new Error("initial unavailable"));
    resolveTuiSurfaceRegistration.mockImplementationOnce(
      (
        _api: unknown,
        options?: { captureInitialRuntime?: (seed: typeof initialRuntimeSeed) => void },
      ) => {
        options?.captureInitialRuntime?.(initialRuntimeSeed);
        return Promise.resolve({
          commandDisplay: "inline",
          sidebar: { enabled: true },
          compact: {
            enabled: false,
            homeBottom: false,
            sessionPrompt: false,
            hasNativeProviderQuota: false,
            suppressedByNativeProviderQuota: false,
          },
          promptBar: { enabled: true },

          announcements: { homeBottom: false },
          homeBottom: false,
        });
      },
    );

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionID: "session-1", initialRuntimeSeed }),
    );

    cleanupFns.pop()!();
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionID: "session-1" }),
    );
  });

  it("does not queue repeated commands while surface registration is pending", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await startTui(plugin, api);
    for (let index = 0; index < 25; index += 1) keymapLayers[0]!.commands[0]!.run?.();

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });
    await flushPromises();

    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
  });

  it("does not react to a pending command when resolution is followed by disposal", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await startTui(plugin, api);
    keymapLayers[0]!.commands[0]!.run?.();
    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });
    const dispose = api.lifecycle.onDispose.mock.calls[0]?.[0];
    dispose?.();
    await flushPromises();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
  });

  it("activates the existing inline-command and sidebar fallback after late failure", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await startTui(plugin, api);
    expect(keymapLayers).toHaveLength(1);
    expect(registered).toHaveLength(2);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();

    registration.reject(new Error("config unavailable"));
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(5);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
  });

  it("keeps surface slots active when the app command layer cannot mount", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    api.keymap.registerLayer.mockImplementationOnce(() => {
      throw new Error("registration unavailable");
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(registered).toHaveLength(2);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
  });

  it.each([
    "sidebar.content",
    "session.composer.top",
  ] as const)("keeps the installed command layer active when the %s slot registration throws", async (failedSlot) => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);
    const registerSlot = api.slots.register.getMockImplementation()!;
    api.slots.register.mockImplementation((entry: any) => {
      if (entry.append === failedSlot) throw new Error("slot registration unavailable");
      return registerSlot(entry);
    });

    await startTui(plugin, api);
    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(5);

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });
    await flushPromises();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.synthetic).toHaveBeenCalledOnce();
  });

  it("keeps eager hosts neutral and pending commands inert after disposal", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered, slotCleanups } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await startTui(plugin, api);
    // V2 exposes a single setup cleanup instead of V1's multiple onDispose hooks.
    expect(api.lifecycle.onDispose).toHaveBeenCalledTimes(1);
    expect(keymapLayers).toHaveLength(1);
    expect(registered).toHaveLength(2);

    keymapLayers[0]!.commands[0]!.run?.();
    const dispose = api.lifecycle.onDispose.mock.calls[0]?.[0];
    dispose?.();
    registration.reject(new Error("config unavailable"));
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(5);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    expect(loadTuiSessionQuotaSurfaces).not.toHaveBeenCalled();
    expect(loadTuiHomeBottomStatus).not.toHaveBeenCalled();
    // Called once by the toast runtime and once by the telemetry disposal.
    expect(createTuiQuotaClient).toHaveBeenCalledTimes(2);
    expect(disposeQuotaTelemetryOwner).toHaveBeenCalledOnce();
    expect(slotCleanups).toHaveLength(5);
    expect(slotCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    dispose?.();
    expect(slotCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
  });

  it("registers every deterministic command through the palette keymap", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.lifecycle.onDispose).toHaveBeenCalledTimes(1);
    const telemetryCleanup = api.lifecycle.onDispose.mock.calls[0]?.[0];
    expect(telemetryCleanup).toBeTypeOf("function");
    telemetryCleanup?.();
    expect(createTuiQuotaClient).toHaveBeenCalledTimes(2);
    expect(disposeQuotaTelemetryOwner).toHaveBeenCalledWith(
      createTuiQuotaClient.mock.results.at(-1)?.value,
    );
    const commandNames = keymapLayers[0]?.commands.map(
      (command) => (command.slash as { name: string } | undefined)?.name,
    );
    expect(commandNames).toEqual(TUI_COMMAND_IDS);
    for (const slashName of TUI_COMMAND_IDS) {
      expect(
        keymapLayers[0]?.commands.filter(
          (command) => (command.slash as { name: string } | undefined)?.name === slashName,
        ),
      ).toHaveLength(1);
    }
    expect(dialog.replace).not.toHaveBeenCalled();
  });

  describe.each(["inline", "dialog"] as const)("%s native command display", (commandDisplay) => {
    it.each(
      TUI_COMMAND_GROUPS,
    )("routes /%s and /%s once without model execution", async (...commands) => {
      const plugin = await loadTuiModule();
      const { api, keymapLayers, dialog } = createApi();
      // V2 prompts for argument-capable commands; a blank answer runs them with
      // no optional arguments.
      dialog.prompt.mockResolvedValue("");

      resolveTuiSurfaceRegistration.mockResolvedValueOnce({
        commandDisplay,
        sidebar: { enabled: false },
        compact: {
          enabled: false,
          homeBottom: false,
          sessionPrompt: false,
          hasNativeProviderQuota: false,
          suppressedByNativeProviderQuota: false,
        },
        promptBar: { enabled: true },

        announcements: { homeBottom: false },
        homeBottom: false,
      });

      await startTui(plugin, api);
      for (const command of commands) {
        vi.clearAllMocks();
        const output = `${command} output`;
        buildQuotaDialogCommandOutput.mockResolvedValueOnce({
          state: "output",
          command,
          title: command,
          output,
          dialogSize: "xlarge",
        });
        const registeredCommand = keymapLayers[0]!.commands.find(
          (item) => (item.slash as { name: string } | undefined)?.name === command,
        )!;
        (registeredCommand.run as (input?: unknown) => void)({ arguments: "" });
        await Promise.resolve();
        await Promise.resolve();

        expect(buildQuotaDialogCommandOutput, command).toHaveBeenCalledOnce();
        expect(buildQuotaDialogCommandOutput, command).toHaveBeenCalledWith(
          expect.objectContaining({
            command,
            client: { config: {} },
            sessionID: "session-route",
          }),
        );
        if (commandDisplay === "inline") {
          expect(api.client.session.synthetic, command).toHaveBeenCalledOnce();
          expect(api.client.session.synthetic, command).toHaveBeenCalledWith({
            sessionID: "session-route",
            text: "",
            description: output,
            resume: false,
          });
          expect(dialog.replace, command).not.toHaveBeenCalled();
        } else {
          expect(api.client.session.synthetic, command).not.toHaveBeenCalled();
          expect(dialog.replace, command).toHaveBeenCalledTimes(2);
        }
        expect(api.client.session.command, command).not.toHaveBeenCalled();
      }
    });
  });

  it("selects Home dialog destination before executing an inline-configured command", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    api.route.current = { type: "home" };
    let dialogCallsAtExecution = 0;
    buildQuotaDialogCommandOutput.mockImplementationOnce(async () => {
      dialogCallsAtExecution = dialog.replace.mock.calls.length;
      return {
        state: "output",
        command: "quota",
        title: "OpenCode Quota",
        output: "Home quota output",
        dialogSize: "xlarge",
      };
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const quota = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "quota",
    )!;
    (quota.run as (input?: unknown) => void)({ arguments: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(dialogCallsAtExecution).toBe(1);
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.synthetic).not.toHaveBeenCalled();
    expect(dialog.replace).toHaveBeenCalledTimes(2);
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it.each([
    "inline",
    "dialog",
  ] as const)("keeps command no-op behavior in %s mode", async (commandDisplay) => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    // `/pricing_refresh` is argument-capable in V2, so answer its prompt.
    dialog.prompt.mockResolvedValue("");
    buildQuotaDialogCommandOutput.mockResolvedValueOnce({
      state: "noop",
      command: "pricing_refresh",
      reason: "disabled",
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay,
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const refresh = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "pricing_refresh",
    )!;
    (refresh.run as (input?: unknown) => void)({ arguments: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.synthetic).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
    if (commandDisplay === "inline") {
      expect(dialog.replace).not.toHaveBeenCalled();
      expect(dialog.clear).not.toHaveBeenCalled();
    } else {
      expect(dialog.replace).toHaveBeenCalledOnce();
      expect(dialog.clear).toHaveBeenCalledOnce();
    }
  });

  it("shows the command error without falling back to quota output dialog when inline injection fails", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    api.client.session.synthetic.mockRejectedValueOnce(new Error("prompt unavailable"));

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const quota = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "quota",
    )!;
    (quota.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.client.session.synthetic).toHaveBeenCalledOnce();
    expect(dialog.replace).toHaveBeenCalledOnce();
    const errorDialog = dialog.replace.mock.calls[0]![0]() as any;
    expect(errorDialog.props.children).not.toContain("Quota line 1");
    expect(api.ui.toast).toHaveBeenCalledWith({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("collects optional arguments with the V2 dialog prompt before running an argument-capable command", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const status = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "quota_status",
    )!;

    dialog.prompt.mockResolvedValueOnce('  {"force":true}  ');
    (status.run as (input?: unknown) => void)();

    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    // OpenCode 2 exposes `context.ui.dialog.prompt` instead of the V1
    // `DialogPrompt` renderable.
    expect(dialog.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "OpenCode Quota Status Options" }),
    );

    await flushPromises();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        arguments: '{"force":true}',
      }),
    );
    expect(api.client.session.synthetic).toHaveBeenCalledOnce();
    expect(api.client.session.synthetic).toHaveBeenCalledWith({
      sessionID: "session-route",
      text: "",
      description: "Quota line 1\n\nQuota line 3",
      resume: false,
    });
    expect(api.client.session.command).not.toHaveBeenCalled();

    // A blank optional submit runs the command with no arguments instead of
    // prompting again.
    dialog.prompt.mockResolvedValueOnce("   ");
    (status.run as (input?: unknown) => void)();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_status", arguments: undefined }),
    );
    expect(api.client.session.synthetic).toHaveBeenCalledTimes(2);

    const announcements = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "quota_announcements",
    )!;
    dialog.prompt.mockResolvedValueOnce("   ");
    (announcements.run as (input?: unknown) => void)();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_announcements" }),
    );
    expect(api.client.session.synthetic).toHaveBeenCalledTimes(3);
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("keeps argument input in a dialog and routes final output to configured Dialog mode", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "dialog",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const between = keymapLayers[0]!.commands.find(
      (command) => (command.slash as { name: string } | undefined)?.name === "tokens_between",
    )!;
    dialog.prompt.mockResolvedValueOnce("2026-01-01 2026-01-15");
    (between.run as (input?: unknown) => void)();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    expect(dialog.prompt).toHaveBeenCalledOnce();

    await flushPromises();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "2026-01-01 2026-01-15",
      }),
    );
    // Loading + output dialogs (the prompt is a Promise in V2).
    expect(dialog.replace).toHaveBeenCalledTimes(2);
    expect(api.client.session.synthetic).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("keeps stable hosts registered while activating sidebar and compact surfaces independently", async () => {
    const plugin = await loadTuiModule();
    const sidebarOnly = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: false },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, sidebarOnly.api);

    expect(sidebarOnly.registered).toHaveLength(2);
    expect(sidebarOnly.registered.map((entry) => entry.order)).toEqual([150, 90]);
    sidebarOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(
      sidebarOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(
      sidebarOnly.registered[1].slots.session_prompt({}, { session_id: "session-1" }),
    ).toBeNull();
    expect(sidebarOnly.registered[1].slots.home_bottom({}, {})).toBeNull();

    const compactOnly = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, compactOnly.api);

    expect(compactOnly.registered).toHaveLength(2);
    expect(compactOnly.registered.map((entry) => entry.order)).toEqual([150, 90]);
    expect(
      compactOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).toBeNull();
    compactOnly.registered[1].slots.session_prompt({}, { session_id: "session-1" });
    await flushPromises();
    expect(
      compactOnly.registered[1].slots.session_prompt({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(compactOnly.registered[1].slots.home_bottom({}, {})).not.toBeNull();

    const enabled = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, enabled.api);

    expect(enabled.registered).toHaveLength(2);
    expect(enabled.registered[0].order).toBe(150);
    expect(Object.keys(enabled.registered[0].slots)).toEqual(["sidebar_content"]);
    expect(enabled.registered[1].order).toBe(90);
    expect(Object.keys(enabled.registered[1].slots)).toEqual([
      "session_prompt",
      "prompt_footer",
      "home_bottom",
    ]);
  });

  it("renders sidebar summary count from runtime state and persists detail toggles", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, kvStore } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: {
        status: "ready",
        lines: ["OpenCode Go Five-hour 98%"],
        linesExpanded: [
          "[OpenCode Go]",
          "Five-hour window 98%",
          "Weekly window 53%",
          "Monthly window 33%",
        ],
        providerCount: 2,
      },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const collapsed = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const collapsedHeader = collapsed.props.children[0];
    expect(collapsedHeader.props.children[0].props.children.props.children).toBe("▶ Quota");
    expect(collapsedHeader.props.children[1].props.children).toEqual([" (", 2, " providers)"]);
    expect(
      collapsed.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["OpenCode Go Five-hour 98%"]);

    collapsedHeader.props.children[0].props.onMouseDown();

    // V2 writes through `context.storage.memory`, which the harness mirrors
    // into the recorded store.
    expect(kvStore["quota-sidebar-collapsed"]).toBe(false);

    const expanded = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const expandedHeader = expanded.props.children[0];
    expect(expandedHeader.props.children[0].props.children.props.children).toBe("▼ Quota");
    expect(
      expanded.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["[OpenCode Go]", "Five-hour window 98%", "Weekly window 53%", "Monthly window 33%"]);
  });

  it("keeps sidebar collapse icons while naming the bare percent mode", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: {
        status: "ready",
        lines: ["OpenCode Go 98%"],
        linesExpanded: ["[OpenCode Go]", "Five-hour 98%"],
        headerPercentMode: "used",
      },
      compact: { status: "disabled" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const registration = registered.find((item) => item.order === 150)!;
    registration.slots.sidebar_content({}, { session_id: "session-mode" });
    await Promise.resolve();

    const collapsed = registration.slots.sidebar_content({}, { session_id: "session-mode" }) as any;
    const header = collapsed.props.children[0].props.children[0];
    expect(header.props.children.props.children).toBe("▶ Quota [Used]");

    header.props.onMouseDown();
    const expanded = registration.slots.sidebar_content({}, { session_id: "session-mode" }) as any;
    expect(expanded.props.children[0].props.children[0].props.children.props.children).toBe(
      "▼ Quota [Used]",
    );
  });

  it("keeps non-expandable empty sidebar panels visible while collapsed", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "ready", lines: [] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const rendered = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const header = rendered.props.children[0];
    expect(header.props.children[0].props.children.props.children).toBe("Quota");
    expect(rendered.props.children[1].props.children[0].props.children).toBe("Unavailable");
  });

  it("activates only the sidebar host when surface resolution fails", async () => {
    const plugin = await loadTuiModule();
    const fallback = createApi();

    resolveTuiSurfaceRegistration.mockRejectedValueOnce(new Error("config unavailable"));

    await startTui(plugin, fallback.api);

    expect(fallback.registered).toHaveLength(2);
    expect(fallback.registered.map((entry) => entry.order)).toEqual([150, 90]);
    fallback.registered[0].slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(
      fallback.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(fallback.registered[1].slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(fallback.registered[1].slots.home_bottom({}, {})).toBeNull();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "session-1" }),
    );
  });

  it("does not register right-side compact slots", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const slotNames = registered.flatMap((registration) => Object.keys(registration.slots));
    expect(slotNames).toContain("session_prompt");
    expect(slotNames).toContain("home_bottom");
    expect(slotNames).not.toContain("session_prompt_right");
    expect(slotNames).not.toContain("home_prompt_right");
  });

  it("preserves session refresh delays, event filtering, interval refresh, and mount recovery", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, emit } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);

    emit("session.updated", { properties: { info: { id: "other" } } });
    await vi.advanceTimersByTimeAsync(600);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);

    emit("session.updated", { properties: { info: { id: "session-1" } } });
    await vi.advanceTimersByTimeAsync(149);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(450);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(54_800);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(7);
  });

  it("coalesces in-flight session refreshes and accepts the active completion before its follow-up", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const first = deferred<{
      sidebar: { status: "ready"; lines: string[] };
      compact: { status: "ready"; text: string };
    }>();
    const second = deferred<{
      sidebar: { status: "ready"; lines: string[] };
      compact: { status: "ready"; text: string };
    }>();
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();

    first.resolve({
      sidebar: { status: "ready", lines: ["initial"] },
      compact: { status: "ready", text: "initial" },
    });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(2);
    let rendered = sidebar({}, { session_id: "session-1" }) as any;
    expect(rendered.props.children[1].props.children[0].props.children).toBe("initial");

    second.resolve({
      sidebar: { status: "ready", lines: ["refreshed"] },
      compact: { status: "ready", text: "refreshed" },
    });
    await flushPromises();
    rendered = sidebar({}, { session_id: "session-1" });
    expect(rendered.props.children[1].props.children[0].props.children).toBe("refreshed");
  });

  it("keeps shared session resources alive until the final release and then disposes them", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, unsubscribers } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();

    cleanupFns.shift()!();
    expect(unsubscribers.every((unsubscribe) => !unsubscribe.mock.calls.length)).toBe(true);
    cleanupFns.shift()!();
    // The V1 four session events expand to 13 V2 event subscriptions; the two
    // toast-runtime subscriptions stay until plugin disposal.
    const disposed = unsubscribers.filter((unsubscribe) => unsubscribe.mock.calls.length === 1);
    expect(disposed).toHaveLength(13);
    expect(unsubscribers).toHaveLength(15);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
  });

  it("keeps home free of mount recovery and exports only accepted refreshes", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, emit } = createApi();
    const first = deferred<HomeBottomState>();
    const second = deferred<HomeBottomState>();
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });

    await startTui(plugin, api);
    registered.find((registration) => registration.order === 90)!.slots.home_bottom({}, {});
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();

    emit("message.updated", { properties: {} });
    await vi.advanceTimersByTimeAsync(600);
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();

    first.resolve({
      status: "ready",
      compact: { status: "ready", text: "initial" },
    });
    await flushPromises();
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledTimes(2);
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledOnce();

    second.resolve({
      status: "ready",
      compact: { status: "ready", text: "refreshed" },
    });
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledTimes(2);
  });

  it("ignores rejected and disposed home completions without exporting", async () => {
    const plugin = await loadTuiModule();
    const rejected = createApi();
    loadTuiHomeBottomStatus.mockRejectedValueOnce(new Error("unavailable"));
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });
    await startTui(plugin, rejected.api);
    rejected.registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {});
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).not.toHaveBeenCalled();

    const disposed = createApi();
    const pending = deferred<HomeBottomState>();
    loadTuiHomeBottomStatus.mockReturnValueOnce(pending.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });
    await startTui(plugin, disposed.api);
    disposed.registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {});
    cleanupFns.pop()!();
    pending.resolve({ status: "ready", compact: { status: "disabled" } });
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).not.toHaveBeenCalled();
  });

  it("renders home compact status centered with a blank line above it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    const loading = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(loading).toMatchObject({
      type: "box",
      props: {
        children: [
          { type: "text", props: { children: " " } },
          null,
          {
            type: "box",
            props: {
              children: {
                type: "text",
                props: { children: "Quota loading…" },
              },
            },
          },
        ],
      },
    });

    await Promise.resolve();

    const rendered = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(rendered).toMatchObject({
      type: "box",
      props: {
        gap: 0,
        children: [
          {
            type: "text",
            props: { children: " " },
          },
          null,
          {
            type: "box",
            props: {
              flexDirection: "row",
              justifyContent: "center",
              children: {
                type: "text",
                props: {
                  fg: "muted",
                  wrapMode: "none",
                  children: "Home quota",
                },
              },
            },
          },
        ],
      },
    });
  });

  it("keeps announcement-only home host empty until a delayed announcement populates it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    let resolveBottom!: (value: {
      status: "ready";
      announcementText: string;
      compact: { status: "disabled" };
    }) => void;
    loadTuiHomeBottomStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBottom = resolve;
      }),
    );
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const homeBottom = registered.find((registration) => registration.order === 90)!.slots
      .home_bottom;
    const empty = homeBottom({}, {}) as any;
    expect(empty).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });

    resolveBottom({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "disabled" },
    });
    await Promise.resolve();

    const populated = homeBottom({}, {}) as any;
    expect(populated.type).toBe("box");
    expect(populated.props.children[0]).toMatchObject({
      type: "text",
      props: { children: " " },
    });
    expect(populated.props.children[1]).toMatchObject({
      type: "box",
      props: {
        children: {
          type: "text",
          props: {
            children: "Notice: Maintainer announcement available. Run /quota_announcements.",
          },
        },
      },
    });
    expect(populated.props.children[2]).toBeNull();
  });

  it("keeps export-only home host empty while still writing the export", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    loadTuiHomeBottomStatus.mockResolvedValueOnce({
      status: "disabled",
      compact: { status: "disabled" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const rendered = registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {}) as any;
    expect(rendered).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });
    await Promise.resolve();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledOnce();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledWith(expect.anything());
  });

  it("renders the prompt bar directly from the V2 composer slot without a V1 Prompt wrapper", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: false,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: {
          name: "Copilot 5h",
          percentRemaining: 50,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
        percentDisplayMode: "remaining",
      },
    });

    await startTui(plugin, api);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    compactRegistration!.slots.session_prompt({}, { session_id: "session-1" });
    await flushPromises();
    const hint = compactRegistration!.slots.session_prompt({}, { session_id: "session-1" }) as any;

    expect(hint.type).toBe("box");
    expect(hint.props).toMatchObject({
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 1,
    });
    expect(hint.props).not.toHaveProperty("position");
    expect(hint.props).not.toHaveProperty("left");
    expect(hint.props).not.toHaveProperty("bottom");
    expect(hint.props.children[1].props.children).toHaveLength(12);
    expect(hint.props.children[2].props.children).toContain(" | ");
    expect(hint.props.children[2].props.children).not.toContain("·");

    // OpenCode 2 removed the V1 `ui.Prompt` wrapper the slot used to forward.
    expect((api.ui as Record<string, unknown>).Prompt).toBeUndefined();
  });

  it("renders a structured prompt-bar value without percentage bar cells", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },
      announcements: { homeBottom: false },
      homeBottom: false,
    });
    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: { semanticSegment: "Cursor: Known API spend USD 12.50" },
        percentDisplayMode: "remaining",
      },
    });

    await startTui(plugin, api);
    const registration = registered.find((item) => item.order === 90)!;
    registration.slots.session_prompt({}, { session_id: "session-rich" });
    await flushPromises();
    const rendered = registration.slots.session_prompt({}, { session_id: "session-rich" }) as any;
    const hint = rendered;

    expect(hint.props.children[0].props.children).toBe("Cursor: Known API spend USD 12.50");
    expect(JSON.stringify(hint)).not.toMatch(/[█░▓▒]/u);
  });

  it("renders exact reset and runway text with the 12-cell prompt bar", async () => {
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },
      announcements: { homeBottom: false },
      homeBottom: false,
    });
    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: {
          name: "OpenAI Weekly",
          percentRemaining: 50,
          resetTimeIso: "2026-01-17T15:14:00.000Z",
          runway: {
            kind: "before_reset",
            projectedAtIso: "2026-01-15T11:50:00.000Z",
          },
        },
        percentDisplayMode: "remaining",
      },
    });

    await startTui(plugin, api);
    const registration = registered.find((item) => item.order === 90)!;
    registration.slots.session_prompt({}, { session_id: "session-reset" });
    await flushPromises();
    const rendered = registration.slots.session_prompt({}, { session_id: "session-reset" }) as any;
    const hint = rendered;

    expect(hint.props.children[1].props.children).toHaveLength(12);
    expect(hint.props.children[2].props.children).toBe("50% | 2d5h14m | r/o ≈ 1h 50m");
  });

  it("keeps the prompt percentage bare while spacing reset units", async () => {
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },
      announcements: { homeBottom: false },
      homeBottom: false,
    });
    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: {
          name: "OpenAI Weekly",
          percentRemaining: 81,
          resetTimeIso: "2026-01-17T15:14:00.000Z",
        },
        percentDisplayMode: "used",
        resetTimeSpaced: true,
      },
    });

    await startTui(plugin, api);
    const registration = registered.find((item) => item.order === 90)!;
    registration.slots.session_prompt({}, { session_id: "session-spaced-reset" });
    await flushPromises();
    const rendered = registration.slots.session_prompt(
      {},
      { session_id: "session-spaced-reset" },
    ) as any;
    const hint = rendered;

    expect(hint.props.children[1].props.children).toBe(`██${"░".repeat(10)}`);
    expect(hint.props.children[2].props.children).toBe("19% | 2d 5h 14m");
  });
});
