import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
  getOpenCodeDbPathCandidates: vi.fn(() => ["/tmp/oc/opencode.db"]),
  readFile: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
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

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mocks.existsSync, readFileSync: mocks.readFileSync };
});

import {
  getCopilotQuotaAuthDiagnostics,
  hasCopilotQuotaRuntimeAvailable,
} from "../src/lib/copilot.js";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import {
  clearOpenCodeCredentialCacheForTests,
  clearReadAuthFileCacheForTests,
  readAuthFile,
} from "../src/lib/opencode-auth.js";
import { copilotProvider } from "../src/providers/copilot.js";

/** A Copilot OAuth credential as OpenCode 2 stores it in `opencode.db`. */
const STORED_COPILOT_OAUTH = {
  integration_id: "github-copilot",
  value: JSON.stringify({
    type: "oauth",
    methodID: "device",
    refresh: "refresh-token",
    access: "access-token",
    expires: 0,
    metadata: { apiEndpoint: "https://api.individual.githubcopilot.com" },
  }),
};

function givenStored(rows: Array<{ integration_id: string; value: string }>): void {
  mocks.openOpenCodeSqliteReadOnly.mockResolvedValue(fakeConn(rows));
}

function fakeConn(rows: Array<{ integration_id: string; value: string }>) {
  return {
    all: vi.fn(() => rows),
    get: vi.fn(() => null),
    close: vi.fn(),
  };
}

describe("Copilot quota auth from the OpenCode 2 credential store", () => {
  beforeEach(() => {
    clearReadAuthFileCacheForTests();
    clearOpenCodeCredentialCacheForTests();
    mocks.getOpenCodeDbPathCandidates.mockReturnValue(["/tmp/oc/opencode.db"]);
    mocks.existsSync.mockReturnValue(false);
    mocks.readFile.mockReset();
    mocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mocks.openOpenCodeSqliteReadOnly.mockReset();
    mocks.openOpenCodeSqliteReadOnly.mockRejectedValue(new Error("missing"));
  });

  it("treats a stored Copilot OAuth credential as a configured login", async () => {
    givenStored([STORED_COPILOT_OAUTH]);

    const diagnostics = getCopilotQuotaAuthDiagnostics(await readAuthFile());

    expect(diagnostics.oauth.configured).toBe(true);
    expect(diagnostics.oauth.keyName).toBe("github-copilot");
    expect(diagnostics.oauth.hasAccessToken).toBe(true);
    expect(diagnostics.oauth.hasRefreshToken).toBe(true);
    expect(diagnostics.effectiveSource).toBe("oauth");
    expect(diagnostics.deployment).toBe("github.com");
    expect(diagnostics.quotaApi).toBe("copilot_internal_user");
    expect(diagnostics.billingMode).toBe("user_quota");
    expect(diagnostics.billingScope).toBe("user");
    expect(diagnostics.billingApiAccessLikely).toBe(true);
    expect(diagnostics.oauthAccountingState).toBe("available_via_copilot_internal_user");
  });

  it("reports the Copilot provider as available without a canonical provider id", async () => {
    givenStored([STORED_COPILOT_OAUTH]);

    const ctx = {
      resolveRuntimeProviderIds: async () => new Set<string>(),
    } as unknown as QuotaProviderContext;

    await expect(copilotProvider.isAvailable(ctx)).resolves.toBe(true);
    await expect(hasCopilotQuotaRuntimeAvailable()).resolves.toBe(true);
  });

  it("stays unavailable when neither auth.json nor the credential store has Copilot", async () => {
    const ctx = {
      resolveRuntimeProviderIds: async () => new Set<string>(),
    } as unknown as QuotaProviderContext;

    await expect(copilotProvider.isAvailable(ctx)).resolves.toBe(false);
    await expect(hasCopilotQuotaRuntimeAvailable()).resolves.toBe(false);
  });
});
