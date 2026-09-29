import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// Seeds the views' Solid signals in creation order, so one render shows loaded quota.
const seeds = vi.hoisted(() => [] as unknown[]);
vi.mock("solid-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("solid-js")>();
  return {
    ...actual,
    createSignal: ((value?: unknown) =>
      actual.createSignal(seeds.length ? seeds.shift() : value)) as typeof actual.createSignal,
  };
});

import plugin from "../src/tui-v2.tsx";

type Node = { type: string; props: Record<string, any> };

function findNodes(node: unknown, type: string): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, type));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  if (element.type === type) return [element];
  return findNodes(element.props?.children, type);
}

/** A text node's words, with bold (<b>) children marked. */
function describeText(node: Node): { text: string; fg: string; bold: boolean } {
  const children = [node.props.children].flat(Number.POSITIVE_INFINITY);
  return {
    text: children
      .map((child) => (typeof child === "string" ? child : (child?.props?.children ?? "")))
      .join(""),
    fg: node.props.fg,
    bold: children.some((child) => child?.type === "b"),
  };
}

function renderSlot(append: string, props?: { sessionID: string }): unknown {
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      elementProps: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...elementProps, children: children.length > 1 ? children : children[0] };
      return typeof type === "function" ? type(all) : { type, props: all };
    },
  });
  // The RPC never answers: the seeded signals hold what the view shows.
  const pending = () => new Promise(() => {});
  let render: ((props?: { sessionID: string }) => unknown) | undefined;
  plugin.setup({
    client: { rpc: () => ({ surface: pending, footer: pending, writeExport: pending }) },
    location: { directory: "/work/project" },
    theme: { text: { base: "base", muted: "muted" } },
    data: { on: vi.fn(() => vi.fn()) },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim) => {
        if (claim.append === append) render = claim.render;
        return vi.fn();
      }),
    },
  } as any);
  return createRoot((dispose) => {
    const tree = render?.(props);
    dispose();
    return tree;
  });
}

describe("V2 TUI theme colors", () => {
  afterEach(() => {
    seeds.length = 0;
  });

  it("draws the sidebar like OpenCode's Context section: bold base titles, muted body", () => {
    const message = ["[Copilot] (individual)*", "Premium   5h   80%", "", "Session tokens"].join(
      "\n",
    );
    seeds.push(true, { message, duration: 5000, activeProviderCount: 1 });

    const texts = findNodes(renderSlot("sidebar.content", { sessionID: "ses_1" }), "text");

    expect(texts.map(describeText)).toEqual([
      { text: "▼", fg: "base", bold: false },
      { text: "Quota", fg: "base", bold: true },
      { text: "[Copilot] (individual)*", fg: "base", bold: true },
      { text: "Premium   5h   80%", fg: "muted", bold: false },
      { text: " ", fg: "muted", bold: false },
      { text: "Session tokens", fg: "muted", bold: false },
    ]);
  });

  it("draws the sidebar's empty state muted", () => {
    const texts = findNodes(renderSlot("sidebar.content", { sessionID: "ses_1" }), "text");

    expect(texts.map(describeText)).toEqual([
      { text: "Quota", fg: "base", bold: true },
      { text: "No quota data available", fg: "muted", bold: false },
    ]);
  });

  it.each([
    ["prompt.footer", { sessionID: "ses_1" }],
    ["home.footer.status", undefined],
  ])("draws the %s line muted", (append, props) => {
    seeds.push(["Copilot 50%"]);

    const texts = findNodes(renderSlot(append, props), "text");

    expect(texts.map(describeText)).toEqual([{ text: "Copilot 50%", fg: "muted", bold: false }]);
  });
});
