/**
 * Calls OpenCode Quota's plugin RPC over the OpenCode service's HTTP API with plain `fetch`,
 * so the terminal command loads no `@opencode/*` package.
 */
import { QUOTA_RPC_ID, type QuotaRpc } from "../rpc.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { OpenCodeServiceEndpoint } from "./opencode-service.js";

/** OpenCode or the plugin could not be reached, or the call failed before a result came back. */
export class QuotaRpcTransportError extends Error {
  override name = "QuotaRpcTransportError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POSTs `{ input }` to `/api/rpc/<id>/<method>` in the given location and returns the
 * `output` of the answer. Throws `QuotaRpcTransportError` with a message for the user when
 * the call fails.
 */
export async function callQuotaRpc(
  endpoint: OpenCodeServiceEndpoint,
  method: keyof typeof QuotaRpc.methods,
  input: unknown,
  options: { directory: string; timeoutMs: number },
): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(
      new URL(`/api/rpc/${encodeURIComponent(QUOTA_RPC_ID)}/${method}`, endpoint.url),
      {
        method: "POST",
        headers: {
          ...endpoint.headers,
          "content-type": "application/json",
          "x-opencode-directory": encodeURIComponent(options.directory),
        },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new QuotaRpcTransportError(
        `OpenCode did not answer within ${options.timeoutMs / 1000} s. Try again.`,
      );
    }
    // Node's fetch reports "fetch failed" and keeps the reason (for example ECONNREFUSED) in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new QuotaRpcTransportError(
      `Could not reach OpenCode: ${sanitizeSingleLineDisplayText(message)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (response.status === 401) {
    throw new QuotaRpcTransportError(
      "OpenCode's service password changed. Restart OpenCode and try again.",
    );
  }
  if (!response.ok) {
    if (isRecord(body) && body.type === "rpc.unavailable") {
      throw new QuotaRpcTransportError(
        "OpenCode Quota's server plugin is not loaded. Check the plugin entry in opencode.json and restart OpenCode.",
      );
    }
    const message =
      isRecord(body) && typeof body.message === "string"
        ? sanitizeSingleLineDisplayText(body.message)
        : `HTTP ${response.status}`;
    throw new QuotaRpcTransportError(`OpenCode could not run OpenCode Quota: ${message}`);
  }
  if (!isRecord(body) || !("output" in body)) {
    throw new QuotaRpcTransportError("OpenCode returned an answer without an output.");
  }
  return body.output;
}
