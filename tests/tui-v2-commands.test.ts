import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: build,
}));

import plugin from "../src/tui-v2.tsx";

type RegisteredCommand = {
  id: string;
  slash: { name: string; arguments?: true };
  palette: boolean;
  run: (input?: string) => Promise<void>;
};

function startTui(
  location?: { directory: string },
  route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
) {
  let layer: { commands: RegisteredCommand[] } | undefined;
  const context = {
    location,
    data: {
      on: vi.fn(() => vi.fn()),
      session: {
        get: vi.fn((sessionID: string) =>
          sessionID === "ses_known"
            ? { model: { id: "claude-sonnet-4-5", providerID: "anthropic" } }
            : undefined,
        ),
      },
    },
    keymap: {
      layer: vi.fn((next) => {
        layer = next();
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
        alert: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(),
      },
    },
  };
  plugin.setup(context as any);
  const commands = layer!.commands;
  const command = (id: string) => commands.find((item) => item.id === `quota.${id}`)!;
  return { context, commands, command };
}

describe("V2 quota TUI commands", () => {
  beforeEach(() => {
    build.mockReset().mockResolvedValue({
      state: "output",
      title: "Tokens",
      output: "ok",
      dialogSize: "large",
    });
  });

  it("registers every quota command as a local slash command", () => {
    const { context, commands } = startTui();

    expect(commands.map((command) => command.slash.name)).toEqual([
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
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
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
    ]);
  });

  it("asks OpenCode to keep typed slash arguments only for commands that take arguments", () => {
    const { commands } = startTui();

    expect(
      commands.filter((command) => command.slash.arguments).map((command) => command.slash.name),
    ).toEqual(["quota_announcements", "pricing_refresh", "tokens_between"]);
  });

  it("passes the typed /tokens_between string to the command without prompting", async () => {
    const { context, command } = startTui();

    await command("tokens_between").run(" 2026-09-01 2026-09-25 ");

    expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tokens_between", arguments: "2026-09-01 2026-09-25" }),
    );
  });

  it("prompts for /tokens_between arguments only when none were typed", async () => {
    const { context, command } = startTui();

    await command("tokens_between").run("");
    await command("tokens_between").run();

    expect(context.ui.dialog.prompt).toHaveBeenCalledTimes(2);
    expect(build).not.toHaveBeenCalled();
  });

  it("runs /quota_announcements and /pricing_refresh without a prompt and forwards typed arguments", async () => {
    const { context, command } = startTui();

    for (const id of ["quota_announcements", "pricing_refresh"]) {
      await command(id).run("");
      await command(id).run();
      await command(id).run(" extra ");
    }

    expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
    expect(build.mock.calls.map(([params]) => [params.command, params.arguments])).toEqual([
      ["quota_announcements", undefined],
      ["quota_announcements", undefined],
      ["quota_announcements", "extra"],
      ["pricing_refresh", undefined],
      ["pricing_refresh", undefined],
      ["pricing_refresh", "extra"],
    ]);
  });

  it("reads project config from the location's Git worktree root, like the server plugin", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "opencode-quota-tui-roots-")));
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "packages", "app"), { recursive: true });
      const { command } = startTui({ directory: join(repo, "packages", "app") });

      await command("quota").run();

      expect(build.mock.calls[0][0].roots).toEqual({
        workspaceRoot: repo,
        configRoot: repo,
        fallbackDirectory: join(repo, "packages", "app"),
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs commands for the session on screen, and without a session elsewhere", async () => {
    await startTui(undefined, { type: "session", sessionID: "ses_open" })
      .command("tokens_session")
      .run();
    await startTui(undefined, { type: "home" }).command("tokens_session").run();

    expect(build.mock.calls.map(([params]) => params.sessionID)).toEqual(["ses_open", undefined]);
  });

  it("reads the session model from the OpenCode 2 session store", async () => {
    const { context, command } = startTui();

    await command("quota_status").run();
    const { resolveSessionMeta } = build.mock.calls[0][0];

    await expect(resolveSessionMeta("ses_known")).resolves.toEqual({
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
    });
    await expect(resolveSessionMeta("ses_unknown")).resolves.toEqual({});
    expect(context.data.session.get).toHaveBeenCalledWith("ses_known");
  });
});
