import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, type TestDatabase } from "./db/test-db.ts";
import { listen, type RunningApi, testApp } from "./test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

describe("a worker's cleanup report", () => {
  it("keeps how many sandbox-logs, salvage and snapshots it last deleted", async () => {
    const reply = await fetch(`${api.url}/worker/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "mac",
        cleaned: { sandboxLogs: 3, salvage: 1, snapshots: 2 },
      }),
    });
    expect(reply.status).toBe(200);
    const { rows } = await db.pool.query(
      `SELECT id, cleaned_sandbox_logs, cleaned_salvage, cleaned_snapshots
         FROM workers`,
    );
    expect(rows).toEqual([
      {
        id: "mac",
        cleaned_sandbox_logs: 3,
        cleaned_salvage: 1,
        cleaned_snapshots: 2,
      },
    ]);

    await fetch(`${api.url}/worker/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "mac",
        cleaned: { sandboxLogs: 0, salvage: 4, snapshots: 0 },
      }),
    });
    const again = await db.pool.query(
      "SELECT cleaned_sandbox_logs, cleaned_salvage, cleaned_snapshots FROM workers",
    );
    expect(again.rows[0]).toEqual({
      cleaned_sandbox_logs: 0,
      cleaned_salvage: 4,
      cleaned_snapshots: 0,
    });
  });
});
