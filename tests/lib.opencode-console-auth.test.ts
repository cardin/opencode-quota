import { afterEach, describe, expect, it } from "vitest";

import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  resolveOpenCodeConsoleAuth,
} from "../src/lib/opencode-console-auth.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const unbinds: Array<() => void> = [];

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
});

function bindConsoleLogins(credentials: FakeCredential[]) {
  const integration = createFakeIntegration(credentials);
  unbinds.push(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
  return integration;
}

function consoleLogin(
  value: Record<string, unknown>,
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return {
    integrationId: "opencode",
    id: "cred_console",
    label: "default",
    registered: true,
    method: value.type === "key" ? "key" : "oauth",
    value,
    ...overrides,
  };
}

describe("OpenCode Console credential reader", () => {
  it("returns none without console credentials", async () => {
    bindConsoleLogins([]);
    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "none" });
  });

  it("resolves the configured console credential with org metadata", async () => {
    const expires = Date.now() + 60_000;
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "server",
        access: "console-access",
        refresh: "console-refresh",
        expires,
        metadata: {
          accountID: "acc_1",
          email: "ran@example.com",
          orgID: "wrk_1",
          orgName: "WSC Sports",
        },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    expect(state).toEqual({
      state: "configured",
      credential: {
        accessToken: "console-access",
        refreshToken: "console-refresh",
        expiresAt: expires,
        accountId: "acc_1",
        orgId: "wrk_1",
        orgName: "WSC Sports",
        email: "ran@example.com",
        server: undefined,
      },
    });
  });

  it("reports expired console credentials", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "console-access",
        expires: Date.now() - 60_000,
        metadata: { orgID: "wrk_1" },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    expect(state.state).toBe("expired");
  });

  it("reports invalid credentials without an access token", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "  ",
        expires: 0,
      }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "invalid",
      error: "OpenCode Console credential has no access token",
    });
  });

  it("ignores key-shaped opencode rows", async () => {
    bindConsoleLogins([consoleLogin({ type: "key", key: "workspace-key" })]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "none",
      reason: "not_oauth",
    });
  });

  it("reads only the active opencode login", async () => {
    const integration = bindConsoleLogins([
      consoleLogin({ type: "key", key: "workspace-key" }, { id: "cred_workspace" }),
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: "console-refresh",
          access: "console-access",
          expires: Date.now() + 60_000,
        },
        { id: "cred_console_inactive" },
      ),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "none",
      reason: "not_oauth",
    });
    expect(integration.list).not.toHaveBeenCalled();
    expect(integration.connection.active.mock.calls).toEqual([["opencode"]]);
    expect(integration.connection.resolve.mock.calls).toEqual([
      [{ type: "credential", id: "cred_workspace", label: "default", method: "key" }],
    ]);
  });

  it("reports a login OpenCode could not return as invalid", async () => {
    bindConsoleLogins([
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: "console-refresh",
          access: "console-access",
          expires: 0,
        },
        { resolveError: "HTTP 401" },
      ),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "invalid",
      error: "refresh_failed: HTTP 401",
    });
  });

  it("uses the active sign-in and resolves no other login", async () => {
    const signIn = (id: string, orgID: string) =>
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: `${id}-refresh`,
          access: `${id}-access`,
          expires: Date.now() + 60_000,
          metadata: { orgID },
        },
        { id },
      );
    const integration = bindConsoleLogins([
      signIn("cred_active", "wrk_active"),
      signIn("cred_other", "wrk_other"),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "configured",
      credential: { accessToken: "cred_active-access", orgId: "wrk_active" },
    });
    expect(integration.connection.resolve).toHaveBeenCalledOnce();
  });

  it("keeps the Console server the sign-in belongs to", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "console-access",
        expires: Date.now() + 60_000,
        metadata: { server: "https://console.example.test" },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    if (state.state !== "configured") throw new Error(`unexpected state ${state.state}`);
    expect(consoleBaseUrl(state.credential)).toBe("https://console.example.test");
  });
});

describe("Console request helpers", () => {
  it("uses the login's server, else the default Console server", () => {
    expect(consoleBaseUrl({ accessToken: "a", server: "https://console.example.test" })).toBe(
      "https://console.example.test",
    );
    expect(consoleBaseUrl({ accessToken: "a" })).toBe("https://opencode.ai/console");
  });

  it("sends the bearer token, and the org only when the login has one", () => {
    expect(consoleHeaders({ accessToken: "console-access", orgId: "wrk_1" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
      "x-org-id": "wrk_1",
    });
    expect(consoleHeaders({ accessToken: "console-access" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
    });
    expect(Object.keys(consoleHeaders({ accessToken: "console-access" }))).not.toContain(
      "x-org-id",
    );
  });
});
