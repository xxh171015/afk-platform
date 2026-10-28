import { randomBytes } from "node:crypto";
import pg from "pg";

export interface TestDatabase {
  pool: pg.Pool;
  drop(): Promise<void>;
}

// A throwaway database on the server named by DATABASE_URL, so tests never see each other's tables.
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is not set");
  const name = `afk_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // DROP ... WITH (FORCE) can reach a connection that is still closing; that is expected, not a failure.
  pool.on("error", () => {});
  admin.on("error", () => {});
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
