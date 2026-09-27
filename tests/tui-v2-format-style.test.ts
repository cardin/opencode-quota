import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/tui-v2.tsx";

describe("V2 sidebar format style", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The server applies tuiSidebarPanel.formatStyle (tests/lib.quota-surface-data.test.ts).
  it("asks the server for the sidebar surface of its session and formats nothing itself", async () => {
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown>) =>
        typeof type === "function" ? type(props) : { type, props },
    });
    const rpc = {
      surface: vi.fn().mockResolvedValue({
        quota: {
          message: "Copilot 5h\nCopilot Weekly",
          duration: 5000,
          activeProviderCount: 1,
        },
      }),
    };

    let sidebarRender: ((props: { sessionID: string }) => unknown) | undefined;
    plugin.setup({
      client: { rpc: () => rpc },
      location: { directory: "/work/project" },
      data: { on: vi.fn(() => vi.fn()) },
      keymap: { layer: vi.fn() },
      ui: {
        slot: vi.fn((claim) => {
          if (claim.append === "app") claim.render();
          if (claim.append === "sidebar.content") sidebarRender = claim.render;
          return vi.fn();
        }),
        toast: { show: vi.fn() },
        dialog: { show: vi.fn(), clear: vi.fn(), prompt: vi.fn(), set: vi.fn() },
      },
    } as any);

    sidebarRender?.({ sessionID: "session-1" });

    await vi.waitFor(() => expect(rpc.surface).toHaveBeenCalledOnce());
    expect(rpc.surface).toHaveBeenCalledWith(
      { surface: "sidebar", sessionID: "session-1" },
      { location: { directory: "/work/project" }, signal: expect.any(AbortSignal) },
    );
  });
});
