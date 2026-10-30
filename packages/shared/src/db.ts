import pg from "pg";

export function createPool(
  env: Record<string, string | undefined> = process.env,
): pg.Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new pg.Pool({ connectionString });
  // A connection the database closes (it restarted, or an administrator ended it) is reported on the pool as an
  // 'error' event; with no listener Node ends the process. The pool drops the connection and makes a new one for
  // the next query, so the process only needs to say so.
  pool.on("error", (error) => {
    console.error(`database connection lost: ${error.message}`);
  });
  return pool;
}
