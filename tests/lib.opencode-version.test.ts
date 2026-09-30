import { describe, expect, it } from "vitest";

import { detectOpenCodeMajor, parseOpenCodeMajor } from "../src/lib/opencode-version.js";

describe("OpenCode version detection", () => {
  it.each([
    ["1.18.32\n", 1],
    ["opencode v2.0.16\n", 2],
    ["opencode v2.1.0-beta.1", 2],
    ["v1.0.0", 1],
    ["0.15.8", undefined],
    ["opencode v3.0.0", undefined],
    ["", undefined],
    ["command not found", undefined],
  ])("parses %j as %j", (output, major) => {
    expect(parseOpenCodeMajor(output)).toBe(major);
  });

  it("runs the version command through the given runner", async () => {
    expect(await detectOpenCodeMajor(async () => "1.18.32\n")).toBe(1);
    expect(await detectOpenCodeMajor(async () => "opencode v2.0.16\n")).toBe(2);
  });

  it("returns undefined when the command fails or times out", async () => {
    const missing = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    expect(await detectOpenCodeMajor(async () => Promise.reject(missing))).toBeUndefined();
  });
});
