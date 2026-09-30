import { beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/tui-v2.tsx";

describe("V2 CLI question-tool accounting boundary", () => {
  const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const session = { get: vi.fn() };
  const toast = vi.fn();
  // With showOnQuestion off, the server answers the question surface with no quota.
  const rpc = { surface: vi.fn() };

  beforeEach(() => {
    handlers.clear();
    session.get.mockReset();
    toast.mockReset();
    rpc.surface.mockReset().mockResolvedValue({ quota: null });
    plugin.setup({
      client: { rpc: () => rpc },
      location: { directory: process.cwd() },
      data: {
        session,
        on: (name: string, handler: (event: { data: Record<string, unknown> }) => void) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
      keymap: { layer: vi.fn() },
      ui: {
        slot: (claim: { append: string; render: () => unknown }) => {
          if (claim.append === "app") claim.render();
          return vi.fn();
        },
        toast: { show: toast },
      },
    } as never);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "OpenCode Quota fork deprecated" }),
    );
    toast.mockClear();
  });

  it("does not treat a successful question-tool execution as a completed model request", async () => {
    handlers.get("session.tool.input.started")?.({ data: { name: "question", id: "call-1" } });
    handlers.get("session.tool.success")?.({ data: { sessionID: "session-1", id: "call-1" } });
    await vi.waitFor(() => expect(rpc.surface).toHaveBeenCalledTimes(1));
    expect(rpc.surface).toHaveBeenCalledWith(
      { surface: "question", sessionID: "session-1" },
      expect.anything(),
    );
    // Only the subagent check reads the session; the server looks up the model.
    expect(session.get).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not use question-tool failure metadata as accounting authority", () => {
    handlers.get("session.tool.input.started")?.({ data: { name: "question", id: "call-2" } });
    handlers.get("session.tool.failed")?.({ data: { sessionID: "session-1", id: "call-2" } });
    expect(rpc.surface).not.toHaveBeenCalled();
    expect(session.get).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
