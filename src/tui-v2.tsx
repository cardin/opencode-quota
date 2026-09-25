/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
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
import { readQuotaReport, readQuotaReportMetadata } from "./lib/quota-report-message.js";
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
type KeymapCommand = {
  id?: string;
  title: string;
  group: string;
  bind?: string;
  palette?: true;
  run: () => void | Promise<void>;
};
type DialogTheme = {
  text: { base: RGBA; muted: RGBA; action: { primary: { focused: RGBA } } };
  background: { action: { primary: { focused: RGBA } } };
};
type TuiContext = {
  location?: { directory: string };
  theme: { surface: (name: "dialog") => DialogTheme };
  data: {
    on: (event: string, handler: (event: TuiEvent) => void) => () => void;
    session: {
      get: (
        sessionID: string,
      ) => { parentID?: string; model?: { id: string; providerID: string } } | undefined;
    };
    location?: {
      default: () => { directory: string };
      provider: { list: (location: { directory: string }) => Array<{ id: string }> | undefined };
    };
  };
  keymap: {
    layer: (build: () => { mode: "global" | "modal"; commands: KeymapCommand[] }) => void;
  };
  ui: {
    slot: (
      claim:
        | { append: "app"; render: () => null }
        | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element }
        | { append: "prompt.footer"; render: (props: { sessionID?: string }) => JSX.Element }
        | { append: "home.footer.status"; render: () => JSX.Element },
    ) => () => void;
    router: {
      current: () => { type: "home" } | { type: "session"; sessionID: string } | { type: "plugin" };
    };
    toast: { show: (toast: Toast) => void };
    dialog: {
      show: (render: () => JSX.Element, onClose?: () => void) => void;
      clear: () => void;
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
  // OpenCode 2 also mounts the prompt footer under the Home prompt, without a
  // session. As in v4, the prompt line belongs to session prompts only.
  if (surface === "prompt" && !sessionID) return [];
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

/**
 * Shows command output like OpenCode's alert dialog, but inside a scrollbox so long
 * reports (/quota_status, /tokens_*) stay reachable. The mouse wheel scrolls the box;
 * arrows, PageUp/PageDown, and Home/End scroll it from the keyboard. Esc is handled by
 * the host dialog; Enter and the ok/esc labels close it.
 */
function QuotaOutputDialog(props: {
  context: TuiContext;
  title: string;
  message: string;
}): JSX.Element {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();
  // The host dialog starts a quarter of the way down the terminal. The remaining
  // 8 rows cover the title, ok button, paddings, gaps, and one spare row.
  const maxHeight = () => Math.max(1, Math.floor(dimensions().height * 0.75) - 8);
  let scroll: ScrollBoxRenderable | undefined;
  const close = () => props.context.ui.dialog.clear();

  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close", group: "Dialog", run: close },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => scroll?.scrollBy(1) },
      {
        bind: "pageup",
        title: "Scroll up one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(-maxHeight()),
      },
      {
        bind: "pagedown",
        title: "Scroll down one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(maxHeight()),
      },
      { bind: "home", title: "Scroll to top", group: "Dialog", run: () => scroll?.scrollTo(0) },
      {
        bind: "end",
        title: "Scroll to bottom",
        group: "Dialog",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }));

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
          {props.title}
        </text>
        <text fg={theme().text.muted} onMouseUp={close}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => {
            scroll = element;
          }}
          maxHeight={maxHeight()}
        >
          <text fg={theme().text.muted}>{props.message}</text>
        </scrollbox>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme().background.action.primary.focused}
          onMouseUp={close}
        >
          <text fg={theme().text.action.primary.focused}>ok</text>
        </box>
      </box>
    </box>
  );
}

function showQuotaOutputDialog(
  context: TuiContext,
  output: { title: string; message: string; dialogSize: "medium" | "large" | "xlarge" },
): Promise<void> {
  return new Promise<void>((resolve) => {
    context.ui.dialog.show(
      () => <QuotaOutputDialog context={context} title={output.title} message={output.message} />,
      resolve,
    );
    context.ui.dialog.set({ size: output.dialogSize });
  });
}

/** Runs a quota command from the command palette. It opens the dialog and posts no message. */
async function runQuotaCommand(
  context: TuiContext,
  command: QuotaDialogCommandId,
  sessionID: string | undefined,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  let argumentsText: string | undefined;
  // Only /tokens_between needs arguments; the palette asks for them.
  if (command === "tokens_between") {
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
    await showQuotaOutputDialog(context, {
      title: result.title,
      message: result.output,
      dialogSize: result.dialogSize,
    });
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * Typed quota slash commands run on the server, which posts the report into the chat.
 * When a report arrives for the session on screen, open it in the dialog too.
 */
function showPostedQuotaReport(context: TuiContext, event: TuiEvent): void {
  const sessionID = getSessionID(event);
  if (!sessionID || sessionID !== getRouteSessionID(context)) return;
  const item = event.data?.item as
    | { type?: string; payload?: { text?: unknown; metadata?: Record<string, unknown> } }
    | undefined;
  if (item?.type !== "user" || typeof item.payload?.text !== "string") return;
  const report = readQuotaReportMetadata(item.payload.metadata);
  if (!report) return;
  const spec = QUOTA_DIALOG_COMMANDS.find((candidate) => candidate.id === report.command);
  if (!spec) return;
  void showQuotaOutputDialog(context, {
    title: report.title,
    message: readQuotaReport(item.payload.text),
    dialogSize: spec.dialogSize,
  });
}

function getRouteSessionID(context: TuiContext): string | undefined {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

function registerQuotaCommands(context: TuiContext): void {
  context.keymap.layer(() => ({
    mode: "global",
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      id: `quota.${spec.id}`,
      title: spec.title,
      group: "OpenCode Quota",
      // No slash entry: the server plugin registers the "/" commands, so each is listed once.
      palette: true,
      run: () => runQuotaCommand(context, spec.id, getRouteSessionID(context)),
    })),
  }));
}

function SidebarQuotaView(props: { context: TuiContext; sessionID: string }): JSX.Element {
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
    const questionToolCalls = new Set<string>();
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        if (disposeEvents) return null;
        registerQuotaCommands(api);
        const trigger = (event: TuiEvent, reason: "idle" | "compacted" | "question") => {
          const sessionID = getSessionID(event);
          if (!sessionID) return;
          // As in v4, subagent (child) sessions never show quota toasts.
          if (api.data.session.get(sessionID)?.parentID) return;
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
        const onInboxEnqueued = api.data.on("session.inbox.enqueued", (event) =>
          showPostedQuotaReport(api, event),
        );
        disposeEvents = () => {
          onExecutionSucceeded();
          onCompacted();
          onQuestionStarted();
          onQuestionSucceeded();
          onQuestionFailed();
          onInboxEnqueued();
          questionToolCalls.clear();
        };
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarQuotaView context={api} sessionID={props.sessionID} />,
    });
    const disposePrompt = api.ui.slot({
      append: "prompt.footer",
      render: (props) => <QuotaFooter context={api} sessionID={props.sessionID} surface="prompt" />,
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
