import { beforeEach, describe, expect, it, vi } from "vitest";

const buildOutput = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: buildOutput,
}));

import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-commands.js";
import plugin from "../src/plugin.js";

type RegisteredTool = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
};
type RegisteredCommand = {
  name: string;
  description?: string;
  execute: (invocation: {
    sessionID: string;
    prompt: { text: string };
    delivery: "steer" | "queue";
  }) => Promise<void>;
};
type HookEvent = {
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
};

function createContext() {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const hooks = new Map<string, (event: HookEvent) => void>();
  const ctx = {
    location: { directory: "/tmp/opencode/quota-plugin-v2" },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      get: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
      synthetic: vi.fn().mockResolvedValue({}),
      hook: vi.fn(async (name: string, callback: (event: HookEvent) => void) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(async (callback) => {
        callback({ add: (tool: RegisteredTool) => tools.push(tool) });
      }),
    },
    command: {
      transform: vi.fn(async (callback) => {
        callback({ add: (command: RegisteredCommand) => commands.push(command) });
      }),
    },
  };
  return { ctx, tools, commands, hooks };
}

function findCommand(commands: RegisteredCommand[], name: string): RegisteredCommand {
  const found = commands.find((item) => item.name === name);
  if (!found) throw new Error(`Command not registered: ${name}`);
  return found;
}

function runCommand(commands: RegisteredCommand[], name: string, text = "") {
  return findCommand(commands, name).execute({
    sessionID: "session-web",
    prompt: { text },
    delivery: "steer",
  });
}

describe("V2 server plugin", () => {
  beforeEach(() => {
    buildOutput.mockReset();
  });

  it("registers a structured quota diagnostics tool without a server toast dependency", async () => {
    const { ctx, tools } = createContext();
    buildOutput.mockResolvedValue({ state: "output", output: "Quota ready" });

    await plugin.setup(ctx as never);
    expect(tools.map((tool) => tool.name)).toEqual(["quota_status"]);
    const output = await tools[0].execute({}, { sessionID: "session-test" });
    expect(output).toEqual({ content: "Quota ready" });
    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        sessionID: "session-test",
      }),
    );
    expect(ctx.provider.list).toHaveBeenCalledTimes(0);
  });

  it("registers the same slash commands as the TUI", async () => {
    const { ctx, commands } = createContext();

    await plugin.setup(ctx as never);
    expect(commands.map((item) => ({ name: item.name, description: item.description }))).toEqual(
      QUOTA_DIALOG_COMMANDS.map((spec) => ({
        name: spec.slashName,
        description: spec.description,
      })),
    );
  });

  it("shows command output as a display-only synthetic message without a model turn", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({ state: "output", output: "# Quota\nopenai 42%\u001b[31m" });

    await plugin.setup(ctx as never);
    await runCommand(commands, "quota");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "quota", sessionID: "session-web", arguments: undefined }),
    );
    expect(ctx.session.synthetic).toHaveBeenCalledTimes(1);
    const input = ctx.session.synthetic.mock.calls[0][0];
    expect(input).toEqual({
      sessionID: "session-web",
      text: expect.any(String),
      description: "# Quota\nopenai 42%",
      resume: false,
    });
    expect(input.text).not.toContain("openai");
  });

  it("passes typed arguments to the output builder", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({ state: "output", output: "report" });

    await plugin.setup(ctx as never);
    await runCommand(commands, "tokens_between", " 2026-09-01 2026-09-25 ");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tokens_between", arguments: "2026-09-01 2026-09-25" }),
    );
  });

  it("shows the builder's usage text when /tokens_between has no arguments", async () => {
    const { ctx, commands } = createContext();
    const usage = "Invalid arguments for /tokens_between\n\nExpected: /tokens_between YYYY-MM-DD";
    buildOutput.mockResolvedValue({ state: "output", output: usage });

    await plugin.setup(ctx as never);
    await runCommand(commands, "tokens_between", "   ");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tokens_between", arguments: undefined }),
    );
    expect(ctx.session.synthetic.mock.calls[0][0].description).toBe(usage);
  });

  it("shows nothing when the plugin is disabled", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({ state: "noop", command: "quota", reason: "disabled" });

    await plugin.setup(ctx as never);
    await runCommand(commands, "quota");

    expect(ctx.session.synthetic).not.toHaveBeenCalled();
  });

  it("removes quota command messages from model requests and keeps everything else", async () => {
    const { ctx, commands, hooks } = createContext();
    buildOutput.mockResolvedValue({ state: "output", output: "report" });

    await plugin.setup(ctx as never);
    await runCommand(commands, "quota");
    const marker = ctx.session.synthetic.mock.calls[0][0].text as string;

    expect([...hooks.keys()]).toEqual(["context", "compaction", "generate"]);
    for (const hook of hooks.values()) {
      const user = { role: "user", content: [{ type: "text", text: "What is my quota?" }] };
      const assistant = { role: "assistant", content: [{ type: "text", text: marker }] };
      const quoted = {
        role: "user",
        content: [
          { type: "text", text: marker },
          { type: "text", text: "Please explain the line above." },
        ],
      };
      const event: HookEvent = {
        messages: [
          { role: "user", content: [{ type: "text", text: marker }] },
          user,
          assistant,
          quoted,
          { role: "user", content: [{ type: "text", text: marker }] },
        ],
      };

      hook(event);

      expect(event.messages).toEqual([user, assistant, quoted]);
    }
  });
});
