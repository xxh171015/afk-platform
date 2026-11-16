import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { enqueueHostSync } from "../host/host-jobs.ts";
import { enqueueJob } from "../jobs/queue.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  clock = new FakeClock();
  api = await listen(testApp({ pool: db.pool, clock: clock.now }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const ticket = (key: string) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
});

async function runningSpec(keys: string[], projectName = "shop") {
  const created = await call("POST", "/projects", { name: projectName });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: `git@x:${projectName}-backend`,
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "s",
    title: "Spec",
  });
  await call(
    "POST",
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, { tickets: keys.map(ticket) }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  return {
    projectId: created.body.id as number,
    specId: spec.body.id as number,
  };
}

describe("GET /runtime", () => {
  it("returns the platform instance id and empty job lists", async () => {
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM instance"))
      .rows[0]?.id;
    const reply = await call("GET", "/runtime");
    expect(reply.status).toBe(200);
    expect(reply.body.instance).toEqual({ id });
    expect(reply.body.summary).toEqual({ running: 0, queued: 0 });
    expect(reply.body.jobs.running).toEqual([]);
    expect(reply.body.jobs.queued).toEqual([]);
    expect(reply.body.status.diskLevel).toBe("ok");
  });

  it("lists a claimed ticket job with worker, lease, run and display ids", async () => {
    await runningSpec(["a"]);
    const claimed = (await worker.claim()).body.job;
    expect(claimed).not.toBeNull();

    const reply = await call("GET", "/runtime");
    expect(reply.status).toBe(200);
    expect(reply.body.summary.running).toBe(1);
    expect(reply.body.jobs.running).toHaveLength(1);
    const job = reply.body.jobs.running[0];
    expect(job).toMatchObject({
      state: "running",
      leaseOwner: "w1",
      leaseExpiresAt: "2026-01-01T00:02:00.000Z",
      ticketDisplayId: "T-1",
      specDisplayId: "S-1",
      runId: expect.any(Number),
    });
    expect(job.label).toContain("implement");
    expect(job.label).toContain("T-1");
    expect(job.label).toContain("backend");

    await call("POST", "/worker/status", {
      workerId: "w1",
      cleaned: { sandboxLogs: 0, salvage: 0, snapshots: 0 },
      freeBytes: 20_000_000_000,
    });
    const again = await call("GET", "/runtime");
    expect(again.body.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "w1", heldJobId: job.id }),
      ]),
    );
  });

  it("counts queued jobs and labels host-sync with the project name", async () => {
    const { projectId } = await runningSpec(["a"]);
    await enqueueJob(db.pool, {
      type: "agent-run",
      idempotencyKey: "extra-queued",
      payload: { stage: "gate", ticketId: 1, specId: 1, repoId: 1 },
    });
    await inTransaction(db.pool, (client) =>
      enqueueHostSync(client, projectId),
    );

    const reply = await call("GET", "/runtime");
    expect(reply.status).toBe(200);
    expect(reply.body.summary.queued).toBeGreaterThanOrEqual(2);
    const sync = reply.body.jobs.queued.find(
      (job: { type: string }) => job.type === "host-sync",
    );
    expect(sync?.label).toContain("shop");
    expect(sync?.label).toContain("同步 PR");
  });
});
