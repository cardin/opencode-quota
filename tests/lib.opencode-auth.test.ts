import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgyAccounts } from "../src/lib/google-agy.js";
import { resolveGeminiCliAccounts } from "../src/lib/google-gemini-cli.js";
import {
  clearReadAuthFileCacheForTests,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  getCredentialDatabasePaths,
  readAuthFile,
  readAuthFileCached,
  readCredentialRows,
  selectConnectionCredentialRows,
} from "../src/lib/opencode-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearReadAuthFileCacheForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCredentialDatabase(): Promise<{ dataDir: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-auth-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "opencode");
  await mkdir(dataDir, { recursive: true });
  const databasePath = join(dataDir, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE credential (
    id TEXT PRIMARY KEY,
    integration_id TEXT,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    connector_id TEXT,
    method_id TEXT,
    active INTEGER,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`);
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run(
      "copilot",
      "github-copilot",
      JSON.stringify({
        type: "oauth",
        access: "copilot-access",
        refresh: "copilot-refresh",
        expires: 10,
        metadata: { enterpriseUrl: "example.ghe.com" },
      }),
      1,
    );
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run(
      "openai",
      "openai",
      JSON.stringify({
        type: "oauth",
        access: "openai-access",
        refresh: "openai-refresh",
        expires: 20,
      }),
      2,
    );
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run("deepseek", "deepseek", JSON.stringify({ type: "key", key: "deepseek-key" }), 3);
  database.close();
  return { dataDir, databasePath };
}

describe("OpenCode auth reader", () => {
  it.each([
    ["OpenAI", "OpenAI (Pro)", "default", true, "[OpenAI] (Pro)*"],
    ["OpenAI", "OpenAI (Pro)", "SEPD", true, "[OpenAI SEPD] (Pro)*"],
    ["Copilot", "Copilot (business)", "sita", true, "[Copilot sita] (business)*"],
    ["xAI", "xAI SuperGrok", "personal", true, "[xAI personal] (SuperGrok)*"],
    ["OpenAI", "OpenAI (Pro)", "  ", true, "[OpenAI] (Pro)*"],
    ["OpenAI", "OpenAI (Pro)", "openai", true, "[OpenAI] (Pro)*"],
    // OpenCode 2 labels credentials imported from auth.json "OAuth" or "API key".
    ["OpenAI", "OpenAI (Pro)", "OAuth", true, "[OpenAI] (Pro)*"],
    ["Copilot", "Copilot (individual)", "OAuth", true, "[Copilot] (individual)*"],
    ["Z.ai", "Z.ai", "API key", true, "[Z.ai]*"],
    ["MiniMax", "MiniMax", "api key", true, "[MiniMax]*"],
    ["Kimi Code", "Kimi Code", "API key", true, "[Kimi Code]*"],
  ])("formats %s credential aliases as %s", (providerName, fallbackName, label, active, expected) => {
    expect(
      formatCredentialDisplayNames(providerName, [
        {
          row: { id: "credential", integrationId: providerName, label, active, value: {} },
          fallbackName,
        },
      ]),
    ).toEqual([expected]);
  });

  it("numbers duplicate custom aliases without numbering default credentials", () => {
    expect(
      formatCredentialDisplayNames("OpenAI", [
        {
          row: { id: "a", integrationId: "openai", label: "SEPD", active: true, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
        {
          row: { id: "b", integrationId: "openai", label: "SEPD", active: false, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
        {
          row: { id: "c", integrationId: "openai", label: "default", active: false, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
      ]),
    ).toEqual(["[OpenAI SEPD] (Pro)*", "[OpenAI SEPD 2] (Pro)", "[OpenAI] (Pro)"]);
  });

  it("keeps a named connection next to an imported generic one", () => {
    expect(
      formatCredentialDisplayNames("Z.ai", [
        {
          row: { id: "a", integrationId: "zai", label: "Work", active: true, value: {} },
          fallbackName: "Z.ai",
        },
        {
          row: { id: "b", integrationId: "zai", label: "API key", active: false, value: {} },
          fallbackName: "Z.ai",
        },
      ]),
    ).toEqual(["[Z.ai Work]*", "[Z.ai]"]);
  });

  it("reports the credential database path and honors OPENCODE_DB", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));

    expect(getCredentialDatabasePaths()).toEqual([join(dataDir, "opencode.db")]);

    vi.stubEnv("OPENCODE_DB", "custom.db");
    expect(getCredentialDatabasePaths()).toEqual([join(dataDir, "custom.db")]);
  });

  it("falls back to OAuth credentials stored in OpenCode's database", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));

    await expect(
      readAuthFile({ integrationIds: ["github-copilot", "deepseek", "openai"] }),
    ).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access", enterpriseUrl: "example.ghe.com" },
      deepseek: { type: "api", key: "deepseek-key" },
      openai: { access: "openai-access" },
    });
  });

  it("exposes every credential row with active rows first", async () => {
    const { databasePath } = await createCredentialDatabase();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE credential SET label = 'Work', active = 0 WHERE id = 'openai'").run();
    database
      .prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)")
      .run(
        "openai-active",
        "openai",
        "Personal",
        JSON.stringify({ type: "oauth", access: "personal-access" }),
        1,
        4,
        4,
      );
    database.close();
    vi.stubEnv("OPENCODE_DB", databasePath);

    await expect(readCredentialRows(["openai"])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai-active",
          integrationId: "openai",
          label: "Personal",
          active: true,
          value: expect.objectContaining({ access: "personal-access" }),
        }),
        expect.objectContaining({ id: "openai", active: false }),
      ]),
    );
    const rows = await readCredentialRows(["openai"]);
    expect(rows.findIndex((row) => row.id === "openai-active")).toBeLessThan(
      rows.findIndex((row) => row.id === "openai"),
    );
  });

  it("ignores legacy auth.json entries", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));
    await writeFile(
      join(dataDir, "auth.json"),
      JSON.stringify({ openai: { type: "oauth", access: "file-access" } }),
    );

    await expect(
      readAuthFile({ integrationIds: ["github-copilot", "openai"] }),
    ).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access" },
      openai: { access: "openai-access" },
    });
  });
});

describe("reader requests name their integration ids", () => {
  async function addRow(
    databasePath: string,
    row: { id: string; integrationId: string; active: number; updated: number; value: unknown },
  ): Promise<void> {
    const database = new DatabaseSync(databasePath);
    database
      .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, ?, 1, ?)")
      .run(row.id, row.integrationId, JSON.stringify(row.value), row.active, row.updated);
    database.close();
  }

  it("returns only rows of the requested ids, in database order", async () => {
    const { databasePath } = await createCredentialDatabase();
    vi.stubEnv("OPENCODE_DB", databasePath);

    expect((await readCredentialRows(["openai"])).map((row) => row.id)).toEqual(["openai"]);
    // Database order (most recently updated first), not request order.
    expect((await readCredentialRows(["github-copilot", "openai"])).map((row) => row.id)).toEqual([
      "openai",
      "copilot",
    ]);
    await expect(readCredentialRows([])).resolves.toEqual([]);
    await expect(readAuthFile({ integrationIds: ["xai"] })).resolves.toBeNull();
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toEqual({
      openai: { type: "oauth", access: "openai-access", refresh: "openai-refresh", expires: 20 },
    });
  });

  it("keeps only the requested connection methods", async () => {
    const { databasePath } = await createCredentialDatabase();
    await addRow(databasePath, {
      id: "console",
      integrationId: "opencode",
      active: 1,
      updated: 5,
      value: { type: "oauth", access: "console-access", refresh: "console-refresh", expires: 1 },
    });
    await addRow(databasePath, {
      id: "workspace-key",
      integrationId: "opencode",
      active: 0,
      updated: 4,
      value: { type: "key", key: "workspace-key" },
    });
    vi.stubEnv("OPENCODE_DB", databasePath);

    const ids = ["opencode", "openai", "deepseek"];
    expect((await readCredentialRows(ids, { methods: ["key"] })).map((row) => row.id)).toEqual([
      "workspace-key",
      "deepseek",
    ]);
    expect((await readCredentialRows(ids, { methods: ["oauth"] })).map((row) => row.id)).toEqual([
      "console",
      "openai",
    ]);
    expect(
      (await readCredentialRows(ids, { methods: ["key", "oauth"] })).map((row) => row.id),
    ).toEqual(["console", "workspace-key", "deepseek", "openai"]);
  });

  it("keeps the first (active) row per id when firstOnly is set", async () => {
    const { databasePath } = await createCredentialDatabase();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE credential SET active = 1 WHERE id = 'openai'").run();
    database.close();
    await addRow(databasePath, {
      id: "openai-newer-inactive",
      integrationId: "openai",
      active: 0,
      updated: 9,
      value: { type: "oauth", access: "inactive-access" },
    });
    vi.stubEnv("OPENCODE_DB", databasePath);

    expect(
      (await readCredentialRows(["openai", "deepseek"], { firstOnly: true })).map((row) => row.id),
    ).toEqual(["openai", "deepseek"]);
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toMatchObject({
      openai: { access: "openai-access" },
    });
  });

  it("applies firstOnly before the method filter, so a mismatched active row yields nothing", async () => {
    const { databasePath } = await createCredentialDatabase();
    await addRow(databasePath, {
      id: "openai-key",
      integrationId: "openai",
      active: 1,
      updated: 9,
      value: { type: "key", key: "openai-key" },
    });
    vi.stubEnv("OPENCODE_DB", databasePath);

    await expect(
      readCredentialRows(["openai"], { firstOnly: true, methods: ["oauth"] }),
    ).resolves.toEqual([]);
  });

  it("caches auth maps per sorted id list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { databasePath } = await createCredentialDatabase();
    vi.stubEnv("OPENCODE_DB", databasePath);

    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai", "deepseek"] }),
    ).resolves.toMatchObject({ openai: { access: "openai-access" } });
    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE credential SET value = ? WHERE id = 'openai'")
      .run(JSON.stringify({ type: "oauth", access: "rotated-access" }));
    database.close();

    // Same ids in another order hit the same cache entry.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek", "openai"] }),
    ).resolves.toMatchObject({ openai: { access: "openai-access" } });
    // A different id list has its own entry and reads fresh.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] }),
    ).resolves.toEqual({ openai: { type: "oauth", access: "rotated-access" } });
    // Once time moves on, maxAgeMs 0 re-reads the first entry too.
    vi.setSystemTime(1_000_001);
    await expect(
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["openai", "deepseek"] }),
    ).resolves.toMatchObject({ openai: { access: "rotated-access" } });
  });

  it("shares one in-flight read per id list", async () => {
    const { databasePath } = await createCredentialDatabase();
    vi.stubEnv("OPENCODE_DB", databasePath);

    const [first, second] = await Promise.all([
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["deepseek"] }),
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["deepseek"] }),
    ]);
    expect(first).toEqual({ deepseek: { type: "api", key: "deepseek-key" } });
    expect(second).toBe(first);
  });

  it("adds resolveError to the auth entry of a failed row only", () => {
    const row = {
      id: "openai",
      integrationId: "openai",
      label: "default",
      active: true,
      value: { type: "oauth", access: "token" },
    };
    expect(credentialRowAuthEntry(row)).toBe(row.value);
    expect(
      credentialRowAuthEntry({
        ...row,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      }),
    ).toEqual({ type: "oauth", resolveError: "refresh_failed: HTTP 400" });
  });
});

describe("selectConnectionCredentialRows", () => {
  const row = (id: string, integrationId: string, key: string) => ({
    id,
    integrationId,
    label: "default",
    active: false,
    value: { type: "key", key },
  });

  it("prefers native rows over alias rows holding the same credential", () => {
    const rows = [
      row("alias", "opencode", "workspace-key"),
      row("native", "opencode-go", "workspace-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "native",
    ]);
  });

  it("falls back to alias rows when no native row exists", () => {
    const rows = [row("alias", "opencode", "workspace-key")];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "alias",
    ]);
  });

  it("collapses alias rows into native rows with the same credential value", () => {
    const rows = [
      row("go-1", "opencode-go", "workspace-key"),
      row("zen", "opencode", "workspace-key"),
      row("go-2", "opencode-go", "other-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "go-1",
      "go-2",
    ]);
  });

  it("collapses exact duplicates within the primary integration", () => {
    const rows = [
      row("first", "opencode-go", "workspace-key"),
      row("second", "opencode-go", "workspace-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "first",
    ]);
  });

  it("treats property order in stored credential values as insignificant", () => {
    const rows = [
      row("first", "opencode-go", "workspace-key"),
      {
        ...row("second", "opencode-go", "workspace-key"),
        value: { key: "workspace-key", type: "key" },
      },
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "first",
    ]);
  });

  it("keeps distinct credentials as separate connections", () => {
    const rows = [
      row("personal", "opencode-go", "personal-key"),
      row("work", "opencode-go", "work-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "personal",
      "work",
    ]);
  });
});

describe("Google companion credentials written by OpenCode 2", () => {
  it("parses the opencode-gemini-auth 2.x and AGY alpha OAuth rows", async () => {
    const { databasePath } = await createCredentialDatabase();
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(
      "INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 5, 5)",
    );
    // opencode-gemini-auth 2.0.1: `gemini-cli` method on OpenCode 2's `google` integration.
    insert.run(
      "gemini",
      "google",
      "user@example.com",
      JSON.stringify({
        type: "oauth",
        methodID: "gemini-cli",
        refresh: "gemini-refresh|gemini-project|",
        access: "gemini-access",
        expires: 50,
        metadata: { email: "user@example.com" },
      }),
    );
    // @anthonyhaussman/opencode-agy-auth 1.2.11-alpha.0: `oauth` method on `google-agy`.
    insert.run(
      "agy",
      "google-agy",
      "OAuth",
      JSON.stringify({
        type: "oauth",
        methodID: "oauth",
        refresh: "agy-refresh|agy-project|agy-managed-project",
        access: "agy-access",
        expires: 60,
      }),
    );
    database.close();
    vi.stubEnv("OPENCODE_DB", databasePath);
    const auth = await readAuthFile({ integrationIds: ["google", "google-agy"] });

    expect(resolveGeminiCliAccounts(auth)).toEqual([
      {
        sourceKey: "google",
        refreshToken: "gemini-refresh",
        projectId: "gemini-project",
        email: "user@example.com",
        accessToken: "gemini-access",
        expiresAt: 50,
      },
    ]);
    expect(resolveAgyAccounts(auth)).toEqual([
      {
        sourceKey: "google-agy",
        refreshToken: "agy-refresh",
        projectId: "agy-managed-project",
        accessToken: "agy-access",
        expiresAt: 60,
      },
    ]);
  });
});
