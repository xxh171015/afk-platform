import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./db.ts";

describe("createPool", () => {
  const pool = createPool();
  afterAll(() => pool.end());

  it("connects to the real Postgres named by DATABASE_URL", async () => {
    const { rows } = await pool.query("SELECT 1 AS one");
    expect(rows).toEqual([{ one: 1 }]);
  });

  it("reads back a write made inside a transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE smoke (n int)");
      await client.query("INSERT INTO smoke VALUES (42)");
      const { rows } = await client.query("SELECT n FROM smoke");
      expect(rows).toEqual([{ n: 42 }]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("refuses to build a pool when DATABASE_URL is missing", () => {
    expect(() => createPool({})).toThrow(/DATABASE_URL/);
  });
});
