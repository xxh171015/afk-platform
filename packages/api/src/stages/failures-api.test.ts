import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
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
  db = await createTestDatabase();
  await migrate(db.pool);
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
const state = async (id = 1) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const keys = async () =>
  (
    await db.pool.query(
      "SELECT idempotency_key, state FROM jobs WHERE type <> 'host-sync' ORDER BY id",
    )
  ).rows;

async function failNext(error = "docker daemon not running") {
  const job = (await claim()) as Claimed;
  const reply = await worker.fail(job.id, job.attempt, error);
  expect(reply.status).toBe(200);
  return job;
}

describe("a job the worker could not carry out", () => {
  it("still requeues a network error, and blocks only after the third failure", async () => {
    await runningSpec([ticket("a")]);
    await failNext(
      "fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com",
    );
    expect((await state()).state).toBe("running");
    expect((await keys()).map((k) => k.state)).toEqual(["failed", "queued"]);
    await failNext(
      "Failed to connect to github.com port 443: Connection timed out",
    );
    expect((await state()).state).toBe("running");
    await failNext(
      "fatal: unable to access: Failed to connect to github.com port 443 after 135002 ms: Couldn't connect to server",
    );
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    expect((await keys()).map((k) => k.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(await claim()).toBeNull();
  });

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
    // the time it ran counts towards the spec's agent time, however short it was
    const timed = await db.pool.query(
      "SELECT duration_ms FROM runs ORDER BY id LIMIT 1",
    );
    expect(timed.rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    const log = await fetch(`${api.url}/runs/1/logs`).then((r) => r.json());
    expect(log.finished).toBe(true);
    // the second attempt gets a Run of its own
    await claim();
    expect(
      Number((await db.pool.query("SELECT count(*) FROM runs")).rows[0].count),
    ).toBe(2);
  });

  it.each([
    [
      "a Cursor auth error",
      "ActionRequiredError: Unauthorized request",
      "Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试",
    ],
    [
      "a spent Cursor quota",
      "Error: quota exceeded: usage limit reached",
      "Cursor 额度用完，充值或换模型后再试",
    ],
  ] as const)(
    "pauses every agent job on %s instead of blocking: the job waits in the queue with the human brief",
    async (_kind, error, brief) => {
      await runningSpec([ticket("a")]);
      await failNext(error);
      expect(await state()).toEqual({ state: "running", blocked_reason: null });
      expect((await keys()).map((k) => k.state)).toEqual(["queued"]);
      expect(await claim()).toBeNull(); // agents are paused
      const run = await db.pool.query(
        "SELECT result, output->>'error' AS error FROM runs WHERE ticket_id = 1",
      );
      expect(run.rows).toEqual([
        { result: "provider-unavailable", error: brief },
      ]);
      expect((await call("GET", "/blocked")).body.tickets).toEqual([]);
    },
  );

  it.each([
    [
      "an invalid model name",
      "Error: unknown model 'claude-code'",
      "模型名无效，检查项目的默认模型或 AFK_MODEL",
    ],
    [
      "an integration image that would not build",
      "docker build of backend (backend) failed (exit 1):\nERROR: failed to solve",
      "联调镜像构建失败，修好 Dockerfile 或基础镜像后再试",
    ],
  ] as const)(
    "blocks once on %s, as an outside service, and does not requeue",
    async (_kind, error, brief) => {
      await runningSpec([ticket("a")]);
      await failNext(error);
      expect(await state()).toEqual({
        state: "blocked",
        blocked_reason: "job-failed",
      });
      expect((await keys()).map((k) => k.state)).toEqual(["failed"]);
      expect(await claim()).toBeNull();
      const queue = await call("GET", "/blocked");
      expect(queue.body.tickets[0]).toMatchObject({
        blockedReason: "job-failed",
        failureSource: "external",
        brief: { output: { error: brief } },
      });
    },
  );

  it("takes the ticket over at once as branch-moved on a non-fast-forward, without a second job", async () => {
    await runningSpec([ticket("a")]);
    await failNext(
      "! [rejected] agent/abc123/T-1 -> agent/abc123/T-1 (non-fast-forward)",
    );
    expect(await state()).toEqual({
      state: "taken-over",
      blocked_reason: null,
    });
    expect((await keys()).map((k) => k.state)).toEqual(["failed"]);
    expect(await claim()).toBeNull();
    expect((await call("GET", "/blocked")).body.tickets).toEqual([]);
    const detail = await call("GET", "/tickets/1");
    const last = detail.body.runs.at(-1);
    const run = await call("GET", `/runs/${last.id}`);
    expect(run.body.output.error).toContain("运行期间票分支被推过了");
    const events = await db.pool.query<{
      type: string;
      to_state: string | null;
      source: string | null;
      data: { action?: string };
    }>(
      `SELECT type, to_state, source, data FROM events
       WHERE ticket_id = 1 AND type IN ('ticket', 'action', 'job')
       ORDER BY id`,
    );
    expect(events.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "job",
          to_state: "failed",
          source: "worker",
        }),
        expect.objectContaining({
          type: "ticket",
          to_state: "taken-over",
          source: "worker",
        }),
        expect.objectContaining({
          type: "action",
          source: "worker",
          data: expect.objectContaining({ action: "takeover" }),
        }),
      ]),
    );
  });

  it("blocks at once as job-failed on a protected branch or missing permission, with a host brief", async () => {
    await runningSpec([ticket("a")]);
    await failNext(
      "remote: Permission to shop/backend.git denied to afk-platform[bot]",
    );
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    expect((await keys()).map((k) => k.state)).toEqual(["failed"]);
    expect(await claim()).toBeNull();
    const queue = await call("GET", "/blocked");
    expect(queue.body.tickets[0]).toMatchObject({
      blockedReason: "job-failed",
      failureSource: "platform",
    });
    expect(queue.body.tickets[0].brief.output.error).toContain("代码托管");
    expect(queue.body.tickets[0].brief.output.error).not.toContain(
      "CURSOR_API_KEY",
    );
  });

  it("blocks the ticket at once with sandbox-oom when the container was OOMKilled, as a platform problem", async () => {
    await runningSpec([ticket("a")]);
    await failNext("sandbox-oom: container OOMKilled");
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "sandbox-oom",
    });
    expect((await keys()).map((k) => k.state)).toEqual(["failed"]);
    expect(await claim()).toBeNull();
    const queue = await call("GET", "/blocked");
    expect(queue.body.tickets[0]).toMatchObject({
      blockedReason: "sandbox-oom",
      failureSource: "platform",
    });
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

  it("gives a ticket a fresh three tries after a person has retried it, instead of blocking it at the first failure", async () => {
    await runningSpec([ticket("a")]);
    for (let i = 0; i < 3; i++) await failNext();
    expect((await state()).state).toBe("blocked");
    await call("POST", "/tickets/1/retry", { mode: "continue" });

    await failNext("again"); // the fourth failure overall, the first since the retry
    expect((await state()).state).toBe("running");
    await failNext("and again");
    expect((await state()).state).toBe("running");
    await failNext("and a third time");
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
  });

  it("gives a ticket approved for its protected paths a fresh start too", async () => {
    await runningSpec([ticket("a")]);
    const impl = (await claim()) as Claimed;
    await worker.complete(impl.id, impl.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const gate = (await claim()) as Claimed;
    await worker.complete(gate.id, gate.attempt, {
      stage: "gate",
      outcome: "protected-path-changed",
      run: { output: { unapproved: [".github/ci.yml"] } },
    });
    await call("POST", "/tickets/1/approve-protected");
    await failNext();
    await failNext();
    expect((await state()).state).toBe("running"); // two of three
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
    await call(
      "POST",
      `/specs/${spec.body.id}/tickets/import`,
      importBody(spec.body.id, {
        tickets: [ticket("a"), ticket("b")],
      }),
    );
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
    await other.claim(); // the lost lease failed the job; w2 takes the stage again
    expect((await worker.fail(job.id, job.attempt, "zombie")).status).toBe(409);
    expect((await keys()).map((k) => k.state)).toEqual(["failed", "running"]);
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

describe("a lease that ran out", () => {
  // The worker holding the job died, hung, or could not reach the API: nobody renewed the lease.
  async function loseLease() {
    const job = (await claim()) as Claimed;
    clock.advanceSeconds(121);
    return job;
  }

  it("counts as a failure of the stage: queued again under a new key, and the ticket stays where it was", async () => {
    await runningSpec([ticket("a")]);
    await loseLease();
    const again = await claim();
    expect(again?.payload.stage).toBe("implement");
    expect(await keys()).toEqual([
      { idempotency_key: "T-1:1:implement:1", state: "failed" },
      { idempotency_key: "T-1:1:implement:2", state: "running" },
    ]);
    expect((await state()).state).toBe("running");
  });

  it("blocks the ticket with job-failed at the third, instead of handing the job out for ever", async () => {
    await runningSpec([ticket("a")]);
    await loseLease();
    await loseLease();
    expect((await state()).state).toBe("running");
    await loseLease();
    expect(await claim()).toBeNull(); // the third lost lease is seen here, and nothing is queued again
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    const queue = await call("GET", "/blocked");
    expect(queue.body.tickets[0]).toMatchObject({
      blockedReason: "job-failed",
      brief: {
        stage: "implement",
        result: "job-failed",
        output: { error: expect.stringContaining("lease-expired") },
      },
    });
  });

  it("adds up with the failures the worker reports", async () => {
    await runningSpec([ticket("a")]);
    await failNext("docker daemon not running");
    await loseLease();
    await failNext("docker daemon not running");
    expect(await state()).toEqual({
      state: "blocked",
      blocked_reason: "job-failed",
    });
  });

  it("puts a job that is no stage of anything back in the queue, as before", async () => {
    await db.pool.query(
      "INSERT INTO jobs (type, idempotency_key) VALUES ('open-pr', 'k')",
    );
    const lost = await loseLease();
    const again = (await claim()) as Claimed;
    expect(again).toMatchObject({ id: lost.id, attempt: lost.attempt + 1 });
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

  it("does not block the finalization on a Cursor auth error: agent jobs pause, and the step waits in the queue", async () => {
    await toFinalReview();
    await failNext("ActionRequiredError: Unauthorized request");
    expect(
      (await db.pool.query("SELECT state, blocked_reason FROM finalizations"))
        .rows[0],
    ).toEqual({ state: "active", blocked_reason: null });
    expect(await claim()).toBeNull();
    const paused = await db.pool.query(
      "SELECT agents_pause_reason FROM instance",
    );
    expect(paused.rows[0].agents_pause_reason).toBe(
      "Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试",
    );
    await call("POST", "/agents/resume");
    const again = (await claim()) as Claimed;
    expect(again.payload.stage).toBe("final-review");
  });

  it("blocks the wrap-up at once as branch-moved when final-fix cannot push", async () => {
    await toFinalReview();
    const review = (await claim()) as Claimed;
    await worker.complete(review.id, review.attempt, {
      stage: "final-review",
      outcome: "fix",
      run: {
        output: {
          verdict: "fix",
          mustFix: [{ file: "src/a.ts", line: 1, problem: "rename" }],
          suggestions: [],
        },
      },
      findings: [{ kind: "must-fix", body: "src/a.ts:1 rename" }],
    });
    await failNext(
      "! [rejected] agent/abc123/S-1-final -> agent/abc123/S-1-final (non-fast-forward)",
    );
    expect(
      (await db.pool.query("SELECT state, blocked_reason FROM finalizations"))
        .rows[0],
    ).toEqual({
      state: "blocked",
      blocked_reason: "branch-moved",
    });
    expect(await claim()).toBeNull();
    const queue = await call("GET", "/blocked");
    expect(queue.body.finalizations[0]).toMatchObject({
      blockedReason: "branch-moved",
      failureSource: "spec",
      structuredBrief: { summary: "运行期间票分支被推过了" },
    });
  });

  it("blocks the wrap-up at once with sandbox-oom when the container was OOMKilled, without three failures", async () => {
    await toFinalReview();
    await failNext("sandbox-oom: container OOMKilled");
    expect(
      (await db.pool.query("SELECT state, blocked_reason FROM finalizations"))
        .rows[0],
    ).toEqual({
      state: "blocked",
      blocked_reason: "sandbox-oom",
    });
    expect(await claim()).toBeNull();
    const queue = await call("GET", "/blocked");
    expect(queue.body.finalizations[0]).toMatchObject({
      blockedReason: "sandbox-oom",
      failureSource: "platform",
    });
  });

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

  it("gets three fresh tries after a person runs it again", async () => {
    await toFinalReview();
    for (let i = 0; i < 3; i++) await failNext();
    await call("POST", "/specs/1/final/retry");
    await failNext();
    expect(
      (await db.pool.query("SELECT state FROM finalizations")).rows[0].state,
    ).toBe("active");
    await failNext();
    await failNext();
    expect(
      (await db.pool.query("SELECT state FROM finalizations")).rows[0].state,
    ).toBe("blocked");
  });

  it("can be run again by a person", async () => {
    await toFinalReview();
    for (let i = 0; i < 3; i++) await failNext();
    expect((await call("POST", "/specs/1/final/retry")).status).toBe(200);
    expect((await claim())?.payload.stage).toBe("final-review");
  });
});
