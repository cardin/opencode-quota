import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/** Every dist file that dist/tui.js loads through relative `import` and `export ... from`. */
function reachableFrom(entry: string): string[] {
  const reached = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:import|export)\b[^"';]*?["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      pending.push(resolve(dirname(file), match[1]));
    }
  }
  return [...reached].map((file) => relative(distDir, file)).sort();
}

describe("tui dist import graph", () => {
  // Run after `pnpm build`. The TUI asks the server plugin for quota over the RPC, so it
  // must load no login reader and no provider code.
  it("reaches no credential or provider module from dist/tui.js", () => {
    const entry = resolve(distDir, "tui.js");
    expect(existsSync(entry)).toBe(true);

    const reached = reachableFrom(entry);

    expect(reached).toContain("rpc.js");
    expect(reached).not.toContain("lib/opencode-auth.js");
    expect(reached.filter((file) => file.startsWith("providers/"))).toEqual([]);
    // node:sqlite is allowed: the session and token-history storage (opencode-storage.js ->
    // opencode-sqlite.js) is reachable through config.js -> quota-providers.js ->
    // quota-stats.js, but it opens a database only when called, and the TUI never calls it.
    // It reads no logins; only the login reader's SQL names the credential table.
    expect(
      reached.filter((file) =>
        readFileSync(resolve(distDir, file), "utf8").includes("FROM credential"),
      ),
    ).toEqual([]);
  });
});
