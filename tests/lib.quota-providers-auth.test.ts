import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(homedir(), ".local", "share", "opencode"),
    configDir: join(homedir(), ".config", "opencode"),
    cacheDir: join(homedir(), ".cache", "opencode"),
    stateDir: join(homedir(), ".local", "state", "opencode"),
  }),
}));

vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import type { RemoteApiQuotaProviderDefinition } from "../src/lib/quota-providers.js";
import { resolveQuotaProviderApiKey } from "../src/lib/quota-providers-remote.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

function source(
  overrides: Partial<RemoteApiQuotaProviderDefinition> = {},
): RemoteApiQuotaProviderDefinition {
  return {
    id: "source-one",
    providerId: "provider-one",
    label: "Source One",
    url: "https://provider.example/accounting",
    mode: "remote-api",
    format: "quota-v1",
    apiKeyEnv: "EXPLICIT_KEY",
    ...overrides,
  };
}

describe("quota provider trusted auth binding", () => {
  const originalEnv = { ...process.env };
  const trustedJson = join(homedir(), ".config", "opencode", "opencode.json");
  const trustedJsonc = join(homedir(), ".config", "opencode", "opencode.jsonc");
  const authJson = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const workspaceJson = join(process.cwd(), "opencode.json");

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.EXPLICIT_KEY;
    delete process.env.OTHER_KEY;
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(readFile).mockReset().mockRejectedValue(new Error("missing"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses explicit environment auth before trusted config and strict opencode.db", async () => {
    process.env.EXPLICIT_KEY = "env-secret";
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    vi.mocked(existsSync).mockImplementation((path) => path === trustedJson);
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === trustedJson) {
        return JSON.stringify({
          provider: { "provider-one": { options: { apiKey: "config-secret" } } },
        });
      }
      if (path === authJson) {
        return JSON.stringify({
          "provider-one": { type: "api", key: "auth-secret" },
        });
      }
      throw new Error("missing");
    });

    const result = await resolveQuotaProviderApiKey(source());
    expect(result.key).toBe("env-secret");
    expect(result.source).toBe("env");
  });

  it("uses only the exact providerId in trusted global provider config", async () => {
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    vi.mocked(existsSync).mockImplementation((path) => path === trustedJson);
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === trustedJson) {
        return JSON.stringify({
          provider: {
            "provider-one-alias": { options: { apiKey: "neighbor-secret" } },
            "provider-one": { options: { apiKey: "exact-secret" } },
          },
        });
      }
      throw new Error("missing");
    });

    const result = await resolveQuotaProviderApiKey(source());
    expect(result.key).toBe("exact-secret");
    expect(result.source).toBe("opencode.json");
  });

  it("expands a global config env template only for exact explicit apiKeyEnv", async () => {
    process.env.EXPLICIT_KEY = "explicit-secret";
    process.env.OTHER_KEY = "other-secret";
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    vi.mocked(existsSync).mockImplementation((path) => path === trustedJsonc);
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === trustedJsonc) {
        return JSON.stringify({
          provider: {
            "provider-one": { options: { apiKey: "{env:OTHER_KEY}" } },
          },
        });
      }
      throw new Error("missing");
    });

    const result = await resolveQuotaProviderApiKey(source({ apiKeyEnv: "EXPLICIT_KEY" }));
    expect(result.key).toBe("explicit-secret");

    delete process.env.EXPLICIT_KEY;
    const disallowed = await resolveQuotaProviderApiKey(source({ apiKeyEnv: "EXPLICIT_KEY" }));
    expect(disallowed.key).toBeUndefined();
    expect(JSON.stringify(disallowed)).not.toContain("other-secret");
  });

  it("ignores legacy opencode.db entries", async () => {
    const { readFile } = await import("fs/promises");
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === authJson) {
        return JSON.stringify({
          "provider-one": { type: "api", key: "auth-secret" },
          "provider-one-alias": { type: "api", key: "neighbor-secret" },
        });
      }
      throw new Error("missing");
    });

    const result = await resolveQuotaProviderApiKey(source());
    expect(result.key).toBeUndefined();
    expect(result.source).toBeNull();
  });

  it("never reads workspace config, SDK config, aliases, or derived env names", async () => {
    process.env.PROVIDER_ONE_API_KEY = "derived-secret";
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    vi.mocked(existsSync).mockImplementation((path) => path === workspaceJson);
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === workspaceJson) {
        return JSON.stringify({
          provider: { "provider-one": { options: { apiKey: "workspace-secret" } } },
        });
      }
      throw new Error("missing");
    });

    const result = await resolveQuotaProviderApiKey(source({ apiKeyEnv: undefined }));
    expect(result.key).toBeUndefined();
    expect(result.checkedPaths).not.toContain(workspaceJson);
    expect(JSON.stringify(result)).not.toMatch(/workspace-secret|derived-secret/);
  });

  it("reads only a key login for the providerId and never resolves an OAuth sign-in", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "opencode",
        id: "cred_console",
        label: "default",
        registered: true,
        method: "oauth",
        value: { type: "oauth", methodID: "device", access: "console-access", expires: 0 },
      },
      {
        integrationId: "provider-one",
        id: "cred_provider_one",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "db-secret" },
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    try {
      const signIn = await resolveQuotaProviderApiKey(
        source({ providerId: "opencode", apiKeyEnv: undefined }),
      );
      expect(signIn.key).toBeUndefined();
      expect(integration.connection.resolve).not.toHaveBeenCalled();

      const keyLogin = await resolveQuotaProviderApiKey(source({ apiKeyEnv: undefined }));
      expect(keyLogin).toMatchObject({ key: "db-secret", source: "opencode.db" });
    } finally {
      unbind();
      notifyCredentialsChanged();
    }
  });
});
