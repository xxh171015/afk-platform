import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

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
