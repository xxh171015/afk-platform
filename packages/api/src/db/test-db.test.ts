import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./test-db.ts";

describe("a throwaway test database", () => {
  it("drops even while a query is still running", {
    timeout: 3_000,
  }, async () => {
    const db = await createTestDatabase();
    const query = db.pool.query("SELECT pg_sleep(60)");
    await db.drop();
    await expect(query).rejects.toThrow();
  });
});
