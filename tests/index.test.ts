import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  QuotaToastPlugin: vi.fn(),
  QUOTA_PLUGIN_ID: "@cardin/opencode-quota",
}));

vi.mock("../src/plugin.js", () => ({
  QuotaToastPlugin: pluginMocks.QuotaToastPlugin,
  QUOTA_PLUGIN_ID: pluginMocks.QUOTA_PLUGIN_ID,
}));

describe("package entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports the V2 plugin definition on the default export", async () => {
    const mod = await import("../src/index.js");

    // OpenCode 2 plugins ship a single `Plugin.define` definition on the default
    // export; the V1 `{ id, server }` module shape was removed in the port.
    expect(mod.default).toBe(pluginMocks.QuotaToastPlugin);
    expect(mod.QuotaToastPlugin).toBe(pluginMocks.QuotaToastPlugin);
    expect(mod.QUOTA_PLUGIN_ID).toBe(pluginMocks.QUOTA_PLUGIN_ID);
    expect(mod.QUOTA_PROVIDER_REMOTE_FORMATS).toEqual(["quota-v1", "openrouter-key-v1", "json-v1"]);
    expect(JSON.stringify(mod.QUOTA_PROVIDER_REMOTE_FORMATS)).not.toContain(
      ["accounting", "v1"].join("-"),
    );
  });
});
