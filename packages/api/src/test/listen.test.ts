import net from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { enqueueJob } from "../jobs/queue.ts";
import { FakeWorker, listen, testApp } from "./fake-worker.ts";

// afterEach of HTTP tests calls close() then drop(). A leftover socket must not hold that up
// (vitest hookTimeout is 20s; under load a stuck close made the next test fail too).

describe("the test API server", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  }, 30_000);

  afterAll(async () => {
    await db.drop();
  });

  it("closes even if a client is still connected", {
    timeout: 3_000,
  }, async () => {
    const api = await listen(testApp({ pool: db.pool }));
    const port = Number(new URL(api.url).port);
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await api.close();
    socket.destroy();
  });
});

describe("closing while a heartbeat is in flight", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  }, 30_000);

  afterEach(async () => {
    await db.drop();
  });

  it("waits for the request to finish querying before close() returns", async () => {
    const app = testApp({ pool: db.pool });
    let releaseHeartbeat = () => {};
    const heartbeatHeld = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let heartbeatEntered = false;
    const origFetch = app.fetch.bind(app);
    app.fetch = (async (request: Request) => {
      if (
        new URL(request.url, "http://127.0.0.1").pathname.endsWith("/heartbeat")
      ) {
        heartbeatEntered = true;
        await heartbeatHeld;
      }
      return origFetch(request);
    }) as typeof app.fetch;
    const api = await listen(app);
    const worker = new FakeWorker(api.url, "w1");
    await enqueueJob(db.pool, { type: "agent-run", idempotencyKey: "a" });
    const job = (await worker.claim()).body.job;
    if (job == null) throw new Error("claim handed out nothing");

    const beat = worker.heartbeat(job.id, job.attempt);
    const waitUntil = Date.now() + 2_000;
    while (!heartbeatEntered && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(heartbeatEntered).toBe(true);

    let closed = false;
    const closing = api.close().then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(closed).toBe(false);
      releaseHeartbeat();
      await closing;
      expect((await beat).status).toBe(200);
    } finally {
      releaseHeartbeat();
      await api.close();
    }
  });
});
