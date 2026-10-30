import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export async function migrate(
  pool: pg.Pool,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  await runMigrations(drizzle(pool), { migrationsFolder });
}

interface JournalEntry {
  tag: string;
  when: number;
}

// drizzle applies every journal entry newer than the latest created_at it has recorded.
async function lastApplied(pool: pg.Pool): Promise<number> {
  const table = await pool.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS name",
  );
  if (!table.rows[0].name) return -1;
  const { rows } = await pool.query(
    "SELECT max(created_at)::bigint AS last FROM drizzle.__drizzle_migrations",
  );
  return rows[0].last === null ? -1 : Number(rows[0].last);
}

// Startup guard: the API never migrates on its own, so it refuses to run on an out-of-date database.
export async function assertMigrated(
  pool: pg.Pool,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as {
    entries: JournalEntry[];
  };
  const applied = await lastApplied(pool);
  const pending = journal.entries
    .filter((entry) => entry.when > applied)
    .map((entry) => entry.tag);
  if (pending.length > 0) {
    throw new Error(
      `${pending.length} migration(s) not applied (${pending.join(", ")}). Run "pnpm db:migrate" first.`,
    );
  }
}
