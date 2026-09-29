import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
  getOpenCodeDbPathCandidates: vi.fn(() => ["/tmp/oc/opencode.db"]),
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-sqlite.js", () => ({
  openOpenCodeSqliteReadOnly: mocks.openOpenCodeSqliteReadOnly,
}));

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPathCandidates: mocks.getOpenCodeDbPathCandidates,
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, readFile: mocks.readFile };
});

import {
  clearReadAuthFileCacheForTests,
  readAuthFile,
  readAuthFileCached,
} from "../src/lib/opencode-auth.js";
import { clearOpenCodeCredentialCacheForTests } from "../src/lib/opencode-credential-store.js";

function fakeConn(rows: Array<{ integration_id: string; value: string }>) {
  return {
    all: vi.fn(() => rows),
    get: vi.fn(() => null),
    close: vi.fn(),
  };
}

function givenStored(rows: Array<{ integration_id: string; value: string }>): void {
  mocks.openOpenCodeSqliteReadOnly.mockResolvedValue(fakeConn(rows));
}

function givenNoCredentialDatabase(): void {
  mocks.openOpenCodeSqliteReadOnly.mockRejectedValue(new Error("missing"));
}

function givenAuthJson(payload: unknown): void {
  mocks.readFile.mockResolvedValue(JSON.stringify(payload));
}

function givenNoAuthJson(): void {
  mocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

describe("readAuthFile (OpenCode 2 credential store layering)", () => {
  beforeEach(() => {
    clearReadAuthFileCacheForTests();
    clearOpenCodeCredentialCacheForTests();
    mocks.getOpenCodeDbPathCandidates.mockReturnValue(["/tmp/oc/opencode.db"]);
    mocks.readFile.mockReset();
    mocks.openOpenCodeSqliteReadOnly.mockReset();
    givenNoAuthJson();
    givenNoCredentialDatabase();
  });

  it("layers credential-store rows over legacy auth.json entries", async () => {
    givenStored([
      {
        integration_id: "github-copilot",
        value: '{"type":"oauth","access":"fresh","refresh":"r2","expires":456}',
      },
    ]);
    givenAuthJson({
      "github-copilot": {
        type: "oauth",
        access: "stale",
        refresh: "old",
        expires: 1,
        enterpriseUrl: "acme.ghe.com",
      },
      "legacy-only": { type: "api", key: "k" },
    });

    await expect(readAuthFile()).resolves.toEqual({
      "github-copilot": {
        type: "oauth",
        access: "fresh",
        refresh: "r2",
        expires: 456,
        // Non-credential file metadata survives when the stored row omits it.
        enterpriseUrl: "acme.ghe.com",
      },
      "legacy-only": { type: "api", key: "k" },
    });
  });

  it("returns credential-store rows when auth.json is absent", async () => {
    givenStored([
      {
        integration_id: "github-copilot",
        value: '{"type":"oauth","access":"a","refresh":"r","expires":123}',
      },
    ]);

    await expect(readAuthFile()).resolves.toEqual({
      "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 123 },
    });
  });

  it("falls back to auth.json when the credential store is unavailable", async () => {
    givenNoCredentialDatabase();
    givenAuthJson({ anthropic: { type: "oauth", access: "tok" } });

    await expect(readAuthFile()).resolves.toEqual({ anthropic: { type: "oauth", access: "tok" } });
  });

  it("drops stale file credentials once the store owns the integration id", async () => {
    givenStored([{ integration_id: "opencode-go", value: '{"type":"key","key":"oc_new"}' }]);
    givenAuthJson({ "opencode-go": { type: "api", key: "stale_key" } });

    await expect(readAuthFile()).resolves.toEqual({
      "opencode-go": { type: "api", key: "oc_new" },
    });
  });

  it("returns null when neither source has credentials", async () => {
    givenNoCredentialDatabase();
    givenNoAuthJson();

    await expect(readAuthFile()).resolves.toBeNull();
  });

  it("returns null when the store is empty and auth.json is missing", async () => {
    givenStored([]);
    givenNoAuthJson();

    await expect(readAuthFile()).resolves.toBeNull();
  });

  it("reuses the cached credential-store read within maxAgeMs", async () => {
    givenStored([{ integration_id: "openai", value: '{"type":"oauth","access":"a"}' }]);
    givenNoAuthJson();

    await readAuthFile({ maxAgeMs: 60_000 });
    await readAuthFile({ maxAgeMs: 60_000 });

    expect(mocks.openOpenCodeSqliteReadOnly).toHaveBeenCalledOnce();
  });

  it("exposes the same layered result through the cached reader", async () => {
    givenStored([
      { integration_id: "github-copilot", value: '{"type":"oauth","access":"a","refresh":"r"}' },
    ]);

    await expect(readAuthFileCached({ maxAgeMs: 0 })).resolves.toEqual({
      "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 0 },
    });
  });
});
