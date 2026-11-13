import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
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
let worker: FakeWorker;
let clock: FakeClock;

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
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:frontend",
    role: "frontend",
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
  payload: { stage: string; ticketId?: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

// A timeout or a missing <result> runs the stage again once, on its own, before a person is asked: for a ticket's
// stages and for a spec's finalization (docs/optimization-plan.md 8.4, spec #311).

const ticketRow = async (id = 1) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const finalization = async () =>
  (await db.pool.query("SELECT state, step, blocked_reason FROM finalizations"))
    .rows[0];

// The next job is claimed and comes back with this outcome.
async function report(
  stage: string,
  outcome: string,
  extra: Record<string, unknown> = {},
) {
  const job = (await claim()) as Claimed;
  expect(job?.payload.stage).toBe(stage);
  const reply = await worker.complete(job.id, job.attempt, {
    stage,
    outcome,
    ...extra,
  });
  expect(reply.status).toBe(200);
  return job;
}

const noteOfRun = async (jobId: number) =>
  (
    await db.pool.query("SELECT retry_note FROM runs WHERE job_id = $1", [
      jobId,
    ])
  ).rows[0]?.retry_note as string | null;

async function autoRetryEvents() {
  const { rows } = await db.pool.query(
    `SELECT type, ticket_id, reason, source, data FROM events
     WHERE (data->>'autoRetry')::boolean ORDER BY id`,
  );
  return rows;
}

async function toFinalReview() {
  await runningSpec([ticket("a")]);
  await report("implement", "done");
  await report("gate", "passed");
  await report("review", "pass");
  await report("merge", "merged", { headSha: "h" });
}

const FIX = {
  run: {
    output: {
      verdict: "fix",
      mustFix: [{ file: "src/a.ts", line: 1, problem: "rename" }],
      suggestions: [],
    },
  },
  findings: [{ kind: "must-fix", body: "src/a.ts:1 rename" }],
};

describe("a ticket's agent stage that timed out or gave no result", () => {
  it("runs implement again once with the platform's note, and blocks on the second timeout", async () => {
    await runningSpec([ticket("a")]);
    await report("implement", "timeout");
    expect(await ticketRow()).toEqual({
      state: "running",
      blocked_reason: null,
    });

    const again = await report("implement", "timeout");
    const note = await noteOfRun(again.id);
    expect(note).toContain("平台自动重试");
    expect(note).toContain("超时");
    expect(await ticketRow()).toEqual({
      state: "blocked",
      blocked_reason: "timeout",
    });
    const queue = (await call("GET", "/blocked")).body;
    expect(queue.tickets[0].structuredBrief.summary).toContain(
      "已自动重试过一次",
    );
  });

  it("does not say a stage was run again when the ticket spent its retry on an earlier one", async () => {
    await runningSpec([ticket("a")]);
    await report("implement", "timeout");
    await report("implement", "done");
    await report("gate", "passed");
    await report("review", "timeout");
    expect(await ticketRow()).toEqual({
      state: "blocked",
      blocked_reason: "timeout",
    });
    const queue = (await call("GET", "/blocked")).body;
    expect(queue.tickets[0].structuredBrief.summary).toBe("超时");
  });

  it("runs review again once after invalid-output, then blocks", async () => {
    await runningSpec([ticket("a")]);
    await report("implement", "done");
    await report("gate", "passed");
    await report("review", "invalid-output");
    expect((await ticketRow()).state).toBe("running");
    const again = await report("review", "invalid-output");
    expect(await noteOfRun(again.id)).toContain("<result>");
    expect(await ticketRow()).toEqual({
      state: "blocked",
      blocked_reason: "invalid-output",
    });
  });

  it.each(["no-commits", "agent-gave-up", "contract-change-needed"])(
    "blocks %s at once, as before",
    async (outcome) => {
      await runningSpec([ticket("a")]);
      await report("implement", outcome);
      expect(await ticketRow()).toEqual({
        state: "blocked",
        blocked_reason: outcome,
      });
      expect(await autoRetryEvents()).toEqual([]);
    },
  );

  it("gives the retry back when a person retries the ticket", async () => {
    await runningSpec([ticket("a")]);
    await report("implement", "timeout");
    await report("implement", "timeout");
    expect((await ticketRow()).state).toBe("blocked");
    await call("POST", "/tickets/1/retry", { mode: "continue" });
    await report("implement", "timeout");
    expect((await ticketRow()).state).toBe("running");
    await report("implement", "timeout");
    expect((await ticketRow()).state).toBe("blocked");
  });

  it("records the retry as an event the timeline shows, without a notice-worthy state change", async () => {
    await runningSpec([ticket("a")]);
    await report("implement", "timeout");
    expect(await autoRetryEvents()).toEqual([
      {
        type: "ticket",
        ticket_id: 1,
        reason: "timeout",
        source: "scheduler",
        data: { autoRetry: true, stage: "implement" },
      },
    ]);
    const spec = (await call("GET", "/specs/1")).body;
    expect(spec.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "auto-retry",
          text: "T-1 implement 超时，已自动重试一次",
          ticketId: 1,
        }),
      ]),
    );
  });
});

describe("a finalization step that timed out or gave no result", () => {
  it("runs final-review again once after a timeout, then blocks the finalization", async () => {
    await toFinalReview();
    await report("final-review", "timeout");
    expect(await finalization()).toEqual({
      state: "active",
      step: "final-review",
      blocked_reason: null,
    });
    const again = await report("final-review", "timeout");
    expect(await noteOfRun(again.id)).toContain("平台自动重试");
    expect(await finalization()).toEqual({
      state: "blocked",
      step: "final-review",
      blocked_reason: "timeout",
    });
    const queue = (await call("GET", "/blocked")).body;
    expect(queue.finalizations[0].structuredBrief.summary).toContain(
      "已自动重试过一次",
    );
    expect(await autoRetryEvents()).toEqual([
      {
        type: "finalization",
        ticket_id: null,
        reason: "timeout",
        source: "scheduler",
        data: { autoRetry: true, stage: "final-review" },
      },
    ]);
  });

  it("runs final-fix again once after invalid-output, then blocks", async () => {
    await toFinalReview();
    await report("final-review", "fix", FIX);
    await report("final-fix", "invalid-output");
    expect((await finalization()).state).toBe("active");
    await report("final-fix", "invalid-output");
    expect(await finalization()).toEqual({
      state: "blocked",
      step: "final-fix",
      blocked_reason: "invalid-output",
    });
  });

  it("gives the retry back when a person runs the finalization again", async () => {
    await toFinalReview();
    await report("final-review", "timeout");
    await report("final-review", "timeout");
    await call("POST", "/specs/1/final/retry", {});
    await report("final-review", "timeout");
    expect((await finalization()).state).toBe("active");
  });

  it("blocks a final-fix with no commits at once", async () => {
    await toFinalReview();
    await report("final-review", "fix", FIX);
    await report("final-fix", "no-commits");
    expect((await finalization()).blocked_reason).toBe("no-commits");
  });

  it("leaves the platform's note for the repo whose step is run again, not for another repo's step", async () => {
    await runningSpec([ticket("a"), ticket("b", { repo: "frontend" })]);
    const done: Record<string, Record<string, unknown>> = {
      implement: { outcome: "done" },
      gate: { outcome: "passed" },
      review: { outcome: "pass" },
      merge: { outcome: "merged", headSha: "h" },
    };
    // both tickets run to their merge; both repos' final-review jobs are then queued
    let job = (await claim()) as Claimed;
    while (job.payload.stage !== "final-review") {
      const outcome = done[job.payload.stage];
      if (!outcome) throw new Error(`unexpected ${job.payload.stage}`);
      await worker.complete(job.id, job.attempt, {
        stage: job.payload.stage,
        ...outcome,
      });
      job = (await claim()) as Claimed;
    }
    const repoOf = (claimed: Claimed) =>
      (claimed.payload as { repoId?: number }).repoId;
    await worker.complete(job.id, job.attempt, {
      stage: "final-review",
      outcome: "timeout",
    });
    const other = (await claim()) as Claimed;
    expect(other.payload.stage).toBe("final-review");
    expect(repoOf(other)).not.toBe(repoOf(job));
    expect(await noteOfRun(other.id)).toBeNull();
    const again = (await claim()) as Claimed;
    expect(repoOf(again)).toBe(repoOf(job));
    expect(await noteOfRun(again.id)).toContain("平台自动重试");
  });

  it("counts the Run that was run again toward the spec's agent time, like any other", async () => {
    await runningSpec([ticket("a")]);
    const tenMinutes = { run: { durationMs: 600_000 } };
    await report("implement", "timeout", tenMinutes);
    await report("implement", "done", tenMinutes);
    // the spec's budget is the sum of its Runs' durations (scheduler.ts agentSecondsUsed)
    const used = await db.pool.query(
      "SELECT sum(duration_ms)::int AS ms FROM runs WHERE spec_id = 1 AND stage <> 'e2e'",
    );
    expect(used.rows[0].ms).toBe(1_200_000);
  });
});
