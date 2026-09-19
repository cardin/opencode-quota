import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
  getOpenCodeDbPathCandidates: vi.fn(() => ["/tmp/oc/opencode.db"]),
}));

vi.mock("../src/lib/opencode-sqlite.js", () => ({
  openOpenCodeSqliteReadOnly: mocks.openOpenCodeSqliteReadOnly,
}));

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPathCandidates: mocks.getOpenCodeDbPathCandidates,
}));

import {
  clearOpenCodeCredentialCacheForTests,
  normalizeStoredCredential,
  readOpenCodeCredentials,
  readOpenCodeCredentialsCached,
} from "../src/lib/opencode-credential-store.js";

function fakeConn(rows: unknown[]) {
  return {
    all: vi.fn(() => rows),
    get: vi.fn(() => null),
    close: vi.fn(),
  };
}

describe("opencode-credential-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenCodeCredentialCacheForTests();
    mocks.getOpenCodeDbPathCandidates.mockReturnValue(["/tmp/oc/opencode.db"]);
  });

  describe("normalizeStoredCredential", () => {
    it("normalizes key credentials to the api auth shape", () => {
      expect(normalizeStoredCredential('{"type":"key","key":" oc_key "}')).toEqual({
        type: "api",
        key: "oc_key",
      });
    });

    it("normalizes oauth credentials", () => {
      expect(
        normalizeStoredCredential('{"type":"oauth","access":"a","refresh":"r","expires":123}'),
      ).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 123 });
    });

    it("rejects malformed, empty, and unknown entries", () => {
      expect(normalizeStoredCredential("not json")).toBeNull();
      expect(normalizeStoredCredential('{"type":"key","key":"  "}')).toBeNull();
      expect(normalizeStoredCredential('{"type":"oauth"}')).toBeNull();
      expect(normalizeStoredCredential('{"type":"other"}')).toBeNull();
      expect(normalizeStoredCredential(null)).toBeNull();
    });
  });

  it("reads credentials keyed by integration id, latest wins", async () => {
    mocks.openOpenCodeSqliteReadOnly.mockResolvedValue(
      fakeConn([
        { integration_id: "provider", value: '{"type":"key","key":"old"}' },
        { integration_id: "provider", value: '{"type":"key","key":"new"}' },
        { integration_id: "other", value: '{"type":"oauth","access":"a"}' },
        { integration_id: "", value: '{"type":"key","key":"ignored"}' },
      ]),
    );

    await expect(readOpenCodeCredentials()).resolves.toEqual({
      provider: { type: "api", key: "new" },
      other: { type: "oauth", access: "a", refresh: "", expires: 0 },
    });
  });

  it("returns null when no candidate database can be opened", async () => {
    mocks.openOpenCodeSqliteReadOnly.mockRejectedValue(new Error("missing"));
    await expect(readOpenCodeCredentials()).resolves.toBeNull();
  });

  it("caches reads within the max age", async () => {
    mocks.openOpenCodeSqliteReadOnly.mockResolvedValue(
      fakeConn([{ integration_id: "provider", value: '{"type":"key","key":"k"}' }]),
    );

    await readOpenCodeCredentialsCached({ maxAgeMs: 60_000 });
    await readOpenCodeCredentialsCached({ maxAgeMs: 60_000 });

    expect(mocks.openOpenCodeSqliteReadOnly).toHaveBeenCalledOnce();
  });
});
