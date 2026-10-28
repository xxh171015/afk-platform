import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
} from "../test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(createApp({ pool: db.pool, clock: clock.now }));
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
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

async function runningSpec(tickets: Record<string, unknown>[]) {
  const created = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "s",
    title: "Spec",
  });
  await call("POST", `/specs/${spec.body.id}/tickets/import`, { tickets });
  await call("POST", `/specs/${spec.body.id}/confirm`);
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;
const state = async (id = 1) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const keys = async () =>
  (await db.pool.query("SELECT idempotency_key, state FROM jobs ORDER BY id"))
    .rows;

async function failNext(error = "docker daemon not running") {
  const job = (await claim()) as Claimed;
  const reply = await worker.fail(job.id, job.attempt, error);
  expect(reply.status).toBe(200);
  return job;
}

describe("a job the worker could not carry out", () => {
  it("is queued again, under a new key, and the ticket stays where it was", async () => {
    await runningSpec([ticket("a")]);
    const failed = await failNext();
    expect(failed.payload.stage).toBe("implement");
    expect(await keys()).toEqual([
      { idempotency_key: "T-1:1:implement:1", state: "failed" },
      { idempotency_key: "T-1:1:implement:2", state: "queued" },
    ]);
    expect((await state()).state).toBe("running");
    const again = await claim();
    expect(again?.payload.stage).toBe("implement");
  });

  it("finishes the Run the job had started, so its log is not left looking as if it is still going", async () => {
    await runningSpec([ticket("a")]);
    await failNext("sandbox would not start");
    const runs = await db.pool.query(
      "SELECT result, output, finished_at FROM runs ORDER BY id",
    );
    expect(runs.rows[0].result).toBe("job-failed");
    expect(runs.rows[0].output).toEqual({ error: "sandbox would not start" });
    expect(runs.rows[0].finished_at).not.toBeNull();
    const log = await fetch(`${api.url}/runs/1/logs`).then((r) => r.json());
    expect(log.finished).toBe(true);
    // the second attempt gets a Run of its own
    await claim();
    expect(
      Number((await db.pool.query("SELECT count(*) FROM runs")).rows[0].count),
    ).toBe(2);
  });

  it("blocks the ticket with job-failed after the third failure, with the error in its brief", async () => {
    await runningSpec([ticket("a")]);
    await failNext("one");
    await failNext("two");
    expect((await state()).state).toBe("running");
    await failNext("three");
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    expect((await keys()).map((k) => k.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(await claim()).toBeNull(); // nothing is queued again

    const queue = await call("GET", "/blocked");
    expect(queue.body.tickets[0]).toMatchObject({
      displayId: "T-1",
      blockedReason: "job-failed",
      brief: {
        stage: "implement",
        result: "job-failed",
        output: { error: "three" },
      },
    });
  });

  it("can then be retried by a person like any other blocked ticket", async () => {
    await runningSpec([ticket("a")]);
    for (let i = 0; i < 3; i++) await failNext();
    const retried = await call("POST", "/tickets/1/retry", {
      mode: "continue",
    });
    expect(retried.status).toBe(200);
    const job = await claim();
    expect(job?.payload.stage).toBe("implement");
    expect((await keys()).at(-1)?.idempotency_key).toBe("T-1:1:implement:4");
  });

  it("counts the failures of each stage on its own", async () => {
    await runningSpec([ticket("a")]);
    const implement = (await claim()) as Claimed;
    await worker.complete(implement.id, implement.attempt, {
      stage: "implement",
      outcome: "done",
    });
    await failNext(); // gate, once
    await failNext(); // gate, twice
    const gate = (await claim()) as Claimed;
    expect(gate.payload.stage).toBe("gate");
    await worker.complete(gate.id, gate.attempt, {
      stage: "gate",
      outcome: "passed",
    });
    const review = (await claim()) as Claimed;
    await worker.fail(review.id, review.attempt, "once"); // review fails for the first time: it is queued again
    expect((await state()).state).toBe("running");
    expect((await claim())?.payload.stage).toBe("review");
  });

  it("blocks a ticket that was being merged", async () => {
    await runningSpec([ticket("a")]);
    for (const [stage, outcome] of [
      ["implement", "done"],
      ["gate", "passed"],
      ["review", "pass"],
    ] as const) {
      const job = (await claim()) as Claimed;
      await worker.complete(job.id, job.attempt, { stage, outcome });
    }
    expect((await state()).state).toBe("merging");
    for (let i = 0; i < 3; i++) await failNext("push failed");
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
  });

  it("frees the slot of a blocked ticket for the next one", async () => {
    const created = await call("POST", "/projects", {
      name: "p",
      limits: { projectConcurrency: 1, repoConcurrency: 1 },
    });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "u",
      role: "backend",
    });
    const spec = await call("POST", "/specs", {
      projectId: created.body.id,
      type: "feature",
      slug: "s",
      title: "S",
    });
    await call("POST", `/specs/${spec.body.id}/tickets/import`, {
      tickets: [ticket("a"), ticket("b")],
    });
    await call("POST", `/specs/${spec.body.id}/confirm`);
    expect((await state(2)).state).toBe("pending");
    for (let i = 0; i < 3; i++) await failNext();
    expect((await state(1)).state).toBe("blocked");
    expect((await state(2)).state).toBe("queued");
  });

  it("does nothing for a ticket that was cancelled meanwhile", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const job = (await claim()) as Claimed;
    await db.pool.query("UPDATE tickets SET state = 'cancelled' WHERE id = 1");
    await worker.fail(job.id, job.attempt, "late");
    expect((await keys()).map((k) => k.state)).toEqual(["failed"]); // no second job
  });

  it("a worker that is no longer the holder cannot fail a job", async () => {
    await runningSpec([ticket("a")]);
    const job = (await claim()) as Claimed;
    clock.advanceSeconds(121);
    const other = new FakeWorker(api.url, "w2", []);
    await other.claim(); // takes the job over at attempt 2
    expect((await worker.fail(job.id, job.attempt, "zombie")).status).toBe(409);
    expect((await keys()).map((k) => k.state)).toEqual(["running"]);
  });

  it("a job that is no stage of anything just fails", async () => {
    await db.pool.query(
      "INSERT INTO jobs (type, idempotency_key) VALUES ('open-pr', 'k')",
    );
    const job = (await claim()) as Claimed;
    expect((await worker.fail(job.id, job.attempt, "x")).status).toBe(200);
    expect((await keys())[0]?.state).toBe("failed");
  });
});

describe("a step of the overall review that could not be carried out", () => {
  async function toFinalReview() {
    await runningSpec([ticket("a")]);
    for (const [stage, outcome] of [
      ["implement", "done"],
      ["gate", "passed"],
      ["review", "pass"],
      ["merge", "merged"],
    ] as const) {
      const job = (await claim()) as Claimed;
      await worker.complete(job.id, job.attempt, {
        stage,
        outcome,
        ...(stage === "merge" ? { headSha: "h" } : {}),
      });
    }
  }

  it("is queued again, and blocks the finalization after three failures", async () => {
    await toFinalReview();
    await failNext();
    await failNext();
    expect(
      (await db.pool.query("SELECT state FROM finalizations")).rows[0].state,
    ).toBe("active");
    await failNext();
    expect(
      (await db.pool.query("SELECT state, blocked_reason FROM finalizations"))
        .rows[0],
    ).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    const queue = await call("GET", "/blocked");
    expect(queue.body.finalizations[0]).toMatchObject({
      blockedReason: "job-failed",
      brief: { result: "job-failed" },
    });
  });

  it("can be run again by a person", async () => {
    await toFinalReview();
    for (let i = 0; i < 3; i++) await failNext();
    expect((await call("POST", "/specs/1/final/retry")).status).toBe(200);
    expect((await claim())?.payload.stage).toBe("final-review");
  });
});
