import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { enqueueJob } from "../jobs/queue.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
} from "../test/fake-worker.ts";

// The read-only lease check a worker uses to tell a zombie slot lock from a live one.

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(createApp({ pool: db.pool, clock: clock.now }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

const held = async (id: number, attempt: number) =>
  (
    (await fetch(`${api.url}/worker/jobs/${id}/lease?attempt=${attempt}`).then(
      (r) => r.json(),
    )) as { held: boolean }
  ).held;

describe("the lease check", () => {
  it("is true while the job runs under a live lease at that attempt, and false otherwise", async () => {
    await enqueueJob(db.pool, { type: "t", idempotencyKey: "k" });
    expect(await held(1, 1)).toBe(false); // queued, nobody holds it
    const worker = new FakeWorker(api.url, "w1");
    await worker.claim();
    expect(await held(1, 1)).toBe(true);
    expect(await held(1, 2)).toBe(false); // another attempt
    clock.advanceSeconds(121);
    expect(await held(1, 1)).toBe(false); // the lease ran out
  });

  it("does not renew the lease", async () => {
    await enqueueJob(db.pool, { type: "t", idempotencyKey: "k" });
    await new FakeWorker(api.url, "w1").claim();
    const before = await db.pool.query("SELECT lease_expires_at FROM jobs");
    clock.advanceSeconds(60);
    await held(1, 1);
    const after = await db.pool.query("SELECT lease_expires_at FROM jobs");
    expect(after.rows).toEqual(before.rows);
  });

  it("is false for a job that does not exist", async () => {
    expect(await held(99, 1)).toBe(false);
  });
});
