import pg from "pg";

export function createPool(
  env: Record<string, string | undefined> = process.env,
): pg.Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString });
}
