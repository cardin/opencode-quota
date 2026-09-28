import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentui/solid", () => ({
  useTerminalDimensions: () => () => ({ width: 120, height: 40 }),
}));
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/config.js")>();
  loadConfig.mockImplementation(original.loadConfig);
  return { ...original, loadConfig };
});

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { parseQuotaSlashCommand } from "../src/lib/quota-dialog-command-specs.js";
import { formatQuotaReportMessage } from "../src/lib/quota-report-message.js";
import { messageDocument, type ReportDocument } from "../src/lib/report-document.js";
import plugin from "../src/tui-v2.tsx";

// The server plugin's quota RPC runs palette commands; the TUI shows their output.
const rpc = vi.hoisted(() => ({ command: vi.fn() }));

type Node = { type: string; props: Record<string, any> };

function findNodes(node: unknown, type: string): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, type));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  if (element.type === type) return [element];
  return findNodes(element.props?.children, type);
}

function findNode(node: unknown, type: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const element = node as Node;
  if (element.type === type) return element;
  return findNode(element.props?.children, type);
}

type RegisteredCommand = {
  id: string;
  slash?: unknown;
  palette: boolean;
  run: () => Promise<void>;
};
type Listener = (event: { data?: Record<string, unknown> }) => void;
type Layer = {
  mode?: string;
  priority?: number;
  commands: Array<RegisteredCommand & { bind?: string; run: () => unknown }>;
};

function startTui(
  location?: { directory: string },
  route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
) {
  let layer: { commands: RegisteredCommand[] } | undefined;
  let renderApp: (() => unknown) | undefined;
  const listeners = new Map<string, Listener>();
  const editor = { plainText: "", clear: vi.fn() };
  const context = {
    location,
    renderer: { currentFocusedEditor: editor as typeof editor | null },
    client: {
      rpc: vi.fn(() => rpc),
      session: { inbox: { cancel: vi.fn().mockResolvedValue(undefined) } },
    },
    theme: {
      surface: vi.fn(() => ({
        text: { base: "base", muted: "muted", action: { primary: { focused: "action" } } },
        background: { action: { primary: { focused: "action-bg" } } },
        markdown: { heading: "heading" },
      })),
    },
    data: {
      on: vi.fn((name: string, listener: Listener) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
      session: { get: vi.fn() },
      location: { default: vi.fn(() => ({ directory: "/work/default" })) },
    },
    keymap: {
      layer: vi.fn((next) => {
        layer ??= next();
      }),
    },
    ui: {
      slot: vi.fn((claim) => {
        if (claim.append === "app") {
          renderApp = claim.render;
          claim.render();
        }
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      router: { current: vi.fn((): typeof route => route) },
      dialog: {
        show: vi.fn((_render: () => unknown, onClose?: () => void) => onClose?.()),
        clear: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(),
      },
    },
  };
  plugin.setup(context as any);
  const commands = layer!.commands;
  const command = (id: string) => commands.find((item) => item.id === `quota.${id}`)!;
  const emit = (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data });
  const layers = () => context.keymap.layer.mock.calls.map(([build]) => build() as Layer);
  /** OpenCode mounts the "app" slot again, for example after it reconnects to its server. */
  const mountAppAgain = () => renderApp!();
  return { context, editor, commands, command, emit, layers, mountAppAgain };
}

describe("V2 quota TUI commands", () => {
  beforeEach(() => {
    rpc.command.mockReset().mockResolvedValue({
      state: "output",
      command: "tokens_today",
      title: "Tokens",
      output: "ok",
      document: messageDocument("ok"),
      dialogSize: "large",
    });
  });

  it("registers every quota command in the palette and leaves slash commands to the server", () => {
    const { context, commands } = startTui();

    // The RPC client is made per call, never during setup.
    expect(context.client.rpc).not.toHaveBeenCalled();
    expect(commands.map((command) => command.id)).toEqual([
      "quota.quota",
      "quota.quota_status",
      "quota.quota_announcements",
      "quota.pricing_refresh",
      "quota.tokens_today",
      "quota.tokens_daily",
      "quota.tokens_weekly",
      "quota.tokens_monthly",
      "quota.tokens_all",
      "quota.tokens_session",
      "quota.tokens_session_all",
      "quota.tokens_between",
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
    expect(commands.some((command) => "slash" in command)).toBe(false);
    expect(context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));
    expect(context.ui.slot).toHaveBeenCalledWith(
      expect.objectContaining({ append: "sidebar.content" }),
    );
    expect(context.ui.slot).toHaveBeenCalledWith(
      expect.objectContaining({ append: "prompt.footer" }),
    );
    expect(context.ui.slot).toHaveBeenCalledWith(
      expect.objectContaining({ append: "home.footer.status" }),
    );
    expect(context.data.on.mock.calls.map(([event]) => event)).toEqual([
      "session.execution.succeeded",
      "session.compaction.ended",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
      "session.inbox.enqueued",
    ]);
  });

  it("registers its layers and listeners again when OpenCode mounts the app slot again", () => {
    const { context, mountAppAgain } = startTui();
    const firstListeners = context.data.on.mock.results.map((result) => result.value);
    const firstLayers = context.keymap.layer.mock.calls.length;

    mountAppAgain();

    // The previous mount's layers left with it, so both layers are registered again.
    expect(context.keymap.layer).toHaveBeenCalledTimes(firstLayers * 2);
    expect(context.data.on).toHaveBeenCalledTimes(firstListeners.length * 2);
    for (const dispose of firstListeners) expect(dispose).toHaveBeenCalledOnce();
    const secondListeners = context.data.on.mock.results.slice(firstListeners.length);
    for (const { value: dispose } of secondListeners) expect(dispose).not.toHaveBeenCalled();
  });

  it("prompts for /tokens_between dates in the palette and stops when cancelled", async () => {
    const { context, command } = startTui();

    await command("tokens_between").run();
    expect(context.ui.dialog.prompt).toHaveBeenCalledOnce();
    expect(rpc.command).not.toHaveBeenCalled();

    context.ui.dialog.prompt.mockResolvedValue(" 2026-09-01 2026-09-25 ");
    await command("tokens_between").run();
    expect(rpc.command).toHaveBeenCalledWith(
      { command: "tokens_between", arguments: "2026-09-01 2026-09-25", sessionID: undefined },
      expect.anything(),
    );
  });

  it("runs /quota_announcements and /pricing_refresh from the palette without a prompt", async () => {
    const { context, command } = startTui();

    await command("quota_announcements").run();
    await command("pricing_refresh").run();

    expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
    expect(rpc.command.mock.calls.map(([input]) => [input.command, input.arguments])).toEqual([
      ["quota_announcements", undefined],
      ["pricing_refresh", undefined],
    ]);
  });

  describe("quota reports posted by slash commands", () => {
    const document = messageDocument("openai 42%");
    const metadata = {
      opencodeQuota: { command: "quota", title: "OpenCode Quota", at: 1, document },
    };
    const report = formatQuotaReportMessage("openai 42%");
    const item = (text: string, meta?: Record<string, unknown>, type = "user") => ({
      type,
      delivery: "steer",
      payload: { text, ...(meta ? { metadata: meta } : {}) },
    });
    let projectDir: string;

    beforeEach(() => {
      projectDir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-quota-tui-report-")));
      mkdirSync(join(projectDir, "global"));
      mkdirSync(join(projectDir, "opencode-quota"));
      vi.stubEnv("OPENCODE_CONFIG_DIR", join(projectDir, "global"));
      vi.stubGlobal("React", {
        createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props }),
      });
      return () => rmSync(projectDir, { recursive: true, force: true });
    });

    function writeCommandDisplay(value: string) {
      writeFileSync(
        join(projectDir, "opencode-quota", "quota-toast.json"),
        JSON.stringify({ tuiCommandDisplay: value }),
      );
    }

    /** Waits for the listener to read tuiCommandDisplay and act on it. */
    async function settle() {
      await loadConfig.mock.results.at(-1)?.value;
      await new Promise((resolve) => setImmediate(resolve));
    }

    it("ignores untagged items, other item types, and sessions not on screen", async () => {
      const { context, emit } = startTui(
        { directory: projectDir },
        { type: "session", sessionID: "ses_open" },
      );

      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_1",
        item: item("hello"),
      });
      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_2",
        item: item("hello", { displayText: "hello", comments: [] }),
      });
      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_3",
        item: item(report),
      });
      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_4",
        item: item(report, metadata, "synthetic"),
      });
      emit("session.inbox.enqueued", {
        sessionID: "ses_other",
        inboxID: "msg_5",
        item: item(report, metadata),
      });
      // Metadata without a report document, as posted before documents were added.
      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_6",
        item: item(report, { opencodeQuota: { command: "quota", title: "OpenCode Quota", at: 1 } }),
      });
      await settle();

      // Only the read at start, for typed commands.
      expect(loadConfig).toHaveBeenCalledOnce();
      expect(context.ui.dialog.show).not.toHaveBeenCalled();
      expect(context.client.session.inbox.cancel).not.toHaveBeenCalled();
    });

    it("dialog mode (the default) opens the report and removes it from the chat", async () => {
      const { context, emit } = startTui(
        { directory: projectDir },
        { type: "session", sessionID: "ses_open" },
      );

      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_report",
        item: item(report, metadata),
      });
      await settle();

      expect(context.client.session.inbox.cancel).toHaveBeenCalledExactlyOnceWith({
        sessionID: "ses_open",
        inboxID: "msg_report",
      });
      expect(context.ui.dialog.show).toHaveBeenCalledOnce();
      expect(context.ui.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
      const render = context.ui.dialog.show.mock.calls[0][0] as () => {
        props: Record<string, unknown>;
      };
      expect(render().props).toMatchObject({ title: "OpenCode Quota", document });
      expect(rpc.command).not.toHaveBeenCalled();
    });

    it("dialog mode handles the report of a session created from Home", async () => {
      const { context, emit } = startTui({ directory: projectDir }, { type: "home" });
      // OpenCode opens the new session before the server runs the command.
      context.ui.router.current.mockReturnValue({ type: "session", sessionID: "ses_new" });

      emit("session.inbox.enqueued", {
        sessionID: "ses_new",
        inboxID: "msg_report",
        item: item(report, metadata),
      });
      await settle();

      expect(context.client.session.inbox.cancel).toHaveBeenCalledExactlyOnceWith({
        sessionID: "ses_new",
        inboxID: "msg_report",
      });
      expect(context.ui.dialog.show).toHaveBeenCalledOnce();
    });

    it("inline mode leaves the report in the chat and opens no dialog", async () => {
      writeCommandDisplay("inline");
      const { context, emit } = startTui(
        { directory: projectDir },
        { type: "session", sessionID: "ses_open" },
      );

      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_report",
        item: item(report, metadata),
      });
      await settle();

      // The read at start, then the read for the report.
      expect(loadConfig).toHaveBeenCalledTimes(2);
      await expect(loadConfig.mock.results[1].value).resolves.toMatchObject({
        tuiCommandDisplay: "inline",
      });
      expect(context.ui.dialog.show).not.toHaveBeenCalled();
      expect(context.client.session.inbox.cancel).not.toHaveBeenCalled();
    });
  });

  describe("typed quota slash commands", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-quota-tui-typed-")));
      mkdirSync(join(projectDir, "global"));
      mkdirSync(join(projectDir, "opencode-quota"));
      vi.stubEnv("OPENCODE_CONFIG_DIR", join(projectDir, "global"));
      return () => rmSync(projectDir, { recursive: true, force: true });
    });

    /** Starts the TUI and waits for its first read of tuiCommandDisplay. */
    async function startTyped(
      display: "dialog" | "inline",
      route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
    ) {
      writeFileSync(
        join(projectDir, "opencode-quota", "quota-toast.json"),
        JSON.stringify({ tuiCommandDisplay: display }),
      );
      const tui = startTui({ directory: projectDir }, route);
      await loadConfig.mock.results.at(-1)?.value;
      const enter = tui.layers().find((layer) => layer.priority === 1)!;
      return { ...tui, enter: enter.commands[0] };
    }

    it("parses only exact quota command names, with their arguments", () => {
      expect(parseQuotaSlashCommand("/quota")).toEqual({
        command: "quota",
        argumentsText: undefined,
      });
      expect(parseQuotaSlashCommand("  /quota_status \n")).toEqual({
        command: "quota_status",
        argumentsText: undefined,
      });
      expect(parseQuotaSlashCommand("/tokens_between  2026-09-01 2026-09-25 ")).toEqual({
        command: "tokens_between",
        argumentsText: "2026-09-01 2026-09-25",
      });
      expect(parseQuotaSlashCommand("/pricing_refresh\tnow")).toEqual({
        command: "pricing_refresh",
        argumentsText: "now",
      });
      for (const text of ["/quotax", "/quota_statu", "quota", "hello /quota", "/", "", "/Quota"]) {
        expect(parseQuotaSlashCommand(text)).toBeUndefined();
      }
    });

    it("registers one Enter binding above OpenCode's prompt, only in the base mode", async () => {
      const { layers, enter } = await startTyped("dialog");

      const layer = layers().find((item) => item.priority === 1)!;
      expect(layer.mode).toBeUndefined();
      expect(layer.commands).toHaveLength(1);
      expect(enter.bind).toBe("return");
      expect("id" in enter).toBe(false);
      expect("slash" in enter).toBe(false);
    });

    it("dialog mode clears the prompt and runs the command with its arguments, synchronously", async () => {
      const { context, editor, enter } = await startTyped("dialog", {
        type: "session",
        sessionID: "ses_open",
      });
      editor.plainText = "/tokens_between 2026-09-01 2026-09-25";

      const result = enter.run();

      // A returned promise would count as handled, so run must not return one.
      expect(result).toBeUndefined();
      expect(editor.clear).toHaveBeenCalledOnce();
      expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(context.ui.dialog.show).toHaveBeenCalledOnce());
      expect(rpc.command).toHaveBeenCalledExactlyOnceWith(
        { command: "tokens_between", arguments: "2026-09-01 2026-09-25", sessionID: "ses_open" },
        expect.anything(),
      );
    });

    it("dialog mode runs /quota on Home without a session and without a prompt", async () => {
      const { context, editor, enter } = await startTyped("dialog");
      editor.plainText = "/quota ";

      expect(enter.run()).toBeUndefined();

      expect(editor.clear).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(context.ui.dialog.show).toHaveBeenCalledOnce());
      expect(rpc.command).toHaveBeenCalledExactlyOnceWith(
        { command: "quota", arguments: undefined, sessionID: undefined },
        expect.anything(),
      );
    });

    it("leaves other text, inline mode, and a missing editor to OpenCode's submit", async () => {
      const dialog = await startTyped("dialog");
      for (const text of ["hello", "/quotax", "/help", ""]) {
        dialog.editor.plainText = text;
        expect(dialog.enter.run()).toBe(false);
      }
      dialog.context.renderer.currentFocusedEditor = null;
      expect(dialog.enter.run()).toBe(false);
      expect(dialog.editor.clear).not.toHaveBeenCalled();

      const inline = await startTyped("inline");
      inline.editor.plainText = "/quota";
      expect(inline.enter.run()).toBe(false);
      expect(inline.editor.clear).not.toHaveBeenCalled();
      expect(rpc.command).not.toHaveBeenCalled();
    });

    it("opens the dialog, the default, before the first read of tuiCommandDisplay finishes", async () => {
      writeFileSync(
        join(projectDir, "opencode-quota", "quota-toast.json"),
        JSON.stringify({ tuiCommandDisplay: "inline" }),
      );
      const { context, editor, layers } = startTui({ directory: projectDir });
      const enter = layers().find((layer) => layer.priority === 1)!.commands[0];
      editor.plainText = "/quota";

      // Enter right after start: the setting is still unknown.
      expect(enter.run()).toBeUndefined();
      expect(editor.clear).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(context.ui.dialog.show).toHaveBeenCalledOnce());

      // Once read, "inline" goes on to OpenCode's submit.
      await loadConfig.mock.results.at(-1)?.value;
      expect(enter.run()).toBe(false);
      expect(editor.clear).toHaveBeenCalledOnce();
    });

    it("reads tuiCommandDisplay again after each typed command", async () => {
      const { editor, enter } = await startTyped("inline");
      writeFileSync(
        join(projectDir, "opencode-quota", "quota-toast.json"),
        JSON.stringify({ tuiCommandDisplay: "dialog" }),
      );
      editor.plainText = "/quota";

      // The setting read at start still applies; the new one applies to the next command.
      expect(enter.run()).toBe(false);
      await loadConfig.mock.results.at(-1)?.value;
      expect(enter.run()).toBeUndefined();
      expect(editor.clear).toHaveBeenCalledOnce();
    });
  });

  it("reads tuiCommandDisplay from the location's Git worktree root, like the server plugin", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "opencode-quota-tui-roots-")));
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "packages", "app"), { recursive: true });
      const { emit } = startTui(
        { directory: join(repo, "packages", "app") },
        { type: "session", sessionID: "ses_open" },
      );

      emit("session.inbox.enqueued", {
        sessionID: "ses_open",
        inboxID: "msg_report",
        item: {
          type: "user",
          payload: {
            text: formatQuotaReportMessage("openai 42%"),
            metadata: {
              opencodeQuota: {
                command: "quota",
                title: "OpenCode Quota",
                at: 1,
                document: messageDocument("openai 42%"),
              },
            },
          },
        },
      });
      await vi.waitFor(() => expect(loadConfig).toHaveBeenCalledTimes(2));

      expect(loadConfig.mock.calls.map((call) => call[2])).toEqual([
        { configRootDir: repo },
        { configRootDir: repo },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs commands for the session on screen, and without a session elsewhere", async () => {
    await startTui(undefined, { type: "session", sessionID: "ses_open" })
      .command("tokens_session")
      .run();
    await startTui(undefined, { type: "home" }).command("tokens_session").run();

    expect(rpc.command.mock.calls.map(([input]) => input.sessionID)).toEqual([
      "ses_open",
      undefined,
    ]);
  });

  it("runs commands at the TUI location, else the default location, with a timeout", async () => {
    await startTui({ directory: "/work/project" }).command("quota").run();
    const { context, command } = startTui();
    await command("quota_status").run();

    expect(rpc.command.mock.calls.map(([, options]) => options)).toEqual([
      { location: { directory: "/work/project" }, signal: expect.any(AbortSignal) },
      { location: { directory: "/work/default" }, signal: expect.any(AbortSignal) },
    ]);
    // The server looks up the session model; the palette never reads it.
    expect(context.data.session.get).not.toHaveBeenCalled();
  });

  it("shows the message of a failed RPC call in the error toast", async () => {
    rpc.command.mockRejectedValue({ type: "rpc.internal", message: "server \u001b[31mbroke" });
    const { context, command } = startTui();

    await command("quota").run();

    expect(context.ui.toast.show).toHaveBeenCalledExactlyOnceWith({
      variant: "error",
      title: "OpenCode Quota",
      message: "server broke",
    });
    expect(context.ui.dialog.show).not.toHaveBeenCalled();
  });

  it("shows command output in a scrollable dialog that fits the terminal", async () => {
    vi.stubGlobal("React", {
      createElement: (
        type: unknown,
        props: Record<string, unknown> | null,
        ...children: unknown[]
      ) => {
        const all = { ...props, children: children.length > 1 ? children : children[0] };
        return typeof type === "function" ? type(all) : { type, props: all };
      },
    });
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);
    const document: ReportDocument = {
      heading: { title: "Tokens used (Today) (/tokens_today)", generatedAtMs },
      sections: [
        {
          id: "models",
          title: "Top Models",
          blocks: [
            {
              kind: "table",
              headers: ["Model", "Cost"],
              aligns: ["left", "right"],
              rows: [
                ["gpt-5", "$1.23"],
                ["claude-\u001b[31mopus", "$10.00"],
              ],
            },
            { kind: "kv", rows: [{ key: "enabled", value: "true" }] },
          ],
        },
        { id: "empty", blocks: [{ kind: "lines", lines: [] }] },
        { id: "notes", blocks: [{ kind: "lines", lines }] },
      ],
    };
    rpc.command.mockResolvedValue({
      state: "output",
      command: "quota_status",
      title: "Quota Status",
      output: "the chat text",
      document,
      dialogSize: "xlarge",
    });
    const { context, command, layers } = startTui();

    await command("quota_status").run();

    expect(context.ui.dialog.show).toHaveBeenCalledOnce();
    expect(context.ui.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    const render = context.ui.dialog.show.mock.calls[0][0] as () => unknown;
    const tree = render();
    const scrollbox = findNode(tree, "scrollbox");
    // 40 terminal rows: three quarters is 30, minus 8 rows of dialog chrome.
    expect(scrollbox?.props.maxHeight).toBe(22);
    const texts = findNodes(scrollbox?.props.children, "text").map((node) => ({
      children: node.props.children,
      fg: node.props.fg,
      bold: node.props.attributes === TextAttributes.BOLD,
      wrapMode: node.props.wrapMode,
    }));
    expect(texts).toEqual([
      {
        children: `Tokens used (Today) (/tokens_today) ${formatLocalCallTimestamp(generatedAtMs)}`,
        fg: "base",
        bold: true,
        wrapMode: undefined,
      },
      { children: "Top Models", fg: "base", bold: true, wrapMode: undefined },
      { children: "Model          Cost", fg: "heading", bold: true, wrapMode: "none" },
      { children: "gpt-5         $1.23", fg: "base", bold: false, wrapMode: "none" },
      { children: "claude-opus  $10.00", fg: "base", bold: false, wrapMode: "none" },
      { children: "- enabled: true", fg: "base", bold: false, wrapMode: undefined },
      { children: lines.join("\n"), fg: "base", bold: false, wrapMode: undefined },
    ]);
    // One blank row between the heading, the sections, and the blocks of a section; a
    // section title sits directly above its first block.
    const body = scrollbox?.props.children;
    expect(body.props.gap).toBe(1);
    const section = body.props.children[1][0];
    expect(section.props.gap).toBeUndefined();
    expect(section.props.children[1].props.gap).toBe(1);

    const dialogLayer = layers().find((item) => item.mode === "modal")!;
    expect(dialogLayer.mode).toBe("modal");
    expect(dialogLayer.commands.map((item) => item.bind)).toEqual([
      "return",
      "up",
      "down",
      "pageup",
      "pagedown",
      "home",
      "end",
    ]);
    const scroll = { scrollBy: vi.fn(), scrollTo: vi.fn(), scrollHeight: 80 };
    scrollbox?.props.ref(scroll);
    const run = (bind: string) => dialogLayer.commands.find((item) => item.bind === bind)!.run();
    run("pagedown");
    run("up");
    run("end");
    expect(scroll.scrollBy.mock.calls).toEqual([[22], [-1]]);
    expect(scroll.scrollTo).toHaveBeenCalledWith(80);
    run("return");
    expect(context.ui.dialog.clear).toHaveBeenCalledOnce();
  });
});
