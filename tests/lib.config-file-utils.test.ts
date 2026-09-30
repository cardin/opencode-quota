import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRuntimeContextRoots } from "../src/lib/config-file-utils.js";

const WORKSPACE_ROOT = resolve("work", "repo");
const FALLBACK_DIRECTORY = resolve(WORKSPACE_ROOT, "packages", "app");

describe("resolveRuntimeContextRoots", () => {
  const original = process.env.OPENCODE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = original;
    }
  });

  it("uses the workspace root as config root even when OPENCODE_CONFIG_DIR is set", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: WORKSPACE_ROOT,
        fallbackDirectory: FALLBACK_DIRECTORY,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
      configRoot: WORKSPACE_ROOT,
    });
  });

  it("uses explicit configRoot as-is", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    const explicitConfigRoot = resolve(WORKSPACE_ROOT, ".explicit");
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: WORKSPACE_ROOT,
        configRoot: explicitConfigRoot,
        fallbackDirectory: FALLBACK_DIRECTORY,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
      configRoot: explicitConfigRoot,
    });
  });
});
