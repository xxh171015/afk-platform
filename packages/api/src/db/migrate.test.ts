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
  "acceptance_packs",
  "edges",
  "finalizations",
  "findings",
  "gate_results",
  "instance",
  "jobs",
  "projects",
  "pull_requests",
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
  it("creates the entity tables on an empty database", async () => {
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

describe("the id of the database", () => {
  const idOf = async (pool: TestDatabase["pool"]) =>
    (await pool.query<{ id: string }>("SELECT id FROM instance")).rows;

  it("is made once, six hex digits, by the migration that creates it, and stays through later runs", async () => {
    await migrate(db.pool);
    const [first, ...others] = await idOf(db.pool);
    expect(others).toEqual([]);
    expect(first?.id).toMatch(/^[0-9a-f]{6}$/);
    await migrate(db.pool);
    expect(await idOf(db.pool)).toEqual([first]);
  });

  it("is not the same in two databases, so their branch names do not meet", async () => {
    const other = await createTestDatabase();
    try {
      await migrate(db.pool);
      await migrate(other.pool);
      expect(await idOf(db.pool)).not.toEqual(await idOf(other.pool));
    } finally {
      await other.drop();
    }
  });

  it("is added to a database that already has specs, and leaves them without one, so their branches keep their names", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      // the migrations as they were before this one
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { tag: string }) => e.tag !== "0014_branch_namespace",
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
      await db.pool.query(
        "INSERT INTO specs (project_id, type, slug, title) VALUES (1, 'feature', 'export', 'Export')",
      );

      await migrate(db.pool);
      const specs = await db.pool.query("SELECT branch_namespace FROM specs");
      expect(specs.rows).toEqual([{ branch_namespace: null }]);
      expect(await idOf(db.pool)).toHaveLength(1);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("cannot get a second row", async () => {
    await migrate(db.pool);
    await expect(
      db.pool.query(
        "INSERT INTO instance (singleton, id) VALUES (false, 'abcdef')",
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO instance (id) VALUES ('abcdef')"),
    ).rejects.toThrow();
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
