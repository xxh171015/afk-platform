import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";

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

// Replies are checked field by field below; their exact shapes are the generated client's business.
// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Json,
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

async function runningSpec(
  tickets: Record<string, unknown>[],
  project: Record<string, unknown> = {},
) {
  const created = await call("POST", "/projects", { name: "shop", ...project });
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
  expect(
    (await call("POST", `/specs/${spec.body.id}/tickets/import`, { tickets }))
      .status,
  ).toBe(200);
  expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
    200,
  );
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId: number };
}
async function stage(expected: string, result: Record<string, unknown>) {
  const job = (await worker.claim()).body.job as Claimed | null;
  expect(job?.payload.stage).toBe(expected);
  await worker.complete((job as Claimed).id, (job as Claimed).attempt, {
    stage: expected,
    ...result,
  });
  return job as Claimed;
}
const row = async (id: number) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason, fix_counts, reviewed, restart, allowed_protected_paths FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const states = async () =>
  (
    await db.pool.query(
      "SELECT id, state, blocked_reason FROM tickets ORDER BY id",
    )
  ).rows.map(
    (r) =>
      `${r.id}:${r.state}${r.blocked_reason ? `/${r.blocked_reason}` : ""}`,
  );

const GAVE_UP = {
  outcome: "agent-gave-up",
  run: {
    output: {
      status: "cannot-proceed",
      blockedReason: "agent-gave-up",
      detail: "needs a decision",
    },
  },
};
const DONE = { outcome: "done" };

describe("retry", () => {
  async function blockedAfterFixes() {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "boom" } },
    });
    await stage("gate-fix", DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "still boom" } },
    });
    expect(await row(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "gate-failed",
      fix_counts: { "gate-fix": 1, "review-fix": 0, "merge-fix": 0 },
    });
    return specId;
  }

  it("continue keeps the branch, clears the fix counts and the review, and the ticket is queued again", async () => {
    await blockedAfterFixes();
    const result = await call("POST", "/tickets/1/retry", { mode: "continue" });
    expect(result).toMatchObject({ status: 200, body: { state: "queued" } }); // pending, and the scheduler took it
    expect(await row(1)).toMatchObject({
      state: "queued",
      blocked_reason: null,
      reviewed: false,
      restart: false,
      fix_counts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
    });
    // a new implement job, under a new idempotency key
    const keys = await db.pool.query(
      "SELECT idempotency_key FROM jobs WHERE payload->>'stage' = 'implement' ORDER BY id",
    );
    expect(keys.rows.map((r) => r.idempotency_key)).toEqual([
      "T-1:1:implement:1",
      "T-1:1:implement:2",
    ]);
  });

  it("restart asks the next implement run to start from the integration branch, once", async () => {
    await blockedAfterFixes();
    await call("POST", "/tickets/1/retry", { mode: "restart" });
    expect((await row(1)).restart).toBe(true);
    const job = (await worker.claim()).body.job as Claimed;
    const bundle = await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(bundle.ticket.restart).toBe(true);
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect((await row(1)).restart).toBe(false); // the restart has been carried out
  });

  it("only a blocked ticket can be retried", async () => {
    await runningSpec([ticket("a")]);
    const result = await call("POST", "/tickets/1/retry", { mode: "continue" });
    expect(result.status).toBe(409);
    expect(
      (await call("POST", "/tickets/99/retry", { mode: "continue" })).status,
    ).toBe(404);
    expect(
      (await call("POST", "/tickets/1/retry", { mode: "later" })).status,
    ).toBe(400);
  });

  it("starts the tickets behind a retried one when it finishes, like any other", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/retry", { mode: "continue" });
    await stage("implement", DONE);
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "h" });
    expect(await states()).toEqual(["1:done", "2:queued"]);
  });
});

describe("approve-protected", () => {
  async function blockedByProtectedPath() {
    await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", {
      outcome: "protected-path-changed",
      run: {
        output: { unapproved: [".github/workflows/ci.yml", "tsconfig.json"] },
      },
    });
    expect(await row(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "protected-path-changed",
    });
  }

  it("adds the paths the gate found to the ticket's approved ones and goes on from the gate", async () => {
    await blockedByProtectedPath();
    const result = await call("POST", "/tickets/1/approve-protected");
    expect(result).toMatchObject({
      status: 200,
      body: { approved: [".github/workflows/ci.yml", "tsconfig.json"] },
    });
    expect(await row(1)).toMatchObject({
      state: "running",
      blocked_reason: null,
      allowed_protected_paths: [".github/workflows/ci.yml", "tsconfig.json"],
    });
    const next = (await worker.claim()).body.job as Claimed;
    expect(next.payload.stage).toBe("gate"); // not implement: the work is kept
    const bundle = await fetch(
      `${api.url}/worker/jobs/${next.id}/bundle?workerId=w1&attempt=${next.attempt}`,
    ).then((r) => r.json());
    expect(bundle.allowedProtectedPaths).toEqual([
      ".github/workflows/ci.yml",
      "tsconfig.json",
    ]);
  });

  it("carries on to done afterwards", async () => {
    await blockedByProtectedPath();
    await call("POST", "/tickets/1/approve-protected");
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "h" });
    expect(await states()).toEqual(["1:done"]);
  });

  it("is for protected-path-changed only", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    const result = await call("POST", "/tickets/1/approve-protected");
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/protected-path-changed/);
    expect((await row(1)).state).toBe("blocked");
    expect((await call("POST", "/tickets/99/approve-protected")).status).toBe(
      404,
    );
  });

  it("refuses when the gate left no record of the paths", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", { outcome: "protected-path-changed" });
    expect((await call("POST", "/tickets/1/approve-protected")).status).toBe(
      409,
    );
  });
});

describe("cancel", () => {
  // a -> b -> c, and d on its own
  const chain = () => [
    ticket("a"),
    ticket("b", { blocked_by: ["a"] }),
    ticket("c", { blocked_by: ["b"] }),
    ticket("d"),
  ];

  it("puts the tickets that waited for it into blocked (upstream-cancelled) and leaves the rest alone", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP); // a blocked
    const result = await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(result.body).toEqual({
      cancelled: ["T-1"],
      blocked: ["T-2"],
      skipped: [],
    });
    expect(await states()).toEqual([
      "1:cancelled",
      "2:blocked/upstream-cancelled",
      "3:pending",
      "4:queued",
    ]);
  });

  it("with cascade cancels everything below it", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP);
    const result = await call("POST", "/tickets/1/cancel", { cascade: true });
    expect(result.body).toEqual({
      cancelled: ["T-1", "T-2", "T-3"],
      blocked: [],
      skipped: [],
    });
    expect(await states()).toEqual([
      "1:cancelled",
      "2:cancelled",
      "3:cancelled",
      "4:queued",
    ]);
  });

  it("a ticket put into blocked by a cancel can then be cancelled itself, or retried", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(
      (await call("POST", "/tickets/2/cancel", { cascade: false })).body,
    ).toMatchObject({ cancelled: ["T-2"], blocked: ["T-3"] });
    expect(
      (await call("POST", "/tickets/3/retry", { mode: "continue" })).body.state,
    ).toBe("pending"); // waits for a ticket that is gone
  });

  it("a pending ticket can be cancelled before it ever started", async () => {
    await runningSpec(chain());
    expect(
      (await call("POST", "/tickets/3/cancel", { cascade: false })).status,
    ).toBe(200);
    expect((await states())[2]).toBe("3:cancelled");
  });

  it("refuses a ticket that is under way or finished", async () => {
    await runningSpec(chain());
    expect(
      (await call("POST", "/tickets/1/cancel", { cascade: false })).status,
    ).toBe(409); // queued
    await stage("implement", DONE);
    expect(
      (await call("POST", "/tickets/1/cancel", { cascade: true })).status,
    ).toBe(409); // running
    expect(
      (await call("POST", "/tickets/99/cancel", { cascade: false })).status,
    ).toBe(404);
  });

  it("frees a slot, so a waiting ticket can start", async () => {
    await runningSpec([ticket("a"), ticket("b"), ticket("c")], {
      limits: { projectConcurrency: 1, repoConcurrency: 1 },
    });
    await stage("implement", GAVE_UP); // a blocked, b is now running room
    // b already took the slot; cancel a, and c still waits for b
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await states()).toEqual(["1:cancelled", "2:queued", "3:pending"]);
  });

  it("leaves a downstream ticket that is already under way, and says so", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 2"); // cannot normally happen: a stand-in
    const result = await call("POST", "/tickets/1/cancel", { cascade: true });
    expect(result.body).toEqual({
      cancelled: ["T-1"],
      blocked: [],
      skipped: ["T-2"],
    });
  });
});

describe("what a person sees", () => {
  it("lists blocked tickets with a brief, and paused specs with the reason", async () => {
    const specId = await runningSpec([ticket("a"), ticket("b")]);
    await stage("implement", GAVE_UP);
    await stage("implement", GAVE_UP);
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, duration_ms) VALUES ($1, 1, 'implement', $2)",
      [specId, 12 * 3600 * 1000],
    );
    // retrying b makes the scheduler look at the spec again, and the spec has used up its agent time
    await call("POST", "/tickets/2/retry", { mode: "continue" });
    const queue = await call("GET", "/blocked");
    expect(queue.status).toBe(200);
    expect(
      queue.body.tickets.map((t: Json) => `${t.displayId}:${t.state}`),
    ).toEqual(["T-1:blocked"]);
    expect(queue.body.tickets[0]).toMatchObject({
      displayId: "T-1",
      specDisplayId: "S-1",
      state: "blocked",
      blockedReason: "agent-gave-up",
      repo: "backend",
      brief: {
        stage: "implement",
        result: "agent-gave-up",
        output: { detail: "needs a decision" },
      },
    });
    expect(queue.body.tickets[0].brief.logPath).toMatch(/^\/runs\/\d+\/logs$/);
    expect(queue.body.specs).toEqual([
      {
        id: specId,
        displayId: "S-1",
        title: "Spec",
        reason: "the agent time limit of the spec was reached",
      },
    ]);
  });

  it("is empty when nothing waits", async () => {
    await runningSpec([ticket("a")]);
    expect((await call("GET", "/blocked")).body).toEqual({
      tickets: [],
      specs: [],
    });
  });

  it("shows a ticket with its runs, findings, gate results and neighbours", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", {
      outcome: "done",
      run: { headSha: "abc", branch: "agent/T-1" },
    });
    await stage("gate", {
      outcome: "passed",
      run: { headSha: "abc" },
      gate: {
        commitSha: "abc",
        configSha: "cfg",
        commandResults: [{ name: "test", exitCode: 0 }],
        testsTotal: 5,
        testsSkipped: 0,
      },
    });
    await stage("review", {
      outcome: "pass",
      findings: [{ kind: "suggestion", body: "rename x" }],
    });
    const view = await call("GET", "/tickets/1");
    expect(view.status).toBe(200);
    expect(view.body.ticket).toMatchObject({
      displayId: "T-1",
      state: "merging",
      acceptanceCriteria: ["it works"],
      reviewed: true,
      brief: null,
    });
    expect(view.body.downstream).toEqual([
      { id: 2, displayId: "T-2", kind: "blocks", state: "pending" },
    ]);
    expect(view.body.upstream).toEqual([]);
    expect(
      view.body.runs.map((r: Json) => `${r.displayId}:${r.stage}:${r.result}`),
    ).toEqual(["R-1:implement:done", "R-2:gate:passed", "R-3:review:pass"]);
    expect(view.body.findings).toEqual([
      {
        id: 1,
        runId: 3,
        kind: "suggestion",
        body: "rename x",
        resolution: "acceptance-pack",
      },
    ]);
    expect(view.body.gateResults).toEqual([
      {
        commitSha: "abc",
        configSha: "cfg",
        commandResults: [{ name: "test", exitCode: 0 }],
        testsTotal: 5,
        testsSkipped: 0,
      },
    ]);
    expect((await call("GET", "/tickets/2")).body.upstream).toEqual([
      { id: 1, displayId: "T-1", kind: "blocks", state: "merging" },
    ]);
    expect((await call("GET", "/tickets/99")).status).toBe(404);
  });

  it("shows a spec with its tickets, edges, integration branch and import warnings", async () => {
    const specId = await runningSpec([
      ticket("a", { modules: ["src/x/**"] }),
      ticket("b", { modules: ["src/x/y.ts"] }),
      ticket("c", { blocked_by: ["a"] }),
    ]);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.status).toBe(200);
    expect(view.body.spec).toMatchObject({
      displayId: "S-1",
      slug: "s",
      state: "running",
      pauseReason: null,
    });
    expect(view.body.spec.integrationBranches).toEqual([
      { repoId: 1, branch: "spec/s" },
    ]);
    expect(view.body.spec.warnings).toHaveLength(1); // a and b overlap without a path between them
    expect(
      view.body.tickets.map((t: Json) => `${t.displayId}:${t.state}`),
    ).toEqual(["T-1:queued", "T-2:queued", "T-3:pending"]);
    expect(view.body.edges).toEqual([
      { from: "T-1", to: "T-3", kind: "blocks" },
    ]);
    expect((await call("GET", "/specs/99")).status).toBe(404);
  });

  it("a spec view carries the brief of every blocked ticket", async () => {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.tickets[0].brief).toMatchObject({
      stage: "implement",
      result: "agent-gave-up",
    });
  });
});
