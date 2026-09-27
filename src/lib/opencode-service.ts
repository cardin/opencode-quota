/**
 * Finds the running OpenCode background service the way OpenCode's own clients do
 * (`@opencode/client` `Service.discover`): read its registration file, then check that the
 * registered process answers `/api/info`. It never starts OpenCode.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenCodeServiceEndpoint = { url: string; headers: Record<string, string> };

const INFO_TIMEOUT_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Returns the service URL and its auth headers, or undefined when no healthy service is
 * registered: no or unreadable registration file, no answer within 2 seconds, a non-2xx
 * answer, or an answer from a different process or version than the file names.
 */
export async function discoverOpenCodeService(): Promise<OpenCodeServiceEndpoint | undefined> {
  const file = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  );
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;

  let registration: unknown;
  try {
    registration = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(registration)) return undefined;
  const { url, pid, password, version } = registration;
  if (typeof url !== "string" || !isProcessId(pid)) return undefined;
  if (password !== undefined && typeof password !== "string") return undefined;

  const headers: Record<string, string> =
    password === undefined
      ? {}
      : { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };

  let info: unknown;
  try {
    const response = await fetch(new URL("/api/info", url), {
      headers,
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    info = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(info) || typeof info.version !== "string" || !isProcessId(info.pid)) {
    return undefined;
  }
  if (info.pid !== pid) return undefined;
  if (version !== undefined && info.version !== version) return undefined;

  return { url, headers };
}
