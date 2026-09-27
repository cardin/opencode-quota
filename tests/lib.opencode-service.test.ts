import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverOpenCodeService } from "../src/lib/opencode-service.js";

type InfoAnswer = { status: number; body: unknown } | "never";

describe("discoverOpenCodeService", () => {
  let stateHome: string;
  let savedStateHome: string | undefined;
  let server: Server | undefined;
  let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;

  // Every test points XDG_STATE_HOME at a temp folder, so the real service.json is never read.
  beforeEach(() => {
    savedStateHome = process.env.XDG_STATE_HOME;
    stateHome = mkdtempSync(join(tmpdir(), "opencode-quota-service-"));
    process.env.XDG_STATE_HOME = stateHome;
    requests = [];
  });

  afterEach(async () => {
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
    rmSync(stateHome, { recursive: true, force: true });
  });

  async function startInfoServer(answer: InfoAnswer): Promise<string> {
    server = createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      if (answer === "never") return;
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function writeRegistration(value: unknown): void {
    mkdirSync(join(stateHome, "opencode"), { recursive: true });
    writeFileSync(
      join(stateHome, "opencode", "service.json"),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  }

  it("returns undefined when no service is registered", async () => {
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined for a registration file that is not valid JSON", async () => {
    writeRegistration("{not json");

    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined for a registration without a url or an integer pid", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.16", pid: 42 } });

    writeRegistration({ pid: 42 });
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
    writeRegistration({ url, pid: "42" });
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
    writeRegistration({ url, pid: 4.2 });
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("finds a service without a password and sends no authorization header", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.16", pid: 42 } });
    writeRegistration({ id: "service", version: "2.0.16", url, pid: 42 });

    await expect(discoverOpenCodeService()).resolves.toEqual({ url, headers: {} });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/info");
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("finds a service with a password and returns its basic auth header", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.16", pid: 42 } });
    writeRegistration({ id: "service", version: "2.0.16", url, pid: 42, password: "secret" });
    const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;

    await expect(discoverOpenCodeService()).resolves.toEqual({
      url,
      headers: { authorization },
    });
    expect(requests[0].headers.authorization).toBe(authorization);
  });

  it("returns undefined when another process answers", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.16", pid: 7 } });
    writeRegistration({ version: "2.0.16", url, pid: 42 });

    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined when the answering version differs from the registration", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.17", pid: 42 } });
    writeRegistration({ version: "2.0.16", url, pid: 42 });

    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined for a non-2xx answer or a malformed info body", async () => {
    const url = await startInfoServer({ status: 401, body: { message: "Unauthorized" } });
    writeRegistration({ url, pid: 42, password: "old" });

    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));

    const malformed = await startInfoServer({ status: 200, body: { version: 2, pid: 42 } });
    writeRegistration({ url: malformed, pid: 42 });
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined when nothing listens at the registered url", async () => {
    const url = await startInfoServer({ status: 200, body: { version: "2.0.16", pid: 42 } });
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    writeRegistration({ url, pid: 42 });

    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
  });

  it("returns undefined when the service does not answer within 2 seconds", async () => {
    const url = await startInfoServer("never");
    writeRegistration({ url, pid: 42 });

    const startedAt = Date.now();
    await expect(discoverOpenCodeService()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
    expect(requests).toHaveLength(1);
  });
});
