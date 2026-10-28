import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertMigrated, MIGRATIONS_FOLDER, migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

const ENTITY_TABLES = [
  "edges",
  "findings",
  "gate_results",
  "jobs",
  "projects",
  "repos",
  "runs",
  "specs",
  "tickets",
];

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(() => db.drop());

async function tables(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("migrate", () => {
  it("creates the nine entity tables on an empty database", async () => {
    await migrate(db.pool);
    expect(await tables()).toEqual(ENTITY_TABLES);
  });

  it("can run again without error and without changing anything", async () => {
    await migrate(db.pool);
    await migrate(db.pool);
    expect(await tables()).toEqual(ENTITY_TABLES);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await migrate(db.pool);
    const again = await db.pool.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(again.rows[0].n).toBe(rows[0].n);
  });
});

describe("assertMigrated", () => {
  it("refuses to start on a database that was never migrated, and says which command to run", async () => {
    await expect(assertMigrated(db.pool)).rejects.toThrow(/pnpm db:migrate/);
  });

  it("passes once every migration has run", async () => {
    await migrate(db.pool);
    await expect(assertMigrated(db.pool)).resolves.toBeUndefined();
  });

  it("refuses again when a newer migration file has not run yet", async () => {
    await migrate(db.pool);
    const folder = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      writeFileSync(
        join(folder, "9999_extra.sql"),
        "CREATE TABLE extra_table (id integer);\n",
      );
      const journalPath = join(folder, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries.push({
        idx: journal.entries.length,
        version: "7",
        when: journal.entries.at(-1).when + 1000,
        tag: "9999_extra",
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      await expect(assertMigrated(db.pool, folder)).rejects.toThrow(
        /9999_extra/,
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
