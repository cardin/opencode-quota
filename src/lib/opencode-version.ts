import { execFile } from "node:child_process";

export type OpenCodeMajor = 1 | 2;

const OPENCODE_VERSION_TIMEOUT_MS = 5_000;

/** OpenCode 1 prints a bare `1.18.32`; OpenCode 2 prints `opencode v2.0.16`. */
export function parseOpenCodeMajor(output: string): OpenCodeMajor | undefined {
  const match = /^(?:opencode\s+)?v?(\d+)\.\d+\.\d+/.exec(output.trim());
  if (match?.[1] === "1") return 1;
  if (match?.[1] === "2") return 2;
  return undefined;
}

function runOpenCodeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "opencode",
      ["--version"],
      { encoding: "utf8", timeout: OPENCODE_VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Returns undefined when `opencode` is not on PATH, fails, times out, or prints an unknown version. */
export async function detectOpenCodeMajor(
  runVersion: () => Promise<string> = runOpenCodeVersion,
): Promise<OpenCodeMajor | undefined> {
  try {
    return parseOpenCodeMajor(await runVersion());
  } catch {
    return undefined;
  }
}
