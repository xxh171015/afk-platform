import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { id: number },
  };
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
  const created = await post("/projects", { name: "shop" });
  for (const name of ["backend", "frontend"]) {
    await post(`/projects/${created.body.id}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  }
  const spec = await post("/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
    body: "# spec body",
  });
  expect(
    (
      await post(
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, { tickets }),
      )
    ).status,
  ).toBe(200);
  expect((await post(`/specs/${spec.body.id}/confirm`)).status).toBe(200);
  return spec.body.id;
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: { stage: string; ticketId: number };
}

async function complete(
  job: Claimed,
  result: Record<string, unknown>,
  holder: FakeWorker = worker,
) {
  const reply = await holder.complete(job.id, job.attempt, {
    stage: job.payload.stage,
    ...result,
  });
  expect(reply.status).toBe(200);
  return reply;
}

async function stage(expected: string, result: Record<string, unknown>) {
  const claimed = (await worker.claim()).body.job as Claimed | null;
  expect(claimed?.payload.stage).toBe(expected);
  await complete(claimed as Claimed, result);
  return claimed as Claimed;
}

async function nextClaimedStage(): Promise<string | undefined> {
  const job = (await worker.claim()).body.job as Claimed | null;
  return job?.payload.stage;
}

async function claimBoth(): Promise<{ gate: Claimed; review: Claimed }> {
  const first = (await worker.claim()).body.job as Claimed;
  const second = (await worker.claim()).body.job as Claimed;
  const jobs = [first, second];
  const gate = jobs.find((job) => job.payload.stage === "gate");
  const review = jobs.find((job) => job.payload.stage === "review");
  expect(gate).toBeDefined();
  expect(review).toBeDefined();
  return { gate: gate as Claimed, review: review as Claimed };
}

const ticketRow = async (id = 1) =>
  (
    await db.pool.query(
      `SELECT state, blocked_reason, reviewed, parallel_review, parallel_review_sha, gate_passed_sha
       FROM tickets WHERE id = $1`,
      [id],
    )
  ).rows[0];

const openStages = async (id = 1) =>
  (
    await db.pool.query<{ stage: string; state: string }>(
      `SELECT payload->>'stage' AS stage, state FROM jobs
       WHERE (payload->>'ticketId')::int = $1 AND type <> 'host-sync'
         AND state IN ('queued', 'running')
       ORDER BY id`,
      [id],
    )
  ).rows;

const jobOf = async (stage: string, id = 1) =>
  (
    await db.pool.query<{
      state: string;
      error: string | null;
    }>(
      `SELECT state, error FROM jobs
       WHERE (payload->>'ticketId')::int = $1 AND payload->>'stage' = $2
       ORDER BY id DESC LIMIT 1`,
      [id, stage],
    )
  ).rows[0];

const runResults = async (stage: string, id = 1) =>
  (
    await db.pool.query<{ result: string | null }>(
      `SELECT result FROM runs WHERE ticket_id = $1 AND stage = $2 ORDER BY id`,
      [id, stage],
    )
  ).rows.map((row) => row.result);

const IMPLEMENT_DONE = { outcome: "done" };
const GATE_PASSED = { outcome: "passed", run: { headSha: "sha-a" } };
const REVIEW_PASS = { outcome: "pass", run: { headSha: "sha-a" } };
const REVIEW_FIX = { outcome: "fix", run: { headSha: "sha-a" } };

describe("gate and review in parallel", () => {
  it("implement done queues gate and review together, and neither result alone merges", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    expect((await openStages()).map((r) => r.stage)).toEqual([
      "gate",
      "review",
    ]);
    expect((await ticketRow()).parallel_review).toBe("running");

    const { gate, review } = await claimBoth();
    await complete(gate, GATE_PASSED);
    expect((await ticketRow()).state).toBe("running");
    expect((await openStages()).map((r) => r.stage)).toEqual(["review"]);
    expect((await worker.claim()).body.job).toBeNull();

    await complete(review, REVIEW_PASS);
    expect(await ticketRow()).toMatchObject({
      state: "merging",
      reviewed: true,
    });
    expect(await nextClaimedStage()).toBe("merge");
  });

  it("a review conclusion before the gate also waits, then both results enqueue merge", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const { gate, review } = await claimBoth();
    await complete(review, REVIEW_PASS);
    expect((await ticketRow()).state).toBe("running");
    expect((await ticketRow()).parallel_review).toBe("pass");
    expect((await worker.claim()).body.job).toBeNull();
    await complete(gate, GATE_PASSED);
    expect(await ticketRow()).toMatchObject({
      state: "merging",
      reviewed: true,
    });
    expect(await nextClaimedStage()).toBe("merge");
  });

  it("a failed gate cancels the parallel review job and its Run; a later review result is ignored", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const { gate, review } = await claimBoth();
    await complete(gate, { outcome: "failed" });
    expect(await jobOf("review")).toMatchObject({ state: "failed" });
    expect(await runResults("review")).toEqual(["cancelled"]);
    expect((await ticketRow()).parallel_review).toBe("none");
    expect(
      (
        await worker.complete(review.id, review.attempt, {
          stage: "review",
          ...REVIEW_PASS,
        })
      ).status,
    ).toBe(409);
    expect((await ticketRow()).state).toBe("running");
    expect((await ticketRow()).reviewed).toBe(false);
    expect((await openStages()).map((r) => r.stage)).toEqual(["gate-fix"]);
  });

  it("gate-fix done dispatches gate and review together again", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const first = await claimBoth();
    await complete(first.gate, { outcome: "failed" });
    await stage("gate-fix", IMPLEMENT_DONE);
    expect((await openStages()).map((r) => r.stage)).toEqual([
      "gate",
      "review",
    ]);
    expect((await ticketRow()).parallel_review).toBe("running");
  });

  it("review fix plus a passed gate spends review-fix; after that fix only the gate is dispatched", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const { gate, review } = await claimBoth();
    await complete(gate, GATE_PASSED);
    await complete(review, REVIEW_FIX);
    expect(await ticketRow()).toMatchObject({
      state: "running",
      reviewed: true,
    });
    expect((await openStages()).map((r) => r.stage)).toEqual(["review-fix"]);
    await stage("review-fix", IMPLEMENT_DONE);
    expect((await openStages()).map((r) => r.stage)).toEqual(["gate"]);
    expect((await ticketRow()).parallel_review).toBe("none");
    await stage("gate", GATE_PASSED);
    expect((await ticketRow()).state).toBe("merging");
    expect(await nextClaimedStage()).toBe("merge");
  });

  it("taking over a ticket with gate and review in flight cancels both jobs and both Runs", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await claimBoth();
    const taken = await fetch(`${api.url}/tickets/1/takeover`, {
      method: "POST",
    });
    expect(taken.status).toBe(200);
    expect((await ticketRow()).state).toBe("taken-over");
    expect(await jobOf("gate")).toMatchObject({ state: "failed" });
    expect(await jobOf("review")).toMatchObject({ state: "failed" });
    const runs = await db.pool.query<{ stage: string; result: string }>(
      `SELECT stage, result FROM runs WHERE ticket_id = 1 AND stage IN ('gate', 'review') ORDER BY stage`,
    );
    expect(runs.rows).toEqual([
      { stage: "gate", result: "cancelled" },
      { stage: "review", result: "cancelled" },
    ]);
  });

  it("a review that stays invalid-output after the automatic retry blocks the ticket and cancels the gate", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const { gate, review } = await claimBoth();
    await complete(review, { outcome: "invalid-output" });
    expect((await ticketRow()).state).toBe("running");
    expect((await ticketRow()).parallel_review).toBe("running");
    const retry = (await worker.claim()).body.job as Claimed;
    expect(retry.payload.stage).toBe("review");
    await complete(retry, { outcome: "invalid-output" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "invalid-output",
    });
    expect(await jobOf("gate")).toMatchObject({ state: "failed" });
    expect(await runResults("gate")).toEqual(["cancelled"]);
    expect(
      (
        await worker.complete(gate.id, gate.attempt, {
          stage: "gate",
          ...GATE_PASSED,
        })
      ).status,
    ).toBe(409);
  });
});
