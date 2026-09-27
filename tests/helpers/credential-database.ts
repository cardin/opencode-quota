import { DatabaseSync } from "node:sqlite";

/** One row of OpenCode 2's `credential` table. */
export type CredentialDatabaseRow = {
  id: string;
  integrationId: string;
  /** Defaults to `default`, the label OpenCode gives an unnamed connection. */
  label?: string;
  active: 0 | 1 | null;
  /** `time_updated`; newer rows come first among rows with the same `active`. */
  updated: number;
  /** Stored as JSON in the `value` column. */
  value: unknown;
};

/**
 * Creates OpenCode 2's `credential` table in a new database file (use a temp dir) and
 * inserts `rows`.
 */
export function writeCredentialDatabase(
  databasePath: string,
  rows: readonly CredentialDatabaseRow[],
): void {
  const database = new DatabaseSync(databasePath);
  try {
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
    const insert = database.prepare(
      "INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.integrationId,
        row.label ?? "default",
        JSON.stringify(row.value),
        row.active,
        row.updated,
      );
    }
  } finally {
    database.close();
  }
}
