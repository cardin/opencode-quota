import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearReadAuthFileCacheForTests,
  getCredentialDatabasePaths,
  readAuthFile,
} from "../src/lib/opencode-auth.js";
import { getOpenCodeDbPath } from "../src/lib/opencode-db-path.js";
import { getOpenCodeDbStats } from "../src/lib/opencode-storage.js";

const temporaryDirectories: string[] = [];
const originalPlatform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  clearReadAuthFileCacheForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-db-path-"));
  temporaryDirectories.push(root);
  return root;
}

/** Writes an OpenCode 2 database with one API-key credential and `sessions` sessions. */
async function createOpenCodeDatabase(path: string, key: string, sessions: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      active INTEGER,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE "session_v2" (id TEXT PRIMARY KEY);
    CREATE TABLE "session_message" (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL);
  `);
  database
    .prepare("INSERT INTO credential VALUES ('deepseek', 'deepseek', 'default', ?, 1, 1)")
    .run(JSON.stringify({ type: "key", key }));
  for (let i = 0; i < sessions; i++) {
    database.prepare(`INSERT INTO "session_v2" VALUES (?)`).run(`ses_${i}`);
  }
  database.close();
}

describe("OpenCode database path", () => {
  it("never falls back to the home database on macOS when XDG_DATA_HOME is set", async () => {
    const root = await createRoot();
    const home = join(root, "home");
    const sandboxData = join(root, "sandbox-data");
    await createOpenCodeDatabase(
      join(home, ".local", "share", "opencode", "opencode.db"),
      "home-key",
      3,
    );
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_DATA_HOME", sandboxData);
    vi.stubEnv("OPENCODE_DB", undefined);

    const expected = join(sandboxData, "opencode", "opencode.db");
    expect(getOpenCodeDbPath()).toBe(expected);
    expect(getCredentialDatabasePaths()).toEqual([expected]);
    await expect(readAuthFile()).resolves.toBeNull();
    await expect(getOpenCodeDbStats()).resolves.toMatchObject({
      dbPath: expected,
      sessionCount: 0,
    });
  });

  it("uses an absolute OPENCODE_DB for credentials and sessions", async () => {
    const root = await createRoot();
    const custom = join(root, "elsewhere", "custom.db");
    await createOpenCodeDatabase(join(root, "data", "opencode", "opencode.db"), "default-key", 1);
    await createOpenCodeDatabase(custom, "custom-key", 2);
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("OPENCODE_DB", custom);

    expect(getOpenCodeDbPath()).toBe(custom);
    await expect(readAuthFile()).resolves.toMatchObject({ deepseek: { key: "custom-key" } });
    await expect(getOpenCodeDbStats()).resolves.toMatchObject({ dbPath: custom, sessionCount: 2 });
  });

  it("resolves a relative OPENCODE_DB against the data dir for credentials and sessions", async () => {
    const root = await createRoot();
    const custom = join(root, "data", "opencode", "profiles", "work.db");
    await createOpenCodeDatabase(join(root, "data", "opencode", "opencode.db"), "default-key", 1);
    await createOpenCodeDatabase(custom, "work-key", 4);
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("OPENCODE_DB", join("profiles", "work.db"));

    expect(getOpenCodeDbPath()).toBe(custom);
    await expect(readAuthFile()).resolves.toMatchObject({ deepseek: { key: "work-key" } });
    await expect(getOpenCodeDbStats()).resolves.toMatchObject({ dbPath: custom, sessionCount: 4 });
  });

  it("reads no database file when OPENCODE_DB is :memory:", async () => {
    const root = await createRoot();
    await createOpenCodeDatabase(join(root, "data", "opencode", "opencode.db"), "default-key", 1);
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("OPENCODE_DB", ":memory:");

    expect(getOpenCodeDbPath()).toBe(":memory:");
    expect(getCredentialDatabasePaths()).toEqual([]);
    await expect(readAuthFile()).resolves.toBeNull();
    await expect(getOpenCodeDbStats()).resolves.toMatchObject({
      dbPath: ":memory:",
      sessionCount: 0,
    });
  });
});
