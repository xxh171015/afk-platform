import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { enqueueJob } from "../jobs/queue.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  teardownTestRuntime,
  testApp,
} from "./fake-worker.ts";

// Ticket #287: afterEach must stop a heartbeating worker, drain HTTP, end the pool,
// then drop the database — a leftover heartbeat must not see 57P01.

let db: TestDatabase | undefined;
let api: RunningApi | undefined;

beforeEach(async () => {
  db = undefined;
  api = undefined;
});

afterEach(async () => {
  if (api) await api.close().catch(() => undefined);
  if (db) await db.drop().catch(() => undefined);
});

async function boot() {
  const nextDb = await createMigratedTestDatabase();
  const nextApi = await listen(testApp({ pool: nextDb.pool }));
  db = nextDb;
  api = nextApi;
  return { db: nextDb, api: nextApi };
}

async function claimedJob(url: string, pool: TestDatabase["pool"]) {
  const worker = new FakeWorker(url, "w1");
  await enqueueJob(pool, { type: "agent-run", idempotencyKey: "heartbeat" });
  const job = (await worker.claim()).body.job;
  if (job == null) throw new Error("claim handed out nothing");
  return { worker, job };
}

describe("afterEach while a worker is still heartbeating", () => {
  it("stops the worker loop before dropping the database", async () => {
    const runtime = await boot();
    const { worker, job } = await claimedJob(runtime.api.url, runtime.db.pool);
    const stop = new AbortController();
    let loopExited = false;
    const loop = (async () => {
      while (!stop.signal.aborted) {
        await worker.heartbeat(job.id, job.attempt);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      loopExited = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));

    let droppedWhileRunning = false;
    const drop = runtime.db.drop.bind(runtime.db);
    runtime.db.drop = async () => {
      if (!loopExited) droppedWhileRunning = true;
      await drop();
    };

    const failures: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      failures.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await teardownTestRuntime({
        stopWorker: async () => {
          stop.abort();
          await loop;
        },
        api: runtime.api,
        db: runtime.db,
      });
      db = undefined;
      api = undefined;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(loopExited).toBe(true);
    expect(droppedWhileRunning).toBe(false);
    expect(
      failures.filter(
        (reason) =>
          reason instanceof Error &&
          "code" in reason &&
          (reason as Error & { code?: string }).code === "57P01",
      ),
    ).toEqual([]);
  });
});

describe("afterEach of an API test that never started a worker", () => {
  it("can start a new database and HTTP server afterwards", async () => {
    const first = await boot();
    await teardownTestRuntime({ api: first.api, db: first.db });
    db = undefined;
    api = undefined;

    const second = await boot();
    const reply = await fetch(`${second.api.url}/worker/jobs/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "w1", capabilities: [] }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ job: null });
    await teardownTestRuntime({ api: second.api, db: second.db });
    db = undefined;
    api = undefined;
  });
});
