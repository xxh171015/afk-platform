import { randomBytes } from "node:crypto";
import pg from "pg";

export interface TestDatabase {
  pool: pg.Pool;
  drop(): Promise<void>;
}

const ADMIN_SHUTDOWN = "57P01"; // what DROP DATABASE ... WITH (FORCE) sends to a connection still open

// An idle connection killed by the forced drop is expected; anything else must surface.
function ignoreForcedDrop(error: Error & { code?: string }): void {
  if (error.code !== ADMIN_SHUTDOWN) throw error;
}

// A throwaway database on the server named by DATABASE_URL, so tests never see each other's tables.
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is not set");
  const name = `afk_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  admin.on("error", ignoreForcedDrop);
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  pool.on("error", ignoreForcedDrop);
  return {
    pool,
    async drop() {
      try {
        await pool.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
