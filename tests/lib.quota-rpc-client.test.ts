import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { callQuotaRpc, QuotaRpcTransportError } from "../src/lib/quota-rpc-client.js";

type Answer = { status: number; body: string } | "never";

describe("callQuotaRpc", () => {
  let server: Server | undefined;
  let requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    body: string;
  }>;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  async function startServer(answer: Answer): Promise<string> {
    requests = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        if (answer === "never") return;
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function callFailure(url: string, timeoutMs = 5000): Promise<unknown> {
    return callQuotaRpc(
      { url, headers: {} },
      "cli",
      { command: "show" },
      { directory: "/home/user", timeoutMs },
    ).then(
      () => {
        throw new Error("expected the call to fail");
      },
      (error: unknown) => error,
    );
  }

  it("posts the input to the plugin's method at the location and returns the output", async () => {
    const url = await startServer({
      status: 200,
      body: JSON.stringify({ output: { exitCode: 0, stdout: "ok\n", stderr: "" } }),
    });

    const output = await callQuotaRpc(
      { url, headers: { authorization: "Basic abc" } },
      "cli",
      { command: "show-json", threshold: 5 },
      { directory: "/Users/Jöhn Doe", timeoutMs: 5000 },
    );

    expect(output).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/api/rpc/slkiser.opencode-quota/cli");
    expect(requests[0].headers.authorization).toBe("Basic abc");
    expect(requests[0].headers["content-type"]).toBe("application/json");
    expect(requests[0].headers["x-opencode-directory"]).toBe("%2FUsers%2FJ%C3%B6hn%20Doe");
    expect(decodeURIComponent(requests[0].headers["x-opencode-directory"] as string)).toBe(
      "/Users/Jöhn Doe",
    );
    expect(JSON.parse(requests[0].body)).toEqual({
      input: { command: "show-json", threshold: 5 },
    });
  });

  it("explains an unloaded server plugin", async () => {
    const url = await startServer({
      status: 400,
      body: JSON.stringify({
        _tag: "RpcError",
        type: "rpc.unavailable",
        message: "RPC is unavailable: slkiser.opencode-quota",
      }),
    });

    const error = await callFailure(url);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toBe(
      "OpenCode Quota's server plugin is not loaded. Check the plugin entry in opencode.json and restart OpenCode.",
    );
  });

  it("explains a rejected service password", async () => {
    const url = await startServer({
      status: 401,
      body: JSON.stringify({ _tag: "UnauthorizedError", message: "Unauthorized" }),
    });

    const error = await callFailure(url);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toBe(
      "OpenCode's service password changed. Restart OpenCode and try again.",
    );
  });

  it("passes other RPC errors on as a sanitized single line", async () => {
    const url = await startServer({
      status: 400,
      body: JSON.stringify({
        _tag: "RpcError",
        type: "rpc.method_not_found",
        message: "Unknown RPC method:\u001b[31m slkiser.opencode-quota.cli\n",
      }),
    });

    const error = await callFailure(url);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toBe(
      "OpenCode could not run OpenCode Quota: Unknown RPC method: slkiser.opencode-quota.cli",
    );
  });

  it("names the HTTP status when the error body has no message", async () => {
    const url = await startServer({ status: 502, body: "<html>Bad gateway</html>" });

    const error = await callFailure(url);

    expect((error as Error).message).toBe("OpenCode could not run OpenCode Quota: HTTP 502");
  });

  it("rejects a successful answer without an output", async () => {
    const url = await startServer({ status: 200, body: JSON.stringify({ result: {} }) });

    const error = await callFailure(url);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toBe("OpenCode returned an answer without an output.");
  });

  it("reports a network error with its reason", async () => {
    const url = await startServer({ status: 200, body: "{}" });
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;

    const error = await callFailure(url);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toMatch(/^Could not reach OpenCode: .*ECONNREFUSED/);
  });

  it("reports a call that does not answer in time", async () => {
    const url = await startServer("never");

    const error = await callFailure(url, 200);

    expect(error).toBeInstanceOf(QuotaRpcTransportError);
    expect((error as Error).message).toBe("OpenCode did not answer within 0.2 s. Try again.");
  });
});
