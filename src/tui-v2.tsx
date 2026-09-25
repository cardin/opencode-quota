/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";

import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { formatQuotaRows } from "./lib/format.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds,
} from "./lib/maintainer-announcements.js";
import { getQuotaProviderShape, normalizeQuotaProviderId } from "./lib/provider-metadata.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import {
  buildQuotaExport,
  createExportProviderContext,
  resolveExportPath,
  writeQuotaExport,
} from "./lib/quota-export.js";
import { resolveQuotaFormatStyle } from "./lib/quota-format-style.js";
import {
  type CollectQuotaRenderDataResult,
  collectConcreteEnabledProviderIds,
  collectQuotaRenderData,
} from "./lib/quota-render-data.js";
import {
  formatQuotaResetNotification,
  observeQuotaResetNotifications,
} from "./lib/quota-reset-notifications.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  type QuotaRuntimeContext,
  type QuotaSessionModelContext,
  resolveQuotaRuntimeContext,
} from "./lib/quota-runtime-context.js";
import { buildCompactQuotaStatusLine } from "./lib/tui-compact-format.js";
import {
  formatPromptBarPercentMeta,
  pickPromptBarEntry,
  resolvePromptBarLabel,
} from "./lib/tui-prompt-bar-format.js";
import { buildSidebarQuotaPanelLines } from "./lib/tui-sidebar-format.js";
import type { QuotaToastConfig } from "./lib/types.js";

const terminalForeground = RGBA.defaultForeground();
const REFRESH_INTERVAL_MS = 60_000;

type TuiEvent = { data?: Record<string, unknown> };
type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
type TuiContext = {
  location?: { directory: string };
  data: {
    on: (event: string, handler: (event: TuiEvent) => void) => () => void;
    session: {
      get: (sessionID: string) => { model?: { id: string; providerID: string } } | undefined;
    };
    location?: {
      default: () => { directory: string };
      provider: { list: (location: { directory: string }) => Array<{ id: string }> | undefined };
    };
  };
  keymap: {
    layer: (
      build: () => {
        mode: "global";
        commands: Array<{
          id: string;
          title: string;
          group: string;
          palette: true;
          slash: { name: string; arguments?: true };
          run: (input?: string) => Promise<void>;
        }>;
      },
    ) => void;
  };
  ui: {
    slot: (
      claim:
        | { append: "app"; render: () => null }
        | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element }
        | { append: "prompt.footer" | "home.footer.status"; render: () => JSX.Element },
    ) => () => void;
    toast: { show: (toast: Toast) => void };
    dialog: {
      alert: (params: { title: string; message: string }) => Promise<unknown>;
      prompt: (params: { title: string; placeholder?: string }) => Promise<string | undefined>;
      set: (params: { size: "medium" | "large" | "xlarge" }) => void;
    };
  };
};

function getSessionID(event: TuiEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

function quotaClient(context: TuiContext) {
  return {
    config: {
      get: async () => ({ data: {} }),
      providers: async () => ({
        data: {
          providers:
            context.data.location?.provider.list(
              context.location ?? context.data.location.default(),
            ) ?? [],
        },
      }),
    },
  };
}

/** Same project roots as the server plugin: the location's Git worktree, else the location directory. */
function quotaRoots(context: TuiContext) {
  return resolveOpenCodeLocationRoots(context.location?.directory ?? process.cwd());
}

async function getSessionModelMeta(
  context: TuiContext,
  sessionID: string,
): Promise<QuotaSessionModelContext> {
  const model = context.data.session.get(sessionID)?.model;
  return model ? { modelID: model.id, providerID: model.providerID } : {};
}

async function getQuotaMessage(
  context: TuiContext,
  sessionID: string,
  surface: "sidebar" | "idle" | "compacted" | "question",
): Promise<
  | { message: string; duration: number; activeProviderCount: number; resetNotification?: string }
  | undefined
> {
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient(context),
    roots: quotaRoots(context),
    sessionID,
    resolveSessionMeta: (id) => getSessionModelMeta(context, id),
    includeSessionMeta: (config) => config.onlyCurrentModel,
  });
  const config = runtime.config;
  if (!config.enabled) return;
  if (surface === "sidebar") {
    if (!config.tuiSidebarPanel.enabled) return;
  } else if (!config.enableToast) {
    return;
  }
  if (
    (surface === "idle" && !config.showOnIdle) ||
    (surface === "compacted" && !config.showOnCompact) ||
    (surface === "question" && !config.showOnQuestion)
  ) {
    return;
  }

  if (
    surface !== "sidebar" &&
    config.debug &&
    config.enabledProviders !== "auto" &&
    config.enabledProviders.length === 0
  ) {
    return {
      message: sanitizeDisplayText(
        formatQuotaToastDebugInfo({
          trigger: surface,
          reason: "enabledProviders empty",
          config,
          configMeta: runtime.configMeta,
        }),
      ),
      duration: config.toastDurationMs,
      activeProviderCount: 0,
    };
  }

  const rootFormatStyle = resolveQuotaFormatStyle(config.formatStyle);
  const formatStyle =
    surface === "sidebar" && config.tuiSidebarPanel.formatStyle
      ? resolveQuotaFormatStyle(config.tuiSidebarPanel.formatStyle)
      : rootFormatStyle;
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    surfaceExplicitProviderIssues: true,
    formatStyle,
    providers: runtime.providers,
  });
  let resetNotification: string | undefined;
  if (
    surface !== "sidebar" &&
    config.resetNotifications.enabled &&
    result.providerResults.length > 0
  ) {
    try {
      const notices = await observeQuotaResetNotifications({
        providers: result.providerResults,
        windows: config.resetNotifications.windows,
      });
      resetNotification = formatQuotaResetNotification(notices) ?? undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[opencode-quota] failed to observe quota reset transitions: ${reason}`);
    }
  }
  const data = result.data;
  const message =
    surface === "sidebar"
      ? data
        ? buildSidebarQuotaPanelLines({
            data,
            config: {
              ...config,
              formatStyle,
            },
          }).join("\n")
        : undefined
      : getToastMessage({ trigger: surface, runtime, result, style: rootFormatStyle });
  return message
    ? {
        message: sanitizeDisplayText(message),
        duration: config.toastDurationMs,
        activeProviderCount: result.active.length,
        resetNotification,
      }
    : undefined;
}

function getToastMessage(params: {
  trigger: string;
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  style: ReturnType<typeof resolveQuotaFormatStyle>;
}): string | undefined {
  const config = params.runtime.config;
  const { availability, active, hasExplicitProviderIssues, data } = params.result;
  const debugInfo = (reason: string) =>
    formatQuotaToastDebugInfo({
      trigger: params.trigger,
      reason,
      config,
      configMeta: params.runtime.configMeta,
      currentModel: params.result.selection?.currentModel,
      availability: availability.map((item) => ({ id: item.provider.id, ok: item.ok })),
    });

  if (data?.entries.length || data?.sessionTokens) {
    const formatted = formatQuotaRows({
      version: "2.0.0",
      layout: config.layout,
      entries: data?.entries ?? [],
      errors: data?.errors ?? [],
      style: params.style,
      percentDisplayMode: config.percentDisplayMode,
      resetTimeDecimals: config.resetTimeDecimals,
      sessionTokens: data?.sessionTokens,
    });
    if (!config.debug) return formatted;
    const debugFooter = `\n\n[debug] src=${params.runtime.configMeta.source} providers=${config.enabledProviders === "auto" ? "(auto)" : config.enabledProviders.join(",") || "(none)"} avail=${availability
      .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
      .join(" ")}`;
    return formatted + debugFooter;
  }

  if (config.showOnBothFail && data?.errors.length) {
    const errorLines = data.errors.map((error) => `${error.label}: ${error.message}`).join("\n");
    if (!config.debug) return errorLines;
    return `${errorLines}\n\n${debugInfo(
      hasExplicitProviderIssues ? "providers missing/unavailable" : "all providers failed",
    )}`;
  }

  if (!config.debug) return undefined;
  return debugInfo(active.length === 0 ? "no enabled providers available" : "no entries");
}

function formatQuotaToastDebugInfo(params: {
  trigger: string;
  reason: string;
  config: QuotaToastConfig;
  configMeta: Pick<QuotaRuntimeContext["configMeta"], "source" | "paths">;
  currentModel?: string;
  availability?: Array<{ id: string; ok: boolean }>;
}): string {
  const availability = params.availability
    ? params.availability.map((item) => `${item.id}=${item.ok ? "ok" : "no"}`).join(" ")
    : "unknown";

  const providers =
    params.config.enabledProviders === "auto"
      ? "(auto)"
      : params.config.enabledProviders.length > 0
        ? params.config.enabledProviders.join(",")
        : "(none)";

  const modelPart = params.currentModel ? ` model=${params.currentModel}` : "";
  const paths = params.configMeta.paths.length > 0 ? params.configMeta.paths.join(" | ") : "(none)";

  return [
    "Quota Toast Debug (opencode-quota)",
    `trigger=${params.trigger} reason=${params.reason}`,
    `configSource=${params.configMeta.source} paths=${paths}`,
    `enabled=${params.config.enabled} providers=${providers}${modelPart}`,
    `available=${availability}`,
  ].join("\n");
}

async function getHomeAnnouncementText(runtime: QuotaRuntimeContext): Promise<string> {
  const announcements = BUNDLED_MAINTAINER_ANNOUNCEMENTS;
  const targetProviderIds = new Set(getMaintainerAnnouncementTargetProviderIds({ announcements }));
  const announcementProviders = runtime.providers.filter((provider) => {
    const shape = getQuotaProviderShape(normalizeQuotaProviderId(provider.id));
    return shape ? targetProviderIds.has(shape.id) : false;
  });
  const providerIds = await collectConcreteEnabledProviderIds({
    providers: announcementProviders,
    ctx: createQuotaProviderRuntimeContext(runtime),
    enabledProviders: runtime.config.enabledProviders,
  });
  const summary = getMaintainerAnnouncementsSummary({
    enabledProviders: providerIds,
    announcements,
  });
  return formatMaintainerAnnouncementHomeCountLine(summary.activeCount);
}

async function getQuotaFooter(
  context: TuiContext,
  sessionID: string | undefined,
  surface: "prompt" | "home",
): Promise<string[]> {
  const resolvedRuntime = await resolveQuotaRuntimeContext({
    client: quotaClient(context),
    roots: quotaRoots(context),
    sessionID,
    resolveSessionMeta: (id) => getSessionModelMeta(context, id),
    includeSessionMeta: (config) => config.onlyCurrentModel && surface === "prompt",
  });
  // Home has no session: as in v4, it shows every enabled provider and no session
  // tokens, and shares its cache keys with the export (createExportProviderContext).
  const runtime: QuotaRuntimeContext =
    surface === "home"
      ? {
          ...resolvedRuntime,
          config: { ...resolvedRuntime.config, onlyCurrentModel: false, showSessionTokens: false },
          session: {},
        }
      : resolvedRuntime;
  const config = runtime.config;
  if (!config.enabled) return [];
  if (
    surface === "prompt" &&
    !config.tuiPromptBar.enabled &&
    !(config.tuiCompactStatus.enabled && config.tuiCompactStatus.sessionPrompt)
  )
    return [];
  const announcementEnabled =
    surface === "home" &&
    config.maintainerAnnouncements.enabled &&
    config.maintainerAnnouncements.home;
  const homeCompactEnabled = config.tuiCompactStatus.enabled && config.tuiCompactStatus.homeBottom;
  if (surface === "home" && !announcementEnabled && !homeCompactEnabled) return [];
  const announcement = announcementEnabled ? await getHomeAnnouncementText(runtime) : "";
  if (surface === "home" && !homeCompactEnabled) return announcement ? [announcement] : [];
  const rootFormatStyle = resolveQuotaFormatStyle(config.formatStyle);
  const compactFormatStyle = config.tuiCompactStatus.formatStyle
    ? resolveQuotaFormatStyle(config.tuiCompactStatus.formatStyle)
    : rootFormatStyle;
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    surfaceExplicitProviderIssues: true,
    formatStyle: rootFormatStyle,
    providers: runtime.providers,
    includeAllWindowsData: true,
  });
  const data = result.data;
  if (!data) return announcement ? [announcement] : [];
  if (surface === "prompt" && config.tuiPromptBar.enabled) {
    const entry = pickPromptBarEntry(data);
    if (!entry) return [];
    const promptBar = sanitizeDisplayText(
      [
        resolvePromptBarLabel(entry),
        entry.percentRemaining === undefined
          ? ""
          : formatPromptBarPercentMeta({
              percentRemaining: entry.percentRemaining,
              percentDisplayMode: config.percentDisplayMode,
              resetTimeIso: entry.resetTimeIso,
              resetTimeDecimals: config.resetTimeDecimals,
              resetTimeSpaced: config.resetTimeSpaced,
              runway: entry.runway,
            }),
      ]
        .filter(Boolean)
        .join(" | "),
    );
    return promptBar ? [promptBar] : [];
  }
  const compactData =
    compactFormatStyle === "allWindows" && result.allWindowsData
      ? result.allWindowsData
      : compactFormatStyle === "singleWindow" && result.singleWindowData !== undefined
        ? result.singleWindowData
        : data;
  const compact = compactData
    ? buildCompactQuotaStatusLine({
        data: compactData,
        maxWidth: config.tuiCompactStatus.maxWidth,
        percentDisplayMode: config.percentDisplayMode,
        accountingDetail: config.accountingDetail,
        resetTimeSpaced: config.resetTimeSpaced,
      })
    : "";
  return [announcement, compact].filter(Boolean);
}

/**
 * One view's refresh loop, as in v4 (tui-refresh-lifecycle.ts): a refresh that
 * arrives while a load runs is coalesced into one follow-up load, and a result is
 * dropped when the view was disposed or a newer load started.
 */
function createViewRefresh<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
): { refresh: () => void; dispose: () => void } {
  let disposed = false;
  let loadVersion = 0;
  let inFlight = false;
  let queued = false;
  const refresh = () => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    const currentVersion = ++loadVersion;
    void load()
      .then((value) => {
        if (disposed || currentVersion !== loadVersion) return;
        apply(value);
      })
      .catch(reportFailure)
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        if (queued) {
          queued = false;
          refresh();
        }
      });
  };
  return {
    refresh,
    dispose: () => {
      disposed = true;
    },
  };
}

function QuotaFooter(props: {
  context: TuiContext;
  sessionID?: string;
  surface: "prompt" | "home";
}): JSX.Element {
  const [lines, setLines] = createSignal<string[]>([]);
  const view = createViewRefresh(
    () => getQuotaFooter(props.context, props.sessionID, props.surface),
    (next) => {
      setLines(next);
      if (props.surface !== "home") return;
      // Fire-and-forget: write the export file if enabled. A failed write
      // must never affect rendering, so log a warning and continue.
      void writeQuotaExportIfEnabled(props.context).catch((error) => {
        console.warn(`[opencode-quota] quota export write failed: ${String(error)}`);
      });
    },
  );
  view.refresh();
  const interval = setInterval(view.refresh, REFRESH_INTERVAL_MS);
  const stop = props.context.data.on("session.step.ended", (event) => {
    if (props.surface === "home" || getSessionID(event) === props.sessionID) view.refresh();
  });
  onCleanup(() => {
    view.dispose();
    clearInterval(interval);
    stop();
  });
  return (
    <Show when={lines().length}>
      <box flexDirection="column">
        {lines().map((line) => (
          <text fg={terminalForeground}>{line}</text>
        ))}
      </box>
    </Show>
  );
}

/** Writes the quota export file if `config.export.enabled` is true. Errors propagate. */
async function writeQuotaExportIfEnabled(context: TuiContext): Promise<void> {
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient(context),
    roots: quotaRoots(context),
  });
  if (!runtime.config.enabled || !runtime.config.export.enabled) return;

  const exportData = await buildQuotaExport({
    providers: runtime.providers,
    ctx: createExportProviderContext(runtime),
    ttlMs: runtime.config.minIntervalMs,
    fromCache: true,
  });
  await writeQuotaExport(exportData, resolveExportPath(runtime.config.export.path));
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[opencode-quota] failed to load quota: ${message}`);
}

async function runQuotaCommand(
  context: TuiContext,
  command: QuotaDialogCommandId,
  sessionID: string | undefined,
  input?: string,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  let argumentsText = input?.trim() || undefined;
  // Only /tokens_between needs arguments. /quota_announcements and /pricing_refresh
  // accept typed arguments only to reject them, so they run without a prompt.
  if (command === "tokens_between" && argumentsText === undefined) {
    const value = await context.ui.dialog.prompt({
      title: spec.title,
      placeholder: "YYYY-MM-DD YYYY-MM-DD",
    });
    if (value === undefined) return;
    argumentsText = value.trim() || undefined;
  }

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: argumentsText,
      client: quotaClient(context),
      roots: quotaRoots(context),
      sessionID,
      resolveSessionMeta: (id) => getSessionModelMeta(context, id),
    });
    if (result.state === "noop") return;
    const alert = context.ui.dialog.alert({ title: result.title, message: result.output });
    context.ui.dialog.set({ size: result.dialogSize });
    await alert;
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    });
  }
}

function registerQuotaCommands(context: TuiContext, getSessionID: () => string | undefined): void {
  context.keymap.layer(() => ({
    mode: "global",
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      id: `quota.${spec.id}`,
      title: spec.title,
      group: "OpenCode Quota",
      palette: true,
      slash: spec.acceptsArguments
        ? { name: spec.slashName, arguments: true as const }
        : { name: spec.slashName },
      run: (input?: string) => runQuotaCommand(context, spec.id, getSessionID(), input),
    })),
  }));
}

function SidebarQuotaView(props: {
  context: TuiContext;
  sessionID: string;
  setActiveSessionID: (sessionID: string) => void;
}): JSX.Element {
  props.setActiveSessionID(props.sessionID);
  const [open, setOpen] = createSignal(true);
  const [quota, setQuota] = createSignal<
    { message: string; duration: number; activeProviderCount: number } | undefined
  >(undefined);
  const lines = () => quota()?.message.split("\n") ?? [];
  const expandable = () => lines().length > 2;
  const view = createViewRefresh(
    () => getQuotaMessage(props.context, props.sessionID, "sidebar"),
    setQuota,
  );
  view.refresh();
  const interval = setInterval(view.refresh, REFRESH_INTERVAL_MS);
  const unsubscribe = props.context.data.on("session.step.ended", (event) => {
    if (getSessionID(event) === props.sessionID) view.refresh();
  });
  onCleanup(() => {
    view.dispose();
    clearInterval(interval);
    unsubscribe();
  });

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => expandable() && setOpen((value) => !value)}
      >
        <Show when={expandable()}>
          <text fg={terminalForeground}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={terminalForeground}>
          <b>Quota</b>
          <Show when={expandable() && !open() && quota()?.activeProviderCount}>
            {(count: () => number) => ` (${count()} active)`}
          </Show>
        </text>
      </box>
      <Show when={quota()} fallback={<text fg={terminalForeground}>No quota data available</text>}>
        <Show when={!expandable() || open()}>
          {lines().map((line) => (
            <text fg={terminalForeground} wrapMode="none">
              {line || " "}
            </text>
          ))}
        </Show>
      </Show>
    </box>
  );
}

const plugin = Plugin.define({
  id: "@slkiser/opencode-quota",
  setup(context) {
    const api = context as unknown as TuiContext;
    let disposeEvents: (() => void) | undefined;
    let activeSessionID: string | undefined;
    const questionToolCalls = new Set<string>();
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        if (disposeEvents) return null;
        registerQuotaCommands(api, () => activeSessionID);
        const trigger = (event: TuiEvent, reason: "idle" | "compacted" | "question") => {
          const sessionID = getSessionID(event);
          if (!sessionID) return;
          activeSessionID = sessionID;
          void getQuotaMessage(api, sessionID, reason)
            .then((quota) => {
              if (!quota) return;
              api.ui.toast.show({
                variant: "info",
                title: "OpenCode Quota",
                message: quota.message,
                duration: quota.duration,
              });
              if (quota.resetNotification) {
                api.ui.toast.show({
                  variant: "success",
                  title: "Quota available",
                  message: sanitizeDisplayText(quota.resetNotification),
                  duration: quota.duration,
                });
              }
            })
            .catch(reportFailure);
        };
        const onExecutionSucceeded = api.data.on("session.execution.succeeded", (event) =>
          trigger(event, "idle"),
        );
        const onCompacted = api.data.on("session.compaction.ended", (event) =>
          trigger(event, "compacted"),
        );
        const onQuestionStarted = api.data.on("session.tool.input.started", (event) => {
          const id = event.data?.id;
          if (event.data?.name === "question" && typeof id === "string") {
            questionToolCalls.add(id);
          }
        });
        const onQuestionSucceeded = api.data.on("session.tool.success", (event) => {
          const id = event.data?.id;
          if (typeof id === "string" && questionToolCalls.delete(id)) trigger(event, "question");
        });
        const onQuestionFailed = api.data.on("session.tool.failed", (event) => {
          const id = event.data?.id;
          if (typeof id === "string") questionToolCalls.delete(id);
        });
        disposeEvents = () => {
          onExecutionSucceeded();
          onCompacted();
          onQuestionStarted();
          onQuestionSucceeded();
          onQuestionFailed();
          questionToolCalls.clear();
        };
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: (props) => (
        <SidebarQuotaView
          context={api}
          sessionID={props.sessionID}
          setActiveSessionID={(sessionID) => {
            activeSessionID = sessionID;
          }}
        />
      ),
    });
    const disposePrompt = api.ui.slot({
      append: "prompt.footer",
      render: () => <QuotaFooter context={api} sessionID={activeSessionID} surface="prompt" />,
    });
    const disposeHome = api.ui.slot({
      append: "home.footer.status",
      render: () => <QuotaFooter context={api} surface="home" />,
    });
    return () => {
      disposeEvents?.();
      disposeApp();
      disposeSidebar();
      disposePrompt();
      disposeHome();
    };
  },
});

export default plugin;
