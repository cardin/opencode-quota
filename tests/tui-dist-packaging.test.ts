import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", () => ({
  Show: (props: { children?: unknown }) => props.children,
  createEffect: vi.fn(),
  createSignal: <T>(value: T) => [() => value, vi.fn()],
  onCleanup: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  createComponent: (component: (props: unknown) => unknown, props: unknown) => component(props),
  createElement: vi.fn(),
  createTextNode: vi.fn(),
  effect: vi.fn(),
  insert: vi.fn(),
  insertNode: vi.fn(),
  memo: (fn: () => unknown) => fn,
  setProp: vi.fn(),
}));

async function exists(url: URL): Promise<boolean> {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

const packagedTui = await import("../dist/tui.js");

describe("tui dist packaging", () => {
  it("ships the precompiled TUI entry and removes stale jsx artifacts", async () => {
    const distTui = new URL("../dist/tui.js", import.meta.url);
    const distJsx = new URL("../dist/tui.jsx", import.meta.url);
    const distJsxMap = new URL("../dist/tui.jsx.map", import.meta.url);

    expect(await exists(distTui)).toBe(true);
    expect(await exists(distJsx)).toBe(false);
    expect(await exists(distJsxMap)).toBe(false);

    const source = await readFile(distTui, "utf8");
    expect(source).toContain("createComponent");
    // OpenCode 2 CLI plugins register through the V2 slot paths.
    expect(source).toContain("sidebar.content");
    expect(source).toContain("session.composer.top");
    expect(source).toContain("prompt.footer");
    expect(source).toContain("home.footer");
    expect(source).toContain('from "@opencode/plugin/tui"');
    expect(source).toContain("loadTuiSessionQuotaSurfaces");
    expect(source).toContain("resolveTuiSurfaceRegistration");
    expect(source).toContain("TuiQuotaPlugin");
    expect(source).toContain("QuotaDialogCommandLayer");
    expect(source).toContain("CommandOutputDialog");
    expect(source).toContain("buildQuotaDialogCommandOutput");
    expect(source).toContain("keymap.layer");
    expect(source).not.toContain("jsx-dev-runtime");
  });

  it("can load the packaged TUI module", () => {
    expect(packagedTui.default).toMatchObject({
      id: "@cardinal4/opencode-quota",
    });
    // V2 plugins are `{ id, setup }` definitions rather than V1 `{ tui }` modules.
    expect(typeof packagedTui.default.setup).toBe("function");
  });
});
