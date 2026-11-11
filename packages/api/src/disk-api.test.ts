import { GIB } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "./db/test-db.ts";
import { enqueueJob } from "./jobs/queue.ts";
import type { Notice } from "./notify/notices.ts";
import { listen, type RunningApi, testApp } from "./test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;
let notices: Notice[];
let freeBytes: number;
let workerFree: number | undefined;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  notices = [];
  freeBytes = 20 * GIB;
  workerFree = undefined;
  api = await listen(
    testApp({
      pool: db.pool,
      statDisk: async () => ({ freeBytes, dirBytes: 4096 }),
      notifications: {
        async notify(notice) {
          notices.push(notice);
        },
      },
    }),
  );
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

async function workbench() {
  const reply = await fetch(`${api.url}/workbench`);
  return { status: reply.status, body: await reply.json() };
}

async function waitForNotices(count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (notices.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(notices).toHaveLength(count);
}

async function reportWorker() {
  return fetch(`${api.url}/worker/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: "mac",
      cleaned: { sandboxLogs: 3, salvage: 1, snapshots: 2 },
      ...(workerFree === undefined ? {} : { freeBytes: workerFree }),
    }),
  });
}

describe("disk remaining-space alerts", () => {
  it("notifies once per downward crossing, and shows the status area", async () => {
    expect((await workbench()).body.status).toMatchObject({
      logDirBytes: 4096,
      apiFreeBytes: 20 * GIB,
      diskLevel: "ok",
      warnGib: 10,
      stopGib: 5,
      lastCleanup: { at: null, runs: 0, orphans: 0 },
      workers: [],
    });
    expect(notices).toEqual([]);

    freeBytes = 9 * GIB;
    expect((await workbench()).body.status.diskLevel).toBe("warn");
    await waitForNotices(1);
    expect(notices.map((n) => n.title)).toEqual(["磁盘空间不足"]);
    expect(notices[0].body).toContain("剩余不足 10 GiB");

    expect((await workbench()).body.status.diskLevel).toBe("warn");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notices).toHaveLength(1);

    freeBytes = 4 * GIB;
    expect((await workbench()).body.status.diskLevel).toBe("stop");
    await waitForNotices(2);
    expect(notices.map((n) => n.title)).toEqual([
      "磁盘空间不足",
      "磁盘空间严重不足",
    ]);
    expect(notices[1].body).toContain("worker 已停止领取新作业");

    freeBytes = 20 * GIB;
    expect((await workbench()).body.status.diskLevel).toBe("ok");
    expect(notices).toHaveLength(2);

    freeBytes = 4 * GIB;
    expect((await workbench()).body.status.diskLevel).toBe("stop");
    await waitForNotices(4);
    expect(notices.map((n) => n.title)).toEqual([
      "磁盘空间不足",
      "磁盘空间严重不足",
      "磁盘空间不足",
      "磁盘空间严重不足",
    ]);
  });

  it("uses the tighter of the API disk and the workers' last report", async () => {
    workerFree = 4 * GIB;
    expect((await reportWorker()).status).toBe(200);
    await waitForNotices(2);
    expect(notices.map((n) => n.title)).toEqual([
      "磁盘空间不足",
      "磁盘空间严重不足",
    ]);
    const { body } = await workbench();
    expect(body.status.diskLevel).toBe("stop");
    expect(body.status.workers).toEqual([
      {
        id: "mac",
        reportedAt: expect.any(String),
        freeBytes: 4 * GIB,
        cleaned: { sandboxLogs: 3, salvage: 1, snapshots: 2 },
      },
    ]);
    expect(notices).toHaveLength(2);
  });

  it("leases a job when remaining space is injected above 5 GiB", async () => {
    await enqueueJob(db.pool, {
      type: "agent-run",
      idempotencyKey: "disk-plenty",
    });
    const reply = await fetch(`${api.url}/worker/jobs/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "mac", capabilities: [] }),
    });
    const body = (await reply.json()) as { job: { type: string } | null };
    expect(body.job).toMatchObject({ type: "agent-run" });
  });

  it("does not lease a job while remaining space is below 5 GiB, then does once it recovers", async () => {
    await enqueueJob(db.pool, {
      type: "agent-run",
      idempotencyKey: "disk-1",
    });
    const claim = async () => {
      const reply = await fetch(`${api.url}/worker/jobs/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "mac", capabilities: [] }),
      });
      return reply.json() as Promise<{ job: { type: string } | null }>;
    };

    workerFree = 4 * GIB;
    expect((await reportWorker()).status).toBe(200);
    expect((await claim()).job).toBeNull();

    workerFree = 20 * GIB;
    expect((await reportWorker()).status).toBe(200);
    expect((await claim()).job).toMatchObject({ type: "agent-run" });
  });
});
