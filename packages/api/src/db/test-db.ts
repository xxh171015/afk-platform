import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { MIGRATIONS_FOLDER, migrate } from "./migrate.ts";

export interface TestDatabase {
  pool: pg.Pool;
  drop(): Promise<void>;
}

const ADMIN_SHUTDOWN = "57P01"; // what DROP DATABASE ... WITH (FORCE) sends to a connection still open
const DB_GONE = "3D000"; // queries still in flight after the database was dropped

// A forced drop or a client still talking to a dropped database is expected; anything else must surface.
function ignoreForcedDrop(error: Error & { code?: string }): void {
  if (error.code !== ADMIN_SHUTDOWN && error.code !== DB_GONE) throw error;
}

function adminPool(): pg.Pool {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is not set");
  const admin = new pg.Pool({ connectionString: adminUrl });
  admin.on("error", ignoreForcedDrop);
  return admin;
}

function urlOf(name: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function open(
  admin: pg.Pool,
  create: (name: string) => string,
): Promise<TestDatabase> {
  const name = `afk_test_${randomBytes(6).toString("hex")}`;
  try {
    await admin.query(create(name));
  } catch (error) {
    await admin.end();
    throw error;
  }
  const pool = new pg.Pool({ connectionString: urlOf(name) });
  pool.on("error", ignoreForcedDrop);
  return {
    pool,
    async drop() {
      // End the pool first so returned clients leave cleanly; FORCE still cuts a
      // query that was left checked out (test-db.test.ts), so afterEach cannot hang.
      const ending = pool.end();
      try {
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await Promise.allSettled([ending, admin.end()]);
      }
    },
  };
}

// A throwaway database on the server named by DATABASE_URL, so tests never see each other's tables. It is empty:
// for tests of the migrations themselves.
export async function createTestDatabase(): Promise<TestDatabase> {
  return open(adminPool(), (name) => `CREATE DATABASE ${name}`);
}

// The same with every migration in `migrationsFolder` applied. The migrations run once per server into a template
// database, and each test database is a copy of it: copying takes a tenth of the time of migrating.
export async function createMigratedTestDatabase(
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<TestDatabase> {
  const admin = adminPool();
  let template: string;
  try {
    template = await ensureTemplate(admin, migrationsFolder);
  } catch (error) {
    await admin.end();
    throw error;
  }
  return open(
    admin,
    (name) => `CREATE DATABASE ${name} TEMPLATE ${template} STRATEGY FILE_COPY`,
  );
}

// Every vitest worker is a process of its own; this key serializes the builds across them.
const TEMPLATE_LOCK = 7_461_221_903;

// Named after the folder and its contents: a changed migration is a new template, and the old one of the same folder
// is dropped when it is built.
function templateName(migrationsFolder: string): {
  prefix: string;
  name: string;
} {
  const folderHash = createHash("sha256")
    .update(migrationsFolder)
    .digest("hex")
    .slice(0, 8);
  const content = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else content.update(entry.name).update(readFileSync(path));
    }
  };
  walk(migrationsFolder);
  const prefix = `afk_tmpl_${folderHash}_`;
  return { prefix, name: `${prefix}${content.digest("hex").slice(0, 12)}` };
}

async function ensureTemplate(
  admin: pg.Pool,
  migrationsFolder: string,
): Promise<string> {
  const { prefix, name } = templateName(migrationsFolder);
  const exists = async () =>
    (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]))
      .rowCount === 1;
  if (await exists()) return name;

  const lock = await admin.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    if (await exists()) return name;
    // Built under another name and renamed when complete, so no one copies a half-migrated template.
    const building = `${name}_build`;
    await admin.query(`DROP DATABASE IF EXISTS ${building}`);
    await admin.query(`CREATE DATABASE ${building}`);
    const pool = new pg.Pool({ connectionString: urlOf(building) });
    try {
      await migrate(pool, migrationsFolder);
    } finally {
      await pool.end();
    }
    // A database someone is connected to cannot be copied: nobody may connect to the template.
    await admin.query(
      `ALTER DATABASE ${building} WITH ALLOW_CONNECTIONS false`,
    );
    await admin.query(`ALTER DATABASE ${building} RENAME TO ${name}`);
    await dropTemplates(admin, prefix, name);
    return name;
  } finally {
    await lock
      .query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK])
      .catch(() => undefined);
    lock.release();
  }
}

async function dropTemplates(
  admin: pg.Pool,
  prefix: string,
  keep?: string,
): Promise<void> {
  const { rows } = await admin.query<{ name: string }>(
    "SELECT datname AS name FROM pg_database WHERE starts_with(datname, $1)",
    [prefix],
  );
  for (const { name } of rows) {
    if (name !== keep) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }
}

// For a test that built templates from a folder of its own: drops them, so they do not pile up on the server.
export async function dropTestTemplates(
  migrationsFolder: string,
): Promise<void> {
  const admin = adminPool();
  try {
    await dropTemplates(admin, templateName(migrationsFolder).prefix);
  } finally {
    await admin.end();
  }
}
