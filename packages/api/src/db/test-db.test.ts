import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.ts";
import {
  createMigratedTestDatabase,
  createTestDatabase,
  dropTestTemplates,
  type TestDatabase,
} from "./test-db.ts";

describe("a throwaway test database", () => {
  let db: TestDatabase;

  // CREATE DATABASE contends with the rest of the suite; keep it off the 3s
  // budget so this case only times the forced drop (listen.test.ts does the same
  // for close).
  beforeEach(async () => {
    db = await createTestDatabase();
  }, 30_000);

  it("drops even while a query is still running", {
    timeout: 3_000,
  }, async () => {
    const query = db.pool.query("SELECT pg_sleep(60)");
    // Attach before DROP: the query rejects during drop(), and a late
    // expect().rejects leaves that as an unhandled 3D000.
    const rejected = expect(query).rejects.toThrow();
    await db.drop();
    await rejected;
  });
});

describe("a migrated throwaway test database", () => {
  const opened: TestDatabase[] = [];
  const open = async (folder?: string) => {
    const db = await createMigratedTestDatabase(folder);
    opened.push(db);
    return db;
  };

  const copies: string[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.drop()));
  });

  afterAll(async () => {
    for (const folder of copies) await dropTestTemplates(folder);
  });

  // A copy of the real migrations, so a case can add one without touching the repo.
  const copyMigrations = () => {
    const folder = join(mkdtempSync(join(tmpdir(), "afk-migrations-")), "m");
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    copies.push(folder);
    return folder;
  };

  const tables = async (db: TestDatabase) =>
    (
      await db.pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
      )
    ).rows.map((row) => row.name);

  const templates = async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      return (
        await admin.query<{ name: string }>(
          "SELECT datname AS name FROM pg_database WHERE datname LIKE 'afk_tmpl_%'",
        )
      ).rows.map((row) => row.name);
    } finally {
      await admin.end();
    }
  };

  it("has every table of the real migrations", async () => {
    const db = await open();
    expect(await tables(db)).toEqual(
      expect.arrayContaining(["specs", "tickets", "jobs", "runs", "events"]),
    );
  }, 30_000);

  it("gives each caller a database of its own", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    await a.pool.query("CREATE TABLE only_in_a (id int)");
    expect(await tables(b)).not.toContain("only_in_a");
  }, 30_000);

  it("sees a migration added after the template was built", async () => {
    const folder = copyMigrations();
    expect(await tables(await open(folder))).not.toContain("added_later");

    writeFileSync(
      join(folder, "9999_added_later.sql"),
      "CREATE TABLE added_later (id int);",
    );
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const last = journal.entries.at(-1);
    journal.entries.push({
      ...last,
      idx: (last?.idx ?? 0) + 1,
      when: (last?.when ?? 0) + 1,
      tag: "9999_added_later",
    } as (typeof journal.entries)[number]);
    writeFileSync(journalPath, JSON.stringify(journal));

    expect(await tables(await open(folder))).toContain("added_later");
  }, 60_000);

  it("builds a new template once when several callers want it at the same time", async () => {
    const folder = copyMigrations();
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      readFileSync(join(folder, "meta", "_journal.json"), "utf8").replace(
        /\s*$/,
        "\n",
      ), // a byte changed: a template no other case has built
    );
    const before = await templates();
    const dbs = await Promise.all([open(folder), open(folder), open(folder)]);
    for (const db of dbs) expect(await tables(db)).toContain("tickets");
    const built = (await templates()).filter((name) => !before.includes(name));
    expect(built).toHaveLength(1);
    expect(built[0]).not.toMatch(/_build$/);
  }, 60_000);
});
