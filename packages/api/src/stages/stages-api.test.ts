import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";
import type { Bundle } from "./bundle.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(createApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

// One running spec with the given tickets, in a project with backend and frontend repos.
async function runningSpec(
  tickets: Record<string, unknown>[],
  project: Record<string, unknown> = {},
) {
  const created = await post("/projects", {
    name: "shop",
    contractPath: "backend:openapi.yaml",
    ...project,
  });
  for (const role of ["backend", "frontend"]) {
    await post(`/projects/${created.body.id}/repos`, {
      url: `git@x:${role}`,
      role,
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
    (await post(`/specs/${spec.body.id}/tickets/import`, { tickets })).status,
  ).toBe(200);
  expect((await post(`/specs/${spec.body.id}/confirm`)).status).toBe(200);
  return spec.body.id;
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  lockKey: string | null;
  payload: { stage: string; ticketId: number };
}

// Claims the next job, checks it is the expected stage, and hands back the given result.
async function stage(
  expected: string,
  result: Record<string, unknown>,
): Promise<Claimed> {
  const claimed = (await worker.claim()).body.job as Claimed | null;
  expect(claimed?.payload.stage).toBe(expected);
  const reply = await worker.complete(
    (claimed as Claimed).id,
    (claimed as Claimed).attempt,
    {
      stage: expected,
      ...result,
    },
  );
  expect(reply.status).toBe(200);
  return claimed as Claimed;
}

const ticketRow = async (id = 1) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason, fix_counts, reviewed, contract_sha FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const noJobsLeft = async () =>
  expect((await worker.claim()).body.job).toBeNull();

const IMPLEMENT_DONE = { outcome: "done" };
const GATE_PASSED = { outcome: "passed" };
const REVIEW_PASS = { outcome: "pass" };
const MERGED = { outcome: "merged", headSha: "head-1" };

describe("the happy path", () => {
  it("implement -> gate -> review -> merge -> done, and the ticket's state follows", async () => {
    await runningSpec([ticket("a")]);
    expect((await ticketRow()).state).toBe("queued");

    await stage("implement", IMPLEMENT_DONE);
    expect((await ticketRow()).state).toBe("running"); // claimed
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    expect(await ticketRow()).toMatchObject({
      state: "merging",
      reviewed: true,
    });
    await stage("merge", MERGED);
    expect(await ticketRow()).toMatchObject({
      state: "done",
      blocked_reason: null,
    });
    // the only ticket is done, so the spec's overall review is next: no more ticket stages
    const next = (await worker.claim()).body.job as Claimed;
    expect(next.payload.stage).toBe("final-review");
    await noJobsLeft();
  });

  it("queues the merge job with the integration branch's lock key, and no other job has one", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    const jobs = await db.pool.query(
      "SELECT type, lock_key, idempotency_key FROM jobs ORDER BY id",
    );
    expect(jobs.rows).toEqual([
      {
        type: "agent-run",
        lock_key: null,
        idempotency_key: "T-1:1:implement:1",
      },
      { type: "gate", lock_key: null, idempotency_key: "T-1:1:gate:1" },
      { type: "agent-run", lock_key: null, idempotency_key: "T-1:1:review:1" },
      {
        type: "merge",
        lock_key: "integration:1:spec/order-export",
        idempotency_key: "T-1:1:merge:1",
      },
    ]);
  });
});

describe("blocked reason codes", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    [
      "implement",
      "invalid-output",
      { outcome: "invalid-output" },
      "invalid-output",
    ],
    [
      "implement",
      "agent-gave-up",
      { outcome: "agent-gave-up" },
      "agent-gave-up",
    ],
    [
      "implement",
      "contract-change-needed",
      { outcome: "contract-change-needed" },
      "contract-change-needed",
    ],
    ["implement", "no-commits", { outcome: "no-commits" }, "no-commits"],
    ["implement", "timeout", { outcome: "timeout" }, "timeout"],
  ];
  it.each(cases)(
    "%s reporting %s blocks the ticket with that code",
    async (stageName, _name, result, reason) => {
      await runningSpec([ticket("a")]);
      await stage(stageName, result);
      expect(await ticketRow()).toMatchObject({
        state: "blocked",
        blocked_reason: reason,
      });
      await noJobsLeft();
    },
  );

  it("a result that is not a valid stage report is invalid-output, and what was sent is kept", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", { outcome: "great success" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "invalid-output",
    });
    const run = await db.pool.query("SELECT result, output FROM runs");
    expect(run.rows[0].result).toBe("invalid-output");
    expect(run.rows[0].output).toMatchObject({ outcome: "great success" });
  });

  it("a result for a different stage than the job is invalid-output too", async () => {
    await runningSpec([ticket("a")]);
    const claimed = (await worker.claim()).body.job as Claimed;
    await worker.complete(claimed.id, claimed.attempt, {
      stage: "gate",
      outcome: "passed",
    });
    expect((await ticketRow()).blocked_reason).toBe("invalid-output");
  });

  it("an unapproved protected path blocks after the gate", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", { outcome: "protected-path-changed" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "protected-path-changed",
    });
  });

  it("a gate failure runs gate-fix once; failing again is gate-failed", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", { outcome: "failed" });
    expect((await ticketRow()).fix_counts).toEqual({
      "gate-fix": 1,
      "review-fix": 0,
      "merge-fix": 0,
    });
    await stage("gate-fix", IMPLEMENT_DONE);
    await stage("gate", { outcome: "failed" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "gate-failed",
    });
    await noJobsLeft();
  });

  it("a merge conflict runs merge-fix once; conflicting again is merge-conflict", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "conflict" });
    expect((await ticketRow()).state).toBe("running"); // back to running for the agent
    await stage("merge-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    expect((await ticketRow()).state).toBe("merging"); // reviewed already: straight to merge
    await stage("merge", { outcome: "conflict" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "merge-conflict",
    });
  });

  it("a failed candidate gate runs merge-fix once; failing again is post-merge-gate-failed", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "gate-failed" });
    await stage("merge-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("merge", { outcome: "gate-failed" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "post-merge-gate-failed",
    });
  });

  it("an ordinary ticket needs no integration head to be done", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "merged" });
    expect((await ticketRow()).state).toBe("done");
  });

  it("a contract ticket merged without the integration head is invalid-output, not done", async () => {
    await runningSpec([ticket("c", { type: "contract" })]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "merged" });
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "invalid-output",
    });
  });
});

describe("fix limits", () => {
  it("review runs once and its fix verdict runs review-fix once, with no second review", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", {
      outcome: "fix",
      findings: [{ kind: "must-fix", body: "null check" }],
    });
    expect(await ticketRow()).toMatchObject({
      state: "running",
      reviewed: true,
    });
    await stage("review-fix", IMPLEMENT_DONE);
    const handled = await db.pool.query("SELECT resolution FROM findings");
    expect(handled.rows).toEqual([{ resolution: "fixed" }]);
    await stage("gate", GATE_PASSED); // no second review: next is the merge
    expect((await ticketRow()).state).toBe("merging");
    await stage("merge", MERGED);
    expect((await ticketRow()).state).toBe("done");
  });

  it("the worst case is five agent runs and still ends done", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", { outcome: "failed" });
    await stage("gate-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", { outcome: "fix" });
    await stage("review-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("merge", { outcome: "conflict" });
    await stage("merge-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("merge", MERGED);
    expect(await ticketRow()).toMatchObject({
      state: "done",
      fix_counts: { "gate-fix": 1, "review-fix": 1, "merge-fix": 1 },
    });
    const agentRuns = await db.pool.query(
      "SELECT count(*) FROM runs WHERE stage IN ('implement','review','gate-fix','review-fix','merge-fix')",
    );
    expect(Number(agentRuns.rows[0].count)).toBe(5);
  });
});

describe("what is recorded", () => {
  it("writes a Run per stage result with its facts, and counts tries per stage", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", {
      outcome: "done",
      run: {
        agent: "cursor",
        model: "auto",
        skillsSha: "skills1",
        cursorCliVersion: "1.2.3",
        branch: "agent/T-1",
        baseSha: "base",
        headSha: "head",
        commits: ["c1", "c2"],
        durationMs: 146_000,
        durationApiMs: 120_000,
        output: { status: "done" },
        logUrl: "logs/1",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:02:26.000Z",
      },
    });
    await stage("gate", { outcome: "failed" });
    await stage("gate-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    const runs = await db.pool.query(
      "SELECT stage, attempt, result, agent, model, branch, commits, duration_ms, duration_api_ms, ticket_version, output FROM runs ORDER BY id",
    );
    expect(runs.rows.map((r) => [r.stage, r.attempt, r.result])).toEqual([
      ["implement", 1, "done"],
      ["gate", 1, "failed"],
      ["gate-fix", 1, "done"],
      ["gate", 2, "passed"],
    ]);
    expect(runs.rows[0]).toMatchObject({
      agent: "cursor",
      model: "auto",
      branch: "agent/T-1",
      commits: ["c1", "c2"],
      duration_ms: 146_000,
      duration_api_ms: 120_000,
      ticket_version: 1,
      output: { status: "done" },
    });
  });

  it("writes the GateResult, replacing it when the same commit is gated again", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    const gate = {
      commitSha: "abc",
      configSha: "cfg",
      commandResults: [{ command: "test", exitCode: 1 }],
      testsTotal: 10,
      testsSkipped: 1,
    };
    await stage("gate", { outcome: "failed", gate });
    await stage("gate-fix", IMPLEMENT_DONE);
    await stage("gate", {
      outcome: "passed",
      gate: { ...gate, commandResults: [{ command: "test", exitCode: 0 }] },
    });
    const rows = await db.pool.query(
      "SELECT commit_sha, config_sha, command_results, tests_total, tests_skipped FROM gate_results",
    );
    expect(rows.rows).toEqual([
      {
        commit_sha: "abc",
        config_sha: "cfg",
        command_results: [{ command: "test", exitCode: 0 }],
        tests_total: 10,
        tests_skipped: 1,
      },
    ]);
  });

  it("writes Findings against the run; suggestions go to the acceptance pack", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", {
      outcome: "pass",
      findings: [
        { kind: "suggestion", body: "rename x" },
        { kind: "must-fix", body: "fixed already", resolution: "fixed" },
        { kind: "must-fix", body: "missed" },
      ],
    });
    const findings = await db.pool.query(
      "SELECT f.kind, f.body, f.resolution, r.stage FROM findings f JOIN runs r ON r.id = f.run_id ORDER BY f.id",
    );
    expect(findings.rows).toEqual([
      {
        kind: "suggestion",
        body: "rename x",
        resolution: "acceptance-pack",
        stage: "review",
      },
      {
        kind: "must-fix",
        body: "fixed already",
        resolution: "fixed",
        stage: "review",
      },
      {
        kind: "must-fix",
        body: "missed",
        resolution: "unhandled",
        stage: "review",
      },
    ]);
  });

  it("agent time of the runs counts toward the spec's budget", async () => {
    const specId = await runningSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
    ]);
    await stage("implement", {
      outcome: "done",
      run: { durationMs: 12 * 60 * 60 * 1000 },
    });
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", MERGED);
    // the budget is used up, so finishing ticket 1 pauses the spec instead of starting ticket 2
    const spec = await db.pool.query("SELECT state FROM specs WHERE id = $1", [
      specId,
    ]);
    expect(spec.rows[0].state).toBe("paused");
    expect((await ticketRow(2)).state).toBe("pending");
  });
});

describe("merge jobs of one integration branch", () => {
  it("run one at a time, first in first out, and the others wait for the lease", async () => {
    await runningSpec([ticket("a"), ticket("b")]);
    const second = new FakeWorker(api.url, "w2", []);
    const reachMerges = async () => {
      // drive both tickets up to their merge stage; hold the first merge job that shows up
      const held: Claimed[] = [];
      for (let i = 0; i < 30 && held.length === 0; i++) {
        const job = (await worker.claim()).body.job as Claimed | null;
        if (!job) break;
        if (job.payload.stage === "merge") {
          held.push(job);
          break;
        }
        const success: Record<string, Record<string, unknown>> = {
          implement: IMPLEMENT_DONE,
          gate: GATE_PASSED,
          review: REVIEW_PASS,
        };
        await worker.complete(job.id, job.attempt, {
          stage: job.payload.stage,
          ...success[job.payload.stage],
        });
      }
      return held[0] as Claimed;
    };
    const firstMerge = await reachMerges();
    expect(firstMerge.lockKey).toMatch(/^integration:\d+:spec\/order-export$/);

    // the other ticket gets to its merge stage while the first merge still holds the lock
    for (let i = 0; i < 10; i++) {
      const job = (await second.claim()).body.job as Claimed | null;
      if (!job) break;
      const success: Record<string, Record<string, unknown>> = {
        implement: IMPLEMENT_DONE,
        gate: GATE_PASSED,
        review: REVIEW_PASS,
      };
      await second.complete(job.id, job.attempt, {
        stage: job.payload.stage,
        ...success[job.payload.stage],
      });
    }
    const queued = await db.pool.query(
      "SELECT id, lock_key FROM jobs WHERE type = 'merge' AND state = 'queued'",
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0].lock_key).toBe(firstMerge.lockKey);

    // nobody can take it while the first merge is out ...
    expect((await second.claim()).body.job).toBeNull();
    // ... and when it is done, the next one is next in line
    await worker.complete(firstMerge.id, firstMerge.attempt, {
      stage: "merge",
      ...MERGED,
    });
    const next = (await second.claim()).body.job as Claimed;
    expect(next.payload.stage).toBe("merge");
    expect(next.id).toBe(queued.rows[0].id);
  });

  it("let a fix run without the lock, and queue a new merge after it", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    const merge = await stage("merge", { outcome: "conflict" });
    expect(merge.lockKey).not.toBeNull();
    const fix = (await worker.claim()).body.job as Claimed;
    expect(fix.payload.stage).toBe("merge-fix");
    expect(fix.lockKey).toBeNull(); // the lock is not held while an agent works
    await worker.complete(fix.id, fix.attempt, {
      stage: "merge-fix",
      outcome: "done",
    });
    await stage("gate", GATE_PASSED);
    const again = (await worker.claim()).body.job as Claimed;
    expect(again.payload.stage).toBe("merge");
    expect(again.lockKey).toBe(merge.lockKey);
  });
});

describe("the gate baseline in the bundle", () => {
  const baselineOf = async (job: Claimed) =>
    (
      (await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      ).then((r) => r.json())) as { gateBaseline: unknown }
    ).gateBaseline;

  it("is none before anything has merged, and then what the last merge measured", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const first = (await worker.claim()).body.job as Claimed;
    expect(await baselineOf(first)).toBeNull();
    await worker.complete(first.id, first.attempt, {
      stage: "implement",
      outcome: "done",
    });
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", {
      outcome: "merged",
      headSha: "tip-1",
      run: { headSha: "tip-1" },
      gate: {
        commitSha: "tip-1",
        configSha: "cfg",
        commandResults: [],
        testsTotal: 5,
        testsSkipped: 1,
      },
    });
    const second = (await worker.claim()).body.job as Claimed;
    expect(second.payload.ticketId).toBe(2);
    expect(await baselineOf(second)).toEqual({ tests: 5, skipped: 1 });
  });

  it("is the newest merge's, not an older one's", async () => {
    await runningSpec([ticket("a"), ticket("b")]);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, result, head_sha) VALUES (1, 1, 'merge', 'merged', 'old'), (1, 1, 'merge', 'merged', 'new')`,
    );
    await db.pool.query(
      `INSERT INTO gate_results (repo_id, commit_sha, config_sha, tests_total, tests_skipped) VALUES (1, 'old', 'c', 9, 0), (1, 'new', 'c', 4, 2)`,
    );
    const job = (await worker.claim()).body.job as Claimed;
    expect(await baselineOf(job)).toEqual({ tests: 4, skipped: 2 });
  });
});

describe("a worker that is faster than the claim bookkeeping", () => {
  it("an implement result for a ticket still marked queued is handled as if it were running", async () => {
    await runningSpec([ticket("a")]);
    const claimed = (await worker.claim()).body.job as Claimed;
    await db.pool.query("UPDATE tickets SET state = 'queued'"); // as if the claim never marked it
    await worker.complete(claimed.id, claimed.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect((await ticketRow()).state).toBe("running");
    await stage("gate", GATE_PASSED);
  });
});

describe("scheduling follows the results", () => {
  it("a blocked ticket frees its slot so the next ticket can start", async () => {
    await runningSpec([ticket("a"), ticket("b"), ticket("c")], {
      limits: { projectConcurrency: 2 },
    });
    expect((await ticketRow(3)).state).toBe("pending");
    await stage("implement", { outcome: "agent-gave-up" });
    expect((await ticketRow(1)).state).toBe("blocked");
    expect((await ticketRow(3)).state).toBe("queued");
  });

  it("a merged ticket starts the ticket that depended on it", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    expect((await ticketRow(2)).state).toBe("pending");
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", MERGED);
    expect((await ticketRow(2)).state).toBe("queued");
  });

  it("a contract ticket records the integration head as its contract SHA", async () => {
    await runningSpec([
      ticket("c", { type: "contract" }),
      ticket("fe", { repo: "frontend", contract: "c" }),
    ]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "merged", headSha: "contract-head" });
    expect((await ticketRow(1)).contract_sha).toBe("contract-head");
    expect((await ticketRow(2)).state).toBe("queued");
  });

  it("ignores a result for a ticket that was cancelled meanwhile", async () => {
    await runningSpec([ticket("a")]);
    const claimed = (await worker.claim()).body.job as Claimed;
    await db.pool.query("UPDATE tickets SET state = 'cancelled'");
    const reply = await worker.complete(claimed.id, claimed.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect(reply.status).toBe(200);
    expect((await ticketRow()).state).toBe("cancelled");
    await noJobsLeft();
  });

  it("a stale worker's result changes nothing", async () => {
    await runningSpec([ticket("a")]);
    const claimed = (await worker.claim()).body.job as Claimed;
    const reply = await worker.complete(claimed.id, claimed.attempt + 1, {
      stage: "implement",
      outcome: "agent-gave-up",
    });
    expect(reply.status).toBe(409);
    expect((await ticketRow()).state).toBe("running");
  });

  it("completing a job that is not a ticket stage still just completes it", async () => {
    await db.pool.query(
      "INSERT INTO jobs (type, idempotency_key) VALUES ('open-pr', 'k')",
    );
    const claimed = (await worker.claim()).body.job as Claimed;
    expect(
      (await worker.complete(claimed.id, claimed.attempt, { whatever: 1 }))
        .status,
    ).toBe(200);
  });
});

describe("the bundle", () => {
  async function bundle(
    job: Claimed,
    query = `workerId=w1&attempt=${job.attempt}`,
  ) {
    const response = await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?${query}`,
    );
    return {
      status: response.status,
      body: (await response.json()) as Bundle,
    };
  }

  it("carries the ticket, spec, repo, integration branch and the protected paths approved at import", async () => {
    await runningSpec(
      [
        ticket("a", {
          protected_paths_ok: ["openapi/openapi.yaml"],
          body: "do the thing",
          acceptance: ["one", "two"],
        }),
      ],
      { protectedPaths: ["openapi/**", ".github/**"] },
    );
    const job = (await worker.claim()).body.job as Claimed;
    const reply = await bundle(job);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      job: { id: job.id, stage: "implement", attempt: 1 },
      ticket: {
        id: 1,
        displayId: "T-1",
        type: "implementation",
        title: "Ticket a",
        body: "do the thing",
        acceptanceCriteria: ["one", "two"],
        modules: ["src/a/**"],
        contentVersion: 1,
        fixCounts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
        reviewed: false,
      },
      spec: {
        displayId: "S-1",
        slug: "order-export",
        title: "Order export",
        body: "# spec body",
        type: "feature",
      },
      repo: { role: "backend", url: "git@x:backend", defaultBranch: "main" },
      integrationBranch: "spec/order-export",
      protectedPaths: ["openapi/**", ".github/**"],
      allowedProtectedPaths: ["openapi/openapi.yaml"],
      contract: null,
    });
  });

  it("points a downstream ticket at the contract SHA and the project's contract file", async () => {
    await runningSpec(
      [
        ticket("c", { type: "contract" }),
        ticket("fe", { repo: "frontend", contract: "c" }),
      ],
      { contractPath: "backend:openapi/openapi.yaml" },
    );
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", { outcome: "merged", headSha: "contract-head" });
    const job = (await worker.claim()).body.job as Claimed;
    expect(job.payload.ticketId).toBe(2);
    const reply = await bundle(job);
    expect(reply.body.contract).toEqual({
      sha: "contract-head",
      path: "backend:openapi/openapi.yaml",
      repoId: 1,
    });
    expect(reply.body.integrationBranch).toBe("spec/order-export");
  });

  it("names the Run the job started, so logs and commit trailers have somewhere to point", async () => {
    await runningSpec([ticket("a")]);
    const job = (await worker.claim()).body.job as Claimed;
    const reply = await bundle(job);
    const run = await db.pool.query("SELECT id FROM runs WHERE job_id = $1", [
      job.id,
    ]);
    expect(reply.body.run).toEqual({
      id: run.rows[0].id,
      displayId: `R-${run.rows[0].id}`,
    });
  });

  it("hands a gate-fix the log of the gate that failed, and a review-fix the review", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "# test failed\nboom" } },
    });
    const fix = (await worker.claim()).body.job as Claimed;
    expect((await bundle(fix)).body.failureLog).toBe("# test failed\nboom");
    await worker.complete(fix.id, fix.attempt, {
      stage: "gate-fix",
      outcome: "done",
    });
    await stage("gate", GATE_PASSED);
    await stage("review", {
      outcome: "fix",
      run: {
        output: {
          verdict: "fix",
          mustFix: [{ file: "a.ts", problem: "null" }],
        },
      },
    });
    const reviewFix = (await worker.claim()).body.job as Claimed;
    expect((await bundle(reviewFix)).body.review).toMatchObject({
      verdict: "fix",
    });
  });

  it("does not hand over a failure log that a later passing gate made obsolete", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "old failure" } },
    });
    await stage("gate-fix", IMPLEMENT_DONE);
    await stage("gate", GATE_PASSED);
    await stage("review", REVIEW_PASS);
    await stage("merge", {
      outcome: "conflict",
      run: { output: { failureLog: "conflict in a.ts" } },
    });
    const mergeFix = (await worker.claim()).body.job as Claimed;
    expect((await bundle(mergeFix)).body.failureLog).toBe("conflict in a.ts");
    await worker.complete(mergeFix.id, mergeFix.attempt, {
      stage: "merge-fix",
      outcome: "done",
    });
    await stage("gate", GATE_PASSED);
    const merge = (await worker.claim()).body.job as Claimed;
    expect((await bundle(merge)).body.failureLog).toBeNull();
  });

  it("shows the pipeline progress to a fix stage", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", IMPLEMENT_DONE);
    await stage("gate", { outcome: "failed" });
    const job = (await worker.claim()).body.job as Claimed;
    const reply = await bundle(job);
    expect(reply.body.job.stage).toBe("gate-fix");
    expect(reply.body.ticket?.fixCounts["gate-fix"]).toBe(1);
  });

  it("refuses anyone who does not hold the job at its current attempt", async () => {
    await runningSpec([ticket("a")]);
    const job = (await worker.claim()).body.job as Claimed;
    expect(
      (await bundle(job, `workerId=other&attempt=${job.attempt}`)).status,
    ).toBe(409);
    expect(
      (await bundle(job, `workerId=w1&attempt=${job.attempt + 1}`)).status,
    ).toBe(409);
    expect((await bundle({ ...job, id: 999 })).status).toBe(404);
    expect((await bundle(job, "workerId=w1")).status).toBe(400);
  });

  it("has nothing to say about a job without a ticket", async () => {
    await db.pool.query(
      "INSERT INTO jobs (type, idempotency_key) VALUES ('open-pr', 'k')",
    );
    const job = (await worker.claim()).body.job as Claimed;
    expect((await bundle(job)).status).toBe(404);
  });

  it("does not renew the lease", async () => {
    await runningSpec([ticket("a")]);
    const job = (await worker.claim()).body.job as Claimed;
    const before = await db.pool.query(
      "SELECT lease_expires_at FROM jobs WHERE id = $1",
      [job.id],
    );
    await bundle(job);
    const after = await db.pool.query(
      "SELECT lease_expires_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(after.rows[0].lease_expires_at).toEqual(
      before.rows[0].lease_expires_at,
    );
  });
});
