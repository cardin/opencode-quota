/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  formatDisplayedPercentLabel,
  formatQuotaModeHeading,
  formatResetCountdown,
  isResetTimeDecimals,
  resolveDisplayedPercent,
} from "./lib/format-utils.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
  type QuotaDialogCommandSpec,
} from "./lib/quota-dialog-commands.js";
import { extractSingleWindowWindowLabel } from "./lib/quota-entry-display.js";
import { formatQuotaRunway } from "./lib/quota-exhaustion-projection.js";
import type { SessionTokenError } from "./lib/quota-status.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import type { TuiHost } from "./lib/tui-host.js";
import { createTuiHost } from "./lib/tui-host.js";
import { getSidebarBodyLineColor } from "./lib/tui-line-style.js";
import type {
  CompactStatusState,
  HomeBottomState,
  PromptBarState,
  SidebarPanelState,
} from "./lib/tui-panel-state.js";
import {
  getCompactStatusText,
  getHomeBottomAnnouncementText,
  getSidebarPanelLines,
  getSidebarPanelLinesExpanded,
  shouldRenderCompactStatus,
  shouldRenderHomeBottom,
  shouldRenderSidebarPanel,
} from "./lib/tui-panel-state.js";
import { createTuiRefreshLifecycle } from "./lib/tui-refresh-lifecycle.js";
import {
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  type TuiInitialRuntimeSeed,
  type TuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} from "./lib/tui-runtime.js";
import { startTuiToastRuntime } from "./lib/tui-toast-bridge.js";
import type { TuiCommandDisplay } from "./lib/types.js";

type Context = Plugin.Context;

const id = "@cardin/opencode-quota";
const REFRESH_INTERVAL_MS = 60_000;
const EVENT_REFRESH_DELAYS_MS = [150, 600] as const;
const MOUNT_RECOVERY_DELAYS_MS = [500, 1_500, 4_000] as const;

type DialogSize = "medium" | "large" | "xlarge";

type QuotaDialogCommandState = {
  lastSessionTokenError?: SessionTokenError;
};
type SessionQuotaResource = {
  sessionID: string;
  sidebar: () => SidebarPanelState;
  compact: () => CompactStatusState;
  promptBar: () => PromptBarState;
  retain: () => SessionQuotaResource;
  release: () => void;
};

type HomeBottomResource = {
  bottom: () => HomeBottomState;
  retain: () => HomeBottomResource;
  release: () => void;
};

type TuiInitialLoadCoordinator = {
  takeInitialSession: () => TuiInitialRuntimeSeed | undefined;
  takeInitialHome: () => TuiInitialRuntimeSeed | undefined;
};

type TuiRegistrationState =
  | { status: "pending" }
  | {
      status: "active";
      registration: TuiSurfaceRegistration;
      initialLoads?: TuiInitialLoadCoordinator;
    }
  | { status: "disposed" };

type TuiRegistrationGate = {
  current: () => TuiRegistrationState;
  activate: (
    registration: TuiSurfaceRegistration,
    initialLoads?: TuiInitialLoadCoordinator,
  ) => void;
  dispose: () => void;
};

type CommandTheme = {
  text: RGBA;
  textMuted: RGBA;
};

const FALLBACK_SURFACE_REGISTRATION: TuiSurfaceRegistration = {
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
};

function createTuiInitialLoadCoordinator(seed: TuiInitialRuntimeSeed): TuiInitialLoadCoordinator {
  let sessionAvailable = true;
  let homeAvailable = true;

  return {
    takeInitialSession() {
      if (!sessionAvailable) return undefined;
      sessionAvailable = false;
      return seed;
    },
    takeInitialHome() {
      if (!homeAvailable) return undefined;
      homeAvailable = false;
      return seed;
    },
  };
}

function createTuiRegistrationGate(): TuiRegistrationGate {
  const [current, setCurrent] = createSignal<TuiRegistrationState>({ status: "pending" });

  return {
    current,
    activate(registration, initialLoads) {
      if (current().status !== "pending") return;
      setCurrent({ status: "active", registration, initialLoads });
    },
    dispose() {
      if (current().status === "disposed") return;
      setCurrent({ status: "disposed" });
    },
  };
}

const sessionResources = new WeakMap<TuiHost, Map<string, SessionQuotaResource>>();
const homeResources = new WeakMap<TuiHost, HomeBottomResource>();

function getSessionResourceMap(host: TuiHost): Map<string, SessionQuotaResource> {
  const existing = sessionResources.get(host);
  if (existing) return existing;

  const next = new Map<string, SessionQuotaResource>();
  sessionResources.set(host, next);
  return next;
}

function createSessionQuotaResource(
  host: TuiHost,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const [sidebar, setSidebar] = createSignal<SidebarPanelState>({
    status: "loading",
    lines: [],
  });
  const [compact, setCompact] = createSignal<CompactStatusState>({ status: "loading" });
  const [promptBar, setPromptBar] = createSignal<PromptBarState>({ status: "loading" });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialSession() : undefined;
      loadOrdinal += 1;
      return loadTuiSessionQuotaSurfaces({
        api: host,
        sessionID,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: (next) => {
      setSidebar(next.sidebar);
      setCompact(next.compact);
      setPromptBar(next.promptBar ?? { status: "loading" });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    // Host/session state can hydrate asynchronously after mount or session
    // switch, so retry a few times to recover from empty first-load reads.
    recoveryDelaysMs: MOUNT_RECOVERY_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      host.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === sessionID) {
          scheduleRefresh();
        }
      }),
      host.event.on("message.updated", (event) => {
        if (event.properties?.info?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      host.event.on("message.removed", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      host.event.on("tui.session.select", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
    ],
    onDispose: () => {
      getSessionResourceMap(host).delete(sessionID);
    },
  });

  const resource: SessionQuotaResource = {
    sessionID,
    sidebar,
    compact,
    promptBar,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireSessionQuotaResource(
  host: TuiHost,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const resources = getSessionResourceMap(host);
  const existing = resources.get(sessionID);
  if (existing) return existing.retain();

  const next = createSessionQuotaResource(host, sessionID, initialLoads).retain();
  resources.set(sessionID, next);
  return next;
}

function createHomeBottomResource(
  host: TuiHost,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const [bottom, setBottom] = createSignal<HomeBottomState>({
    status: "loading",
    compact: compactHomeBottomEnabled ? { status: "loading" } : { status: "disabled" },
  });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialHome() : undefined;
      loadOrdinal += 1;
      return loadTuiHomeBottomStatus({
        api: host,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: setBottom,
    afterApply: () => {
      // Fire-and-forget: write export file if enabled. A failed write must
      // never affect TUI rendering, so log a warning and continue.
      void writeTuiQuotaExportIfEnabled({ api: host }).catch((err) => {
        console.warn(`[opencode-quota] quota export write failed: ${String(err)}`);
      });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      host.event.on("session.updated", scheduleRefresh),
      host.event.on("message.updated", scheduleRefresh),
      host.event.on("message.removed", scheduleRefresh),
      host.event.on("tui.session.select", scheduleRefresh),
    ],
    onDispose: () => {
      homeResources.delete(host);
    },
  });

  const resource: HomeBottomResource = {
    bottom,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireHomeBottomResource(
  host: TuiHost,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const existing = homeResources.get(host);
  if (existing) return existing.retain();

  const next = createHomeBottomResource(host, compactHomeBottomEnabled, initialLoads).retain();
  homeResources.set(host, next);
  return next;
}

function useSessionQuotaResource(
  host: TuiHost,
  sessionID: () => string,
  initialLoads?: TuiInitialLoadCoordinator,
): () => SessionQuotaResource {
  let current = acquireSessionQuotaResource(host, sessionID(), initialLoads);
  const [resource, setResource] = createSignal(current);

  createEffect(() => {
    const nextSessionID = sessionID();
    if (current.sessionID === nextSessionID) return;

    const previous = current;
    current = acquireSessionQuotaResource(host, nextSessionID, initialLoads);
    setResource(current);
    previous.release();
  });

  onCleanup(() => {
    current.release();
  });

  return resource;
}

function SidebarContentView(props: {
  host: TuiHost;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = useSessionQuotaResource(props.host, () => props.sessionID, props.initialLoads);
  const panel = () => resource().sidebar();

  const lines = () => getSidebarPanelLines(panel());
  const hasDetailLines = () => Boolean(panel().linesExpanded?.length);

  const [collapsed, setCollapsed] = createSignal(
    props.host.kv.get("quota-sidebar-collapsed", true) ?? true,
  );

  const toggleCollapsed = () => {
    if (!hasDetailLines()) return;

    const next = !collapsed();
    setCollapsed(next);
    props.host.kv.set("quota-sidebar-collapsed", next);
  };

  const displayLines = () => {
    if (!hasDetailLines()) return lines();
    return collapsed() ? lines() : getSidebarPanelLinesExpanded(panel());
  };

  const toggleIcon = () => (collapsed() ? "▶" : "▼");
  const providerCount = () => panel().providerCount ?? 0;
  const headerText = () => {
    const heading = panel().headerPercentMode
      ? formatQuotaModeHeading(panel().headerPercentMode)
      : "Quota";
    return hasDetailLines() ? `${toggleIcon()} ${heading}` : heading;
  };

  return (
    <Show when={shouldRenderSidebarPanel(panel())}>
      <box gap={0}>
        <box flexDirection="row">
          <text fg={props.host.theme.current.text} onMouseDown={toggleCollapsed}>
            <b>{headerText()}</b>
          </text>
          <Show when={collapsed() && providerCount() > 0}>
            <text fg={props.host.theme.current.textMuted}> ({providerCount()} providers)</text>
          </Show>
        </box>
        <box gap={0}>
          {displayLines().map((line) => (
            <text fg={getSidebarBodyLineColor(line, props.host.theme.current)} wrapMode="none">
              {line || " "}
            </text>
          ))}
        </box>
      </box>
    </Show>
  );
}

function CompactStatusLine(props: {
  host: TuiHost;
  panel: () => CompactStatusState;
  justifyContent: "flex-start" | "center" | "flex-end";
  blankLineBefore?: boolean;
}) {
  const text = () => {
    const panel = props.panel();
    if (!shouldRenderCompactStatus(panel)) return "";
    return getCompactStatusText(panel);
  };

  const line = () => (
    <box flexDirection="row" justifyContent={props.justifyContent}>
      <text fg={props.host.theme.current.textMuted} wrapMode="none">
        {text()}
      </text>
    </box>
  );

  return (
    <Show when={text()}>
      <Show when={props.blankLineBefore} fallback={line()}>
        <box gap={0}>
          <text> </text>
          {line()}
        </box>
      </Show>
    </Show>
  );
}

function SessionCompactStatus(props: {
  host: TuiHost;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = useSessionQuotaResource(props.host, () => props.sessionID, props.initialLoads);
  const panel = () => resource().compact();

  return <CompactStatusLine host={props.host} panel={panel} justifyContent="flex-end" />;
}

const PROMPT_BAR_WIDTH = 12;

function shouldRenderPromptBar(
  bar: PromptBarState,
): bar is Extract<PromptBarState, { status: "ready" }> {
  return bar.status === "ready" && Boolean(bar.entry);
}

function useSessionRunning(host: TuiHost, sessionID: () => string): () => boolean {
  const [running, setRunning] = createSignal(false);
  createEffect(() => {
    const target = sessionID();
    if (!target) {
      setRunning(false);
      return;
    }
    const update = () => {
      try {
        const status = host.state.session.status?.(target);
        setRunning(status?.type === "busy" || status?.type === "retry");
      } catch {
        setRunning(false);
      }
    };
    update();
    const disposers = [
      host.event.on("session.status", (event) => {
        if (event.properties?.sessionID === target) {
          update();
        }
      }),
      host.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === target) {
          update();
        }
      }),
    ];
    onCleanup(() => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") {
          dispose();
        }
      }
    });
  });
  return running;
}

function buildPromptBarParts(params: {
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}): { label: string; barText: string; meta: string } | undefined {
  const bar = params.bar();
  if (!shouldRenderPromptBar(bar)) return undefined;
  const entry = bar.entry;
  if (!entry) return undefined;
  const reset = entry.resetTimeIso
    ? formatResetCountdown(
        entry.resetTimeIso,
        isResetTimeDecimals(bar.resetTimeDecimals)
          ? { compactRounded: true, decimals: bar.resetTimeDecimals }
          : { spaced: bar.resetTimeSpaced },
      )
    : "";
  const runway = formatQuotaRunway(entry.runway);

  const hasPercent = Number.isFinite(entry.percentRemaining);
  if (entry.semanticSegment && !hasPercent) {
    return { label: entry.semanticSegment, barText: "", meta: reset };
  }

  const windowLabel =
    entry.semanticSegment ??
    extractSingleWindowWindowLabel(entry.label ?? "") ??
    extractSingleWindowWindowLabel(entry.name ?? "") ??
    "Quota";
  const percent = formatDisplayedPercentLabel(
    entry.percentRemaining ?? 0,
    bar.percentDisplayMode ?? "remaining",
    "bare",
  );
  const p = Math.min(
    100,
    resolveDisplayedPercent(entry.percentRemaining ?? 0, bar.percentDisplayMode ?? "remaining"),
  );
  const filled = Math.round((p / 100) * PROMPT_BAR_WIDTH);
  const empty = PROMPT_BAR_WIDTH - filled;
  let barText = "█".repeat(filled) + "░".repeat(empty);
  if (params.running() && filled > 0) {
    const cells = Array(filled).fill("▓");
    const center = params.phase() % filled;
    const gradient = ["▒", "▓", "█", "▓", "▒"];
    for (let offset = -2; offset <= 2; offset++) {
      const position = (center + offset + filled) % filled;
      cells[position] = gradient[offset + 2];
    }
    barText = cells.join("") + "░".repeat(empty);
  }
  return {
    label: windowLabel,
    barText,
    meta: entry.semanticSegment
      ? [reset, runway ? `r/o ${runway}` : ""].filter(Boolean).join(" | ")
      : [percent, reset, runway ? `r/o ${runway}` : ""].filter(Boolean).join(" | "),
  };
}

function PromptQuotaHint(props: {
  host: TuiHost;
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}) {
  const parts = () => buildPromptBarParts(props);
  const barColor = () => props.host.theme.current.textMuted;
  const label = () => parts()?.label ?? "";
  const bar = () => parts()?.barText ?? "";
  const meta = () => parts()?.meta ?? "";

  return (
    <Show when={parts()}>
      <box flexDirection="row" justifyContent="flex-end" gap={1}>
        <text fg={props.host.theme.current.textMuted} wrapMode="none">
          {label()}
        </text>
        <text fg={barColor()} wrapMode="none">
          {bar()}
        </text>
        <text fg={props.host.theme.current.textMuted} wrapMode="none">
          {meta()}
        </text>
      </box>
    </Show>
  );
}

function SessionQuotaPromptBar(props: {
  host: TuiHost;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = useSessionQuotaResource(props.host, () => props.sessionID, props.initialLoads);
  const promptBar = () => resource().promptBar();
  const running = useSessionRunning(props.host, () => props.sessionID);
  const [phase, setPhase] = createSignal(0);
  createEffect(() => {
    if (!running() || !shouldRenderPromptBar(promptBar())) {
      setPhase(0);
      return;
    }
    const interval = setInterval(() => setPhase((p) => p + 1), 160);
    onCleanup(() => clearInterval(interval));
  });

  return <PromptQuotaHint host={props.host} bar={promptBar} running={running} phase={phase} />;
}

function HomeBottomView(props: {
  host: TuiHost;
  compactHomeBottomEnabled: boolean;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = acquireHomeBottomResource(
    props.host,
    props.compactHomeBottomEnabled,
    props.initialLoads,
  );
  onCleanup(() => resource.release());

  const announcement = () => getHomeBottomAnnouncementText(resource.bottom());
  const compact = () => resource.bottom().compact;
  const visible = () => shouldRenderHomeBottom(resource.bottom());

  return (
    <box gap={0}>
      <Show when={visible()}>
        <text> </text>
      </Show>
      <Show when={visible() && announcement()}>
        <box flexDirection="row" justifyContent="center">
          <text fg={props.host.theme.current.textMuted} wrapMode="none">
            {announcement()}
          </text>
        </box>
      </Show>
      <Show when={visible()}>
        <CompactStatusLine host={props.host} panel={compact} justifyContent="center" />
      </Show>
    </box>
  );
}

function getActiveTuiSessionID(context: Context): string | undefined {
  const route = context.ui.router.current();
  if (route.type !== "session") return undefined;
  return normalizeTuiSessionID(route.sessionID);
}

function getTuiCommandArguments(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["arguments", "args", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function CommandLoadingDialog(props: { theme: CommandTheme; title: string }) {
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.theme.textMuted}>Loading deterministic local output…</text>
    </box>
  );
}

function CommandOutputDialog(props: { theme: CommandTheme; title: string; output: string }) {
  const lines = () => props.output.split("\n");
  const bodyHeight = () => Math.min(28, Math.max(6, lines().length));
  return (
    <box gap={1} width="100%" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
      <scrollbox width="100%" flexGrow={1} minHeight={bodyHeight()} maxHeight={28}>
        <box gap={0} width="100%" minWidth={0}>
          {lines().map((line) => (
            <text fg={props.theme.text} wrapMode="word" width="100%">
              {line || " "}
            </text>
          ))}
        </box>
      </scrollbox>
      <text fg={props.theme.textMuted}>esc closes</text>
    </box>
  );
}

function CommandErrorDialog(props: { theme: CommandTheme; title: string; error: unknown }) {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.theme.text}>OpenCode Quota command failed.</text>
      <text fg={props.theme.textMuted} wrapMode="none">
        {message || "Unknown error"}
      </text>
      <text fg={props.theme.textMuted}>esc closes</text>
    </box>
  );
}

function getCommandPromptCopy(spec: QuotaDialogCommandSpec): {
  title: string;
  placeholder: string;
  description: string;
} {
  switch (spec.id) {
    case "tokens_between":
      return {
        title: "OpenCode Quota Token Range",
        placeholder: "YYYY-MM-DD YYYY-MM-DD",
        description: "Enter start and end dates, for example: 2026-01-01 2026-01-15",
      };
    case "quota_status":
      return {
        title: "OpenCode Quota Status Options",
        placeholder: 'Optional JSON, e.g. {"refreshGoogleTokens":true}',
        description: "Leave blank for normal diagnostics, or enter one JSON options object.",
      };
    default:
      return {
        title: spec.title,
        placeholder: "Optional arguments",
        description: "Leave blank to run with no arguments.",
      };
  }
}

function showDialog(context: Context, size: DialogSize, render: () => JSX.Element): void {
  context.ui.dialog.show(render);
  context.ui.dialog.set({ size });
}

async function runQuotaDialogCommandAsync(
  context: Context,
  host: TuiHost,
  command: QuotaDialogCommandId,
  commandDisplay: TuiCommandDisplay,
  rawInput?: unknown,
  state?: QuotaDialogCommandState,
  // Tracks whether the optional-argument prompt already ran. A blank submit is
  // a valid "no arguments" answer and must not re-open the prompt, matching the
  // V1 behavior.
  promptResolved = false,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  const argumentsText = getTuiCommandArguments(rawInput);
  const sessionID = getActiveTuiSessionID(context);
  const theme: CommandTheme = {
    text: host.theme.current.text,
    textMuted: host.theme.current.textMuted,
  };

  if (spec.acceptsArguments && argumentsText === undefined && !promptResolved) {
    const prompt = getCommandPromptCopy(spec);
    const value = await context.ui.dialog.prompt({
      title: prompt.title,
      placeholder: prompt.placeholder,
      description: prompt.description,
    });
    if (value === undefined) return;
    await runQuotaDialogCommandAsync(
      context,
      host,
      command,
      commandDisplay,
      value.trim(),
      state,
      true,
    );
    return;
  }

  const destination =
    commandDisplay === "inline" && sessionID
      ? { type: "inline" as const, sessionID }
      : { type: "dialog" as const };
  if (destination.type === "dialog") {
    showDialog(context, spec.dialogSize, () => (
      <CommandLoadingDialog theme={theme} title={spec.title} />
    ));
  }

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: argumentsText,
      client: createTuiQuotaClient(host),
      roots: getTuiRuntimeRootHints(host),
      sessionID,
      resolveSessionMeta: (targetID) => getTuiSessionModelMeta(host, targetID),
      lastSessionTokenError: state?.lastSessionTokenError,
      setLastSessionTokenError: state
        ? (error) => {
            state.lastSessionTokenError = error;
          }
        : undefined,
      log: (message, extra) => host.log(message, extra),
    });

    if (result.state === "noop") {
      if (destination.type === "dialog") context.ui.dialog.clear();
      return;
    }

    if (destination.type === "inline") {
      await context.client.session.synthetic({
        sessionID: destination.sessionID,
        text: result.output,
        description: result.title,
      });
      return;
    }

    showDialog(context, result.dialogSize, () => (
      <CommandOutputDialog theme={theme} title={result.title} output={result.output} />
    ));
  } catch (error) {
    showDialog(context, "large", () => (
      <CommandErrorDialog theme={theme} title={spec.title} error={error} />
    ));
    context.ui.toast.show({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
  }
}

function registerQuotaDialogCommands(
  context: Context,
  host: TuiHost,
  gate: TuiRegistrationGate,
): void {
  const commandState: QuotaDialogCommandState = {};
  context.keymap.layer(() => ({
    mode: "global",
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      id: `opencode-quota.${spec.id}`,
      title: spec.title,
      description: spec.description,
      group: "OpenCode Quota",
      palette: true as const,
      slash: spec.acceptsArguments
        ? { name: spec.slashName, arguments: true as const }
        : { name: spec.slashName },
      enabled: () => gate.current().status === "active",
      run: (input?: string) => {
        const state = gate.current();
        if (state.status !== "active") return;
        void runQuotaDialogCommandAsync(
          context,
          host,
          spec.id,
          state.registration.commandDisplay,
          input,
          commandState,
        );
      },
    })),
  }));
}

function registerStableTuiSlots(
  context: Context,
  host: TuiHost,
  current: () => TuiRegistrationState,
): void {
  context.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      const state = current();
      if (state.status !== "active" || !state.registration.sidebar.enabled) return null;
      return (
        <SidebarContentView
          host={host}
          sessionID={input.sessionID}
          initialLoads={state.initialLoads}
        />
      );
    },
  });

  context.ui.slot({
    append: "session.composer.top",
    render: (input) => {
      const state = current();
      if (state.status !== "active") return null;
      if (!state.registration.promptBar.enabled) return null;
      return (
        <SessionQuotaPromptBar
          host={host}
          sessionID={input.sessionID}
          initialLoads={state.initialLoads}
        />
      );
    },
  });

  context.ui.slot({
    append: "prompt.footer",
    render: (input) => {
      const state = current();
      if (state.status !== "active") return null;
      if (!input.sessionID) return null;
      if (state.registration.promptBar.enabled) return null;
      if (!state.registration.compact.sessionPrompt) return null;
      return (
        <SessionCompactStatus
          host={host}
          sessionID={input.sessionID}
          initialLoads={state.initialLoads}
        />
      );
    },
  });

  context.ui.slot({
    append: "home.footer",
    render: () => {
      const state = current();
      if (state.status !== "active" || !state.registration.homeBottom) return null;
      return (
        <HomeBottomView
          host={host}
          compactHomeBottomEnabled={state.registration.compact.homeBottom}
          initialLoads={state.initialLoads}
        />
      );
    },
  });
}

async function initializeTuiRegistration(
  context: Context,
  host: TuiHost,
  gate: TuiRegistrationGate,
): Promise<void> {
  let initialRuntimeSeed: TuiInitialRuntimeSeed | undefined;
  let surfaceRegistration: Promise<{
    registration: TuiSurfaceRegistration;
    initialRuntimeSeed?: TuiInitialRuntimeSeed;
  }>;
  try {
    surfaceRegistration = resolveTuiSurfaceRegistration(host, {
      captureInitialRuntime(seed) {
        initialRuntimeSeed = seed;
      },
    })
      .then((registration) => ({ registration, initialRuntimeSeed }))
      .catch(() => ({ registration: FALLBACK_SURFACE_REGISTRATION }));
  } catch {
    surfaceRegistration = Promise.resolve({ registration: FALLBACK_SURFACE_REGISTRATION });
  }

  registerQuotaDialogCommands(context, host, gate);
  // Activate the gate before installing the optional slots: if one slot
  // registration throws, the command layer and the slots already installed
  // must stay active instead of leaving every surface permanently pending.
  void surfaceRegistration.then(({ registration, initialRuntimeSeed: seed }) =>
    gate.activate(registration, seed ? createTuiInitialLoadCoordinator(seed) : undefined),
  );
  registerStableTuiSlots(context, host, gate.current);
}

export const TuiQuotaPlugin = Plugin.define({
  id,
  async setup(context) {
    const host = createTuiHost(context);
    const registrationGate = createTuiRegistrationGate();
    const stopToastRuntime = startTuiToastRuntime(context, host);

    void initializeTuiRegistration(context, host, registrationGate).catch((error) => {
      void host.log("Failed to initialize TUI registration", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      stopToastRuntime();
      registrationGate.dispose();
      disposeQuotaTelemetryOwner(createTuiQuotaClient(host));
    };
  },
});

export default TuiQuotaPlugin;
