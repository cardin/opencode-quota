import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { formatQuotaReportMessage } from "../src/lib/quota-report-message.js";
import plugin from "../src/tui-v2.tsx";

// The server plugin's quota RPC runs palette commands; the TUI shows their output.
const rpc = vi.hoisted(() => ({ command: vi.fn() }));

type Node = { type: string; props: Record<string, any> };

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

function startTui(
  location?: { directory: string },
  route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
) {
  let layer: { commands: RegisteredCommand[] } | undefined;
  const listeners = new Map<string, Listener>();
  const context = {
    location,
    client: {
      rpc: vi.fn(() => rpc),
      session: { inbox: { cancel: vi.fn().mockResolvedValue(undefined) } },
    },
    theme: {
      surface: vi.fn(() => ({
        text: { base: "base", muted: "muted", action: { primary: { focused: "action" } } },
        background: { action: { primary: { focused: "action-bg" } } },
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
        if (claim.append === "app") claim.render();
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      router: { current: vi.fn(() => route) },
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
  return { context, commands, command, emit };
}

describe("V2 quota TUI commands", () => {
  beforeEach(() => {
    rpc.command.mockReset().mockResolvedValue({
      state: "output",
      command: "tokens_today",
      title: "Tokens",
      output: "ok",
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
    const metadata = { opencodeQuota: { command: "quota", title: "OpenCode Quota", at: 1 } };
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
      await settle();

      expect(loadConfig).not.toHaveBeenCalled();
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
      expect(render().props).toMatchObject({ title: "OpenCode Quota", message: "openai 42%" });
      expect(rpc.command).not.toHaveBeenCalled();
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

      expect(loadConfig).toHaveBeenCalledOnce();
      await expect(loadConfig.mock.results[0].value).resolves.toMatchObject({
        tuiCommandDisplay: "inline",
      });
      expect(context.ui.dialog.show).not.toHaveBeenCalled();
      expect(context.client.session.inbox.cancel).not.toHaveBeenCalled();
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
            metadata: { opencodeQuota: { command: "quota", title: "OpenCode Quota", at: 1 } },
          },
        },
      });
      await vi.waitFor(() => expect(loadConfig).toHaveBeenCalledOnce());

      expect(loadConfig.mock.calls[0][2]).toEqual({ configRootDir: repo });
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
    const output = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    rpc.command.mockResolvedValue({
      state: "output",
      command: "quota_status",
      title: "Quota Status",
      output,
      dialogSize: "xlarge",
    });
    const { context, command } = startTui();

    await command("quota_status").run();

    expect(context.ui.dialog.show).toHaveBeenCalledOnce();
    expect(context.ui.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    const render = context.ui.dialog.show.mock.calls[0][0] as () => unknown;
    const tree = render();
    const scrollbox = findNode(tree, "scrollbox");
    // 40 terminal rows: three quarters is 30, minus 8 rows of dialog chrome.
    expect(scrollbox?.props.maxHeight).toBe(22);
    expect(findNode(scrollbox?.props.children, "text")?.props.children).toBe(output);

    const dialogLayer = context.keymap.layer.mock.calls[1][0]() as {
      mode: string;
      commands: Array<{ bind: string; run: () => void }>;
    };
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
