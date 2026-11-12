import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
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
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(testApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// Replies are checked field by field below.
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

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
  ...extra,
});

async function runningSpec(tickets: Record<string, unknown>[]) {
  const created = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    name: "backend",
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
    importBody(spec.body.id, { tickets }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  lockKey: string | null;
  payload: {
    stage: string;
    ticketId?: number;
    specId?: number;
    final?: boolean;
    approvedRemoved?: { classname: string; name: string }[];
  };
}
const SUCCESS: Record<string, Record<string, unknown>> = {
  implement: { outcome: "done" },
  gate: { outcome: "passed" },
  review: { outcome: "pass" },
  merge: { outcome: "merged", headSha: "head" },
};

async function claim() {
  return (await worker.claim()).body.job as Claimed | null;
}
async function step(expected: string, result: Record<string, unknown>) {
  const job = await claim();
  expect(job?.payload.stage).toBe(expected);
  const reply = await worker.complete(
    (job as Claimed).id,
    (job as Claimed).attempt,
    { stage: expected, ...result },
  );
  expect(reply.status).toBe(200);
  return job as Claimed;
}
// Works every ticket stage to the end, until the next job claimed is a final one (which is handed back untouched
// by being left running: callers claim it again after the lease... so instead we stop before claiming it).
async function allTicketsDone() {
  for (let i = 0; i < 60; i++) {
    const open = await db.pool.query(
      "SELECT count(*) FROM tickets WHERE state NOT IN ('done', 'cancelled')",
    );
    if (Number(open.rows[0].count) === 0) return;
    const job = await claim();
    if (!job) throw new Error("ran out of jobs");
    await worker.complete(job.id, job.attempt, {
      stage: job.payload.stage,
      ...SUCCESS[job.payload.stage],
    });
  }
  throw new Error("tickets never finished");
}

const spec = async () =>
  (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;
const fin = async () =>
  (
    await db.pool.query(
      "SELECT step, state, blocked_reason FROM finalizations ORDER BY id",
    )
  ).rows as Json[];
const jobs = async () =>
  (
    await db.pool.query(
      "SELECT type, state, lock_key, payload->>'stage' AS stage, idempotency_key FROM jobs WHERE payload->>'final' = 'true' ORDER BY id",
    )
  ).rows as Json[];

const REVIEW_PASS = {
  outcome: "pass",
  run: {
    output: {
      verdict: "pass",
      mustFix: [],
      suggestions: ["rename x"],
      uncertainties: [],
    },
  },
};
const REVIEW_FIX = {
  outcome: "fix",
  run: {
    output: {
      verdict: "fix",
      mustFix: [
        { file: "src/a.ts", line: 3, problem: "a and b disagree on the name" },
      ],
      suggestions: [],
    },
  },
  findings: [
    { kind: "must-fix", body: "src/a.ts:3 a and b disagree on the name" },
  ],
};

describe("when the overall review starts", () => {
  it("updates the integration branch before overall review when it is behind main", async () => {
    await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE repos SET default_sha = 'bbb222'");
    await allTicketsDone();
    expect(await spec()).toBe("finalizing");
    expect(await fin()).toEqual([
      { step: "final-review", state: "active", blocked_reason: null },
    ]);
    expect(await jobs()).toEqual([]);
    const job = await claim();
    expect(job?.payload).toMatchObject({
      stage: "update-branch",
      specId: 1,
      repoId: 1,
      mainSha: "bbb222",
    });
    expect(job?.lockKey).toBe("integration:1:spec/s");
  });

  it("starts overall review after that update-branch merges", async () => {
    await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE repos SET default_sha = 'bbb222'");
    await allTicketsDone();
    await step("update-branch", { outcome: "merged", headSha: "updated" });
    expect(await jobs()).toMatchObject([
      {
        type: "agent-run",
        state: "queued",
        stage: "final-review",
      },
    ]);
  });

  it("not before the last ticket is done, and then exactly once", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await step("implement", SUCCESS.implement as Record<string, unknown>);
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    await step("review", SUCCESS.review as Record<string, unknown>);
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    expect(await spec()).toBe("running"); // ticket b is still to do
    expect(await fin()).toEqual([]);

    await allTicketsDone();
    expect(await spec()).toBe("finalizing");
    expect(await fin()).toEqual([
      { step: "final-review", state: "active", blocked_reason: null },
    ]);
    expect(await jobs()).toMatchObject([
      {
        type: "agent-run",
        state: "queued",
        lock_key: null,
        stage: "final-review",
        idempotency_key: "S-1:repo-1:final-review:1",
      },
    ]);
  });

  it("does not wait for cancelled tickets, but does wait for blocked ones", async () => {
    await runningSpec([
      ticket("a"),
      ticket("b"),
      ticket("c", { blocked_by: ["a"] }),
    ]);
    await db.pool.query("UPDATE tickets SET state = 'cancelled' WHERE id = 3");
    await step("implement", { outcome: "agent-gave-up" }); // a blocked
    await step("implement", SUCCESS.implement as Record<string, unknown>); // b
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    await step("review", SUCCESS.review as Record<string, unknown>);
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    expect(await spec()).toBe("running"); // a is blocked: a person has to decide
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await spec()).toBe("finalizing"); // a cancelled, b done
  });

  it("does not finalize a spec in which nothing got done: it is cancelled", async () => {
    await runningSpec([ticket("a")]);
    await step("implement", { outcome: "agent-gave-up" });
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await spec()).toBe("cancelled");
    expect(await fin()).toEqual([]);
  });
});

describe("the overall review and the one fix", () => {
  async function toFinalReview() {
    const specId = await runningSpec([ticket("a"), ticket("b")]);
    await allTicketsDone();
    return specId;
  }

  it("a review that passes ends it: no fix, no merge", async () => {
    await toFinalReview();
    await step("final-review", REVIEW_PASS);
    expect(await fin()).toEqual([
      { step: "final-review", state: "done", blocked_reason: null },
    ]);
    expect(await jobs()).toHaveLength(1);
    expect(await spec()).toBe("finalizing");
    expect(await claim()).toBeNull();
  });

  it("a review that wants a fix runs one fix, merged under the branch lock, and that is the end", async () => {
    await toFinalReview();
    await step("final-review", REVIEW_FIX);
    const fix = await step("final-fix", { outcome: "done" });
    expect(fix.lockKey).toBeNull(); // the lock is not held while an agent works
    const merge = await step("final-merge", {
      outcome: "merged",
      headSha: "settled",
    });
    expect(merge.lockKey).toBe("integration:1:spec/s");
    expect(await fin()).toEqual([
      { step: "final-merge", state: "done", blocked_reason: null },
    ]);
    expect((await jobs()).map((j: Json) => j.stage)).toEqual([
      "final-review",
      "final-fix",
      "final-merge",
    ]);
    expect(await claim()).toBeNull(); // nothing more: each runs once
  });

  it("marks only this wrap-up's must-fix for the same spec and repo; suggestions stay on the pack", async () => {
    const created = await call("POST", "/projects", { name: "shop" });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "git@x:backend",
      name: "backend",
    });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "git@x:frontend",
      name: "frontend",
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
      importBody(spec.body.id, {
        tickets: [
          ticket("a"),
          ticket("b", { repo: "frontend", blocked_by: ["a"] }),
        ],
      }),
    );
    await call("POST", `/specs/${spec.body.id}/confirm`);
    await step("implement", SUCCESS.implement as Record<string, unknown>);
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    await step("review", {
      outcome: "pass",
      findings: [{ kind: "must-fix", body: "ticket leftover" }],
    });
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    await step("implement", SUCCESS.implement as Record<string, unknown>);
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    await step("review", SUCCESS.review as Record<string, unknown>);
    await step("merge", SUCCESS.merge as Record<string, unknown>);

    await step("final-review", {
      outcome: "fix",
      run: { axis: "standards" },
      findings: [
        { kind: "must-fix", body: "backend must-fix" },
        { kind: "suggestion", body: "backend suggestion" },
      ],
      extraRuns: [
        {
          run: { axis: "spec" },
          findings: [{ kind: "must-fix", body: "backend spec-axis" }],
        },
      ],
    });
    await step("final-review", {
      outcome: "fix",
      findings: [{ kind: "must-fix", body: "frontend must-fix" }],
    });
    await step("final-fix", { outcome: "done" });

    const findings = await db.pool.query(
      `SELECT rp.name AS repo, r.ticket_id IS NOT NULL AS on_ticket, r.axis, f.kind, f.body, f.resolution
       FROM findings f JOIN runs r ON r.id = f.run_id JOIN repos rp ON rp.id = r.repo_id
       ORDER BY f.id`,
    );
    expect(findings.rows).toEqual([
      {
        repo: "backend",
        on_ticket: true,
        axis: null,
        kind: "must-fix",
        body: "ticket leftover",
        resolution: "unhandled",
      },
      {
        repo: "backend",
        on_ticket: false,
        axis: "standards",
        kind: "must-fix",
        body: "backend must-fix",
        resolution: "fixed",
      },
      {
        repo: "backend",
        on_ticket: false,
        axis: "standards",
        kind: "suggestion",
        body: "backend suggestion",
        resolution: "acceptance-pack",
      },
      {
        repo: "backend",
        on_ticket: false,
        axis: "spec",
        kind: "must-fix",
        body: "backend spec-axis",
        resolution: "fixed",
      },
      {
        repo: "frontend",
        on_ticket: false,
        axis: null,
        kind: "must-fix",
        body: "frontend must-fix",
        resolution: "unhandled",
      },
    ]);
  });

  it("records the Runs of the steps without a ticket, and the review's findings", async () => {
    await toFinalReview();
    await step("final-review", REVIEW_FIX);
    await step("final-fix", { outcome: "done" });
    const runs = await db.pool.query(
      "SELECT stage, result, ticket_id, attempt FROM runs WHERE ticket_id IS NULL ORDER BY id",
    );
    expect(runs.rows).toEqual([
      { stage: "final-review", result: "fix", ticket_id: null, attempt: 1 },
      { stage: "final-fix", result: "done", ticket_id: null, attempt: 1 },
    ]);
    const findings = await db.pool.query(
      "SELECT kind, body, resolution FROM findings f JOIN runs r ON r.id = f.run_id WHERE r.stage = 'final-review'",
    );
    expect(findings.rows).toEqual([
      {
        kind: "must-fix",
        body: "src/a.ts:3 a and b disagree on the name",
        resolution: "fixed",
      },
    ]);
  });

  it("the bundle of a final step has no ticket, but the spec, its tickets' aims, and what came before", async () => {
    await toFinalReview();
    const review = (await claim()) as Claimed;
    const bundleOf = async (job: Claimed) =>
      (await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      ).then((r) => r.json())) as Json;
    const first = await bundleOf(review);
    const id = (await db.pool.query("SELECT id FROM instance")).rows[0].id;
    expect(first).toMatchObject({
      job: { stage: "final-review" },
      ticket: null,
      spec: { displayId: "S-1", slug: "s" },
      integrationBranch: `spec/${id}/s`,
      agentBranch: `agent/${id}/S-1-final`,
      repo: { name: "backend" },
      failureLog: null,
      failedCases: null,
      review: null,
    });
    expect(first.run).not.toBeNull();
    expect(first.specTickets).toEqual([
      { displayId: "T-1", title: "Ticket a", acceptanceCriteria: ["a works"] },
      { displayId: "T-2", title: "Ticket b", acceptanceCriteria: ["b works"] },
    ]);

    await worker.complete(review.id, review.attempt, {
      stage: "final-review",
      ...REVIEW_FIX,
    });
    const fix = (await claim()) as Claimed;
    expect(await bundleOf(fix)).toMatchObject({
      limits: { runIdleSeconds: 600, runWallclockSeconds: 3600 },
      model: null,
    });
    expect((await bundleOf(fix)).review).toMatchObject({ verdict: "fix" }); // the fix is told what to fix
  });

  it("gives wrap-up the whole spec's decisions, including update-branch", async () => {
    await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE repos SET default_sha = 'bbb222'");
    await step("implement", {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [{ kind: "choice", text: "named it export" }],
        },
      },
    });
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    await step("review", SUCCESS.review as Record<string, unknown>);
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    const bundleOf = async (job: Claimed) =>
      (await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      ).then((r) => r.json())) as Json;
    const named = {
      id: expect.stringMatching(/^R-\d+#0$/),
      run: expect.stringMatching(/^R-\d+$/),
      stage: "implement",
      kind: "choice",
      text: "named it export",
    };
    const wholeSpec = (log: Json) => {
      expect(log.ticket).toBeNull();
      expect(log.doneTickets.map((t: Json) => t.displayId)).toEqual(["T-1"]);
      expect(log.doneTickets[0]?.decisions).toEqual([named]);
      expect(log.spec).toMatchObject({ displayId: "S-1", decisions: [] });
    };
    const update = (await claim()) as Claimed;
    expect(update.payload.stage).toBe("update-branch");
    wholeSpec((await bundleOf(update)).decisionLog);
    await worker.complete(update.id, update.attempt, {
      stage: "update-branch",
      outcome: "merged",
      headSha: "updated",
    });
    const review = (await claim()) as Claimed;
    expect(review.payload.stage).toBe("final-review");
    wholeSpec((await bundleOf(review)).decisionLog);
    await worker.complete(review.id, review.attempt, {
      stage: "final-review",
      ...REVIEW_FIX,
    });
    const fix = (await claim()) as Claimed;
    expect(fix.payload.stage).toBe("final-fix");
    wholeSpec((await bundleOf(fix)).decisionLog);
  });
});

describe("when it goes wrong", () => {
  async function toFinalFix() {
    await runningSpec([ticket("a")]);
    await allTicketsDone();
    await step("final-review", REVIEW_FIX);
  }

  it("hands a final-fix the still-failing cases of a failed final-merge", async () => {
    await toFinalFix();
    const cases = [
      {
        name: "exports",
        classname: "orders",
        file: "src/a.test.ts",
        message: "boom",
      },
      {
        name: "imports",
        classname: "orders",
        file: "src/b.test.ts",
        message: "nope",
      },
    ];
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, result, output)
       VALUES (1, 1, 'final-merge', 'gate-failed', $1::jsonb)`,
      [
        JSON.stringify({
          failureLog: "# test failed\nboom",
          failedCases: cases,
        }),
      ],
    );
    const fix = (await claim()) as Claimed;
    expect(fix.payload.stage).toBe("final-fix");
    const bundle = await fetch(
      `${api.url}/worker/jobs/${fix.id}/bundle?workerId=w1&attempt=${fix.attempt}`,
    ).then((r) => r.json());
    expect(bundle.failureLog).toBe("# test failed\nboom");
    expect(bundle.failedCases).toEqual(cases);
  });

  it("leaves wrap-up must-fix findings unhandled when final-fix does not finish", async () => {
    await toFinalFix();
    await step("final-fix", { outcome: "agent-gave-up" });
    const findings = await db.pool.query(
      "SELECT kind, body, resolution FROM findings f JOIN runs r ON r.id = f.run_id WHERE r.stage = 'final-review'",
    );
    expect(findings.rows).toEqual([
      {
        kind: "must-fix",
        body: "src/a.ts:3 a and b disagree on the name",
        resolution: "unhandled",
      },
    ]);
  });

  it("a fix the agent gives up on blocks the finalization with a brief", async () => {
    await toFinalFix();
    await step("final-fix", {
      outcome: "agent-gave-up",
      run: { output: { status: "cannot-proceed", detail: "needs a decision" } },
    });
    expect(await fin()).toEqual([
      { step: "final-fix", state: "blocked", blocked_reason: "agent-gave-up" },
    ]);
    const queue = await call("GET", "/blocked");
    expect(queue.body.finalizations).toHaveLength(1);
    expect(queue.body.finalizations[0]).toMatchObject({
      specDisplayId: "S-1",
      repo: "backend",
      step: "final-fix",
      state: "blocked",
      blockedReason: "agent-gave-up",
      brief: {
        stage: "final-fix",
        result: "agent-gave-up",
        output: { detail: "needs a decision" },
      },
    });
    const view = await call("GET", "/specs/1");
    expect(view.body.finalizations[0]).toMatchObject({
      step: "final-fix",
      state: "blocked",
    });
    expect(await claim()).toBeNull();
  });

  it("removed tests on final-merge block without a second fix, and approve continues that merge", async () => {
    await toFinalFix();
    await step("final-fix", { outcome: "done" });
    await step("final-merge", {
      outcome: "tests-removed",
      run: {
        output: { removedTests: [{ classname: "suite", name: "gone" }] },
      },
    });
    expect(await fin()).toEqual([
      {
        step: "final-merge",
        state: "blocked",
        blocked_reason: "tests-removed",
      },
    ]);
    const approved = await call("POST", "/specs/1/approve-removed-tests");
    expect(approved).toMatchObject({
      status: 200,
      body: { approved: [{ classname: "suite", name: "gone" }] },
    });
    expect(await fin()).toEqual([
      { step: "final-merge", state: "active", blocked_reason: null },
    ]);
    const again = await claim();
    expect(again?.payload.stage).toBe("final-merge");
    expect(again?.payload.approvedRemoved).toEqual([
      { classname: "suite", name: "gone" },
    ]);
    const bundle = await fetch(
      `${api.url}/worker/jobs/${again?.id}/bundle?workerId=w1&attempt=${again?.attempt}`,
    ).then((r) => r.json());
    expect(bundle.approvedRemovedTests).toEqual([
      { classname: "suite", name: "gone" },
    ]);
  });

  it("a conflict or a failed gate when the fix is merged blocks it, and a retry runs the merge again", async () => {
    await toFinalFix();
    await step("final-fix", { outcome: "done" });
    await step("final-merge", {
      outcome: "gate-failed",
      run: { output: { failureLog: "# test failed\nboom" } },
    });
    expect(await fin()).toEqual([
      {
        step: "final-merge",
        state: "blocked",
        blocked_reason: "post-merge-gate-failed",
      },
    ]);
    expect(
      (await call("GET", "/blocked")).body.finalizations[0].brief,
    ).toMatchObject({ stage: "final-merge", result: "gate-failed" });

    const retried = await call("POST", "/specs/1/final/retry");
    expect(retried).toMatchObject({
      status: 200,
      body: { retried: ["final-merge"] },
    });
    expect(await fin()).toEqual([
      { step: "final-merge", state: "active", blocked_reason: null },
    ]);
    const again = await claim();
    expect(again?.payload.stage).toBe("final-merge");
    expect(again?.lockKey).toBe("integration:1:spec/s");
    const keys = await jobs();
    expect(keys.map((j: Json) => j.idempotency_key)).toEqual([
      "S-1:repo-1:final-review:1",
      "S-1:repo-1:final-fix:1",
      "S-1:repo-1:final-merge:1",
      "S-1:repo-1:final-merge:2",
    ]);
    await worker.complete((again as Claimed).id, (again as Claimed).attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: "h",
    });
    expect(await fin()).toEqual([
      { step: "final-merge", state: "done", blocked_reason: null },
    ]);
  });

  it("a retry-final note goes on the next Run's bundle, then a retry without one has none", async () => {
    await toFinalFix();
    await step("final-fix", { outcome: "done" });
    await step("final-merge", { outcome: "conflict" });
    const note = "take theirs on src/a.ts";
    expect((await call("POST", "/specs/1/final/retry", { note })).status).toBe(
      200,
    );
    expect(
      (
        await db.pool.query(
          "SELECT source, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows.at(-1),
    ).toEqual({ source: "page", action: "retry-final" });
    const again = (await claim()) as Claimed;
    const bundleOf = async (job: Claimed) =>
      (await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      ).then((r) => r.json())) as Json;
    expect((await bundleOf(again)).note).toBe(note);
    await worker.complete(again.id, again.attempt, {
      stage: "final-merge",
      outcome: "conflict",
    });
    expect((await call("POST", "/specs/1/final/retry")).status).toBe(200);
    expect((await bundleOf((await claim()) as Claimed)).note).toBeNull();
  });

  it("a conflict is merge-conflict", async () => {
    await toFinalFix();
    await step("final-fix", { outcome: "done" });
    await step("final-merge", { outcome: "conflict" });
    expect((await fin())[0]).toMatchObject({
      state: "blocked",
      blocked_reason: "merge-conflict",
    });
  });

  it("a known-gap without a ruling on final-review is invalid-output", async () => {
    await runningSpec([ticket("a")]);
    await step("implement", {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [
            { kind: "known-gap", text: "reload still skips the note filter" },
          ],
        },
      },
    });
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    const review = (await claim()) as Claimed;
    const log = await fetch(
      `${api.url}/worker/jobs/${review.id}/bundle?workerId=w1&attempt=${review.attempt}`,
    ).then((r) => r.json());
    const id = log.decisionLog.ticket.decisions[0].id as string;
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          rulings: [{ id, verdict: "accepted" }],
        },
      },
    });
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    await step("final-review", {
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
        },
      },
    });
    expect(await fin()).toEqual([
      {
        step: "final-review",
        state: "blocked",
        blocked_reason: "invalid-output",
      },
    ]);
  });

  it("a timeout on final-review is still a timeout when a known-gap has no ruling", async () => {
    await runningSpec([ticket("a")]);
    await step("implement", {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [
            { kind: "known-gap", text: "reload still skips the note filter" },
          ],
        },
      },
    });
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    const review = (await claim()) as Claimed;
    const log = await fetch(
      `${api.url}/worker/jobs/${review.id}/bundle?workerId=w1&attempt=${review.attempt}`,
    ).then((r) => r.json());
    const id = log.decisionLog.ticket.decisions[0].id as string;
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          rulings: [{ id, verdict: "accepted" }],
        },
      },
    });
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    await step("final-review", { outcome: "timeout" });
    expect(await fin()).toEqual([
      {
        step: "final-review",
        state: "blocked",
        blocked_reason: "timeout",
      },
    ]);
  });

  it("a spec-level must-fix ruling goes to final-fix", async () => {
    await runningSpec([ticket("a")]);
    await step("implement", {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [
            { kind: "known-gap", text: "reload still skips the note filter" },
          ],
        },
      },
    });
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    const review = (await claim()) as Claimed;
    const log = await fetch(
      `${api.url}/worker/jobs/${review.id}/bundle?workerId=w1&attempt=${review.attempt}`,
    ).then((r) => r.json());
    const id = log.decisionLog.ticket.decisions[0].id as string;
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          rulings: [{ id, verdict: "accepted" }],
        },
      },
    });
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    await step("final-review", {
      outcome: "fix",
      run: {
        axis: "spec",
        output: {
          verdict: "fix",
          mustFix: [
            {
              file: "src/a.ts",
              problem: "reload still skips the note filter",
              id,
            },
          ],
          suggestions: [],
          rulings: [{ id, verdict: "must-fix" }],
        },
      },
      findings: [
        {
          kind: "must-fix",
          body: "src/a.ts reload still skips the note filter",
        },
      ],
    });
    expect(await fin()).toEqual([
      { step: "final-fix", state: "active", blocked_reason: null },
    ]);
    expect((await claim())?.payload.stage).toBe("final-fix");
  });

  it("does not block wrap-up for needs-human or an unfinished deferred", async () => {
    await runningSpec([ticket("a")]);
    await step("implement", {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [
            { kind: "known-gap", text: "reload still skips the note filter" },
            { kind: "deferred", text: "openapi extra field", ref: "new" },
          ],
        },
      },
    });
    await step("gate", SUCCESS.gate as Record<string, unknown>);
    const review = (await claim()) as Claimed;
    const log = await fetch(
      `${api.url}/worker/jobs/${review.id}/bundle?workerId=w1&attempt=${review.attempt}`,
    ).then((r) => r.json());
    const id = log.decisionLog.ticket.decisions[0].id as string;
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          rulings: [{ id, verdict: "needs-human" }],
        },
      },
    });
    await step("merge", SUCCESS.merge as Record<string, unknown>);
    await step("final-review", {
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          rulings: [{ id, verdict: "needs-human" }],
        },
      },
    });
    expect(await fin()).toEqual([
      { step: "final-review", state: "done", blocked_reason: null },
    ]);
    expect((await call("GET", "/blocked")).body.finalizations).toEqual([]);
  });

  it("a result that is not valid blocks it as invalid-output, and the review is not asked again", async () => {
    await runningSpec([ticket("a")]);
    await allTicketsDone();
    await step("final-review", { outcome: "looks fine to me" });
    expect(await fin()).toEqual([
      {
        step: "final-review",
        state: "blocked",
        blocked_reason: "invalid-output",
      },
    ]);
  });

  it("ignores a result for a step the finalization is no longer at", async () => {
    await toFinalFix();
    const fix = (await claim()) as Claimed;
    await db.pool.query(
      "UPDATE finalizations SET state = 'blocked', blocked_reason = 'timeout'",
    );
    const reply = await worker.complete(fix.id, fix.attempt, {
      stage: "final-fix",
      outcome: "done",
    });
    expect(reply.status).toBe(200);
    expect((await fin())[0]).toMatchObject({
      state: "blocked",
      blocked_reason: "timeout",
    }); // unchanged
    expect(await claim()).toBeNull();
  });

  it("a result that arrives after the spec was cancelled changes nothing", async () => {
    await runningSpec([ticket("a")]);
    await allTicketsDone();
    const review = (await claim()) as Claimed;
    await db.pool.query("UPDATE specs SET state = 'cancelled'");
    expect(
      (
        await worker.complete(review.id, review.attempt, {
          stage: "final-review",
          ...REVIEW_FIX,
        })
      ).status,
    ).toBe(200);
    expect((await fin())[0]).toMatchObject({
      step: "final-review",
      state: "active",
    });
    expect(await jobs()).toHaveLength(1); // no fix was queued
  });

  it("a blocked step is not retried on a spec that is no longer finalizing", async () => {
    await runningSpec([ticket("a")]);
    await allTicketsDone();
    await step("final-review", { outcome: "timeout" });
    await db.pool.query("UPDATE specs SET state = 'cancelled'");
    const retry = await call("POST", "/specs/1/final/retry");
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/cancelled, not finalizing/);
  });

  it("there is nothing to retry when nothing is blocked", async () => {
    await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE specs SET state = 'finalizing'");
    expect((await call("POST", "/specs/1/final/retry")).status).toBe(409);
    expect((await call("POST", "/specs/99/final/retry")).status).toBe(404);
  });
});
