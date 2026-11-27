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

const CUT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BLOB = "cccccccccccccccccccccccccccccccccccccccc";
const NEW_CUT = "dddddddddddddddddddddddddddddddddddddddd";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;
let notices: { title: string; body: string }[];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  clock = new FakeClock();
  notices = [];
  api = await listen(
    testApp({
      pool: db.pool,
      clock: clock.now,
      schedule: clock.schedule,
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
  return { status: response.status, body: await response.json() };
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

async function draftSpec(options: {
  repos?: string[];
  tickets?: Record<string, unknown>[];
  cutSha?: string | null;
  planningRepo?: string;
}) {
  const repoNames = options.repos ?? ["backend"];
  const project = await call("POST", "/projects", { name: "shop" });
  const projectId = (project.body as { id: number }).id;
  for (const name of repoNames) {
    await call("POST", `/projects/${projectId}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  }
  if (options.cutSha) {
    await db.pool.query("UPDATE repos SET default_sha = $1", [options.cutSha]);
  }
  const spec = await call("POST", "/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
    ...(options.planningRepo ? { planningRepo: options.planningRepo } : {}),
  });
  const specId = (spec.body as { id: number }).id;
  const tickets = options.tickets ?? [
    ticket("a"),
    ...(repoNames.includes("frontend")
      ? [ticket("b", { repo: "frontend" })]
      : []),
  ];
  const imported = await call(
    "POST",
    `/specs/${specId}/tickets/import`,
    importBody(specId, { tickets }),
  );
  expect(imported.status).toBe(200);
  return { projectId, specId };
}

async function baselineJobs() {
  const { rows } = await db.pool.query<{
    id: number;
    type: string;
    state: string;
    payload: { specId: number; repoId: number; sha?: string };
    idempotency_key: string;
  }>(
    "SELECT id, type, state, payload, idempotency_key FROM jobs WHERE type = 'baseline-gate' ORDER BY id",
  );
  return rows;
}

async function completeBaseline(
  worker: FakeWorker,
  result: Record<string, unknown>,
) {
  const claimed = await worker.claim({ takeSlot: false });
  const job = claimed.body.job;
  expect(job?.type).toBe("baseline-gate");
  if (!job) throw new Error("no baseline-gate job");
  return worker.complete(job.id, job.attempt, {
    stage: "baseline-gate",
    ...result,
  });
}

describe("baseline gate after confirm", () => {
  it("enqueues a baseline-gate job per repo after confirm and does not start tickets", async () => {
    const { specId } = await draftSpec({
      repos: ["backend", "frontend"],
      cutSha: CUT,
    });
    const confirmed = await call("POST", `/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      state: "running",
      enqueued: [],
    });
    expect(await baselineJobs()).toMatchObject([
      {
        type: "baseline-gate",
        state: "queued",
        payload: { specId, repoId: 1, sha: CUT },
      },
      {
        type: "baseline-gate",
        state: "queued",
        payload: { specId, repoId: 2, sha: CUT },
      },
    ]);
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["pending", "pending"]);
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "running",
      pause_reason: null,
      baseline_gate_state: "pending",
    });
  });

  it("starts tickets once every repo's baseline gate has passed", async () => {
    const { specId } = await draftSpec({
      repos: ["backend", "frontend"],
      cutSha: CUT,
    });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, { pass: true, reasons: [] });
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["pending", "pending"]);
    await completeBaseline(worker, { pass: true, reasons: [] });
    expect(
      (
        await db.pool.query(
          "SELECT state, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({ state: "running", baseline_gate_state: "done" });
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["queued", "queued"]);
    expect(
      (
        await db.pool.query(
          "SELECT type FROM jobs WHERE type = 'agent-run' ORDER BY id",
        )
      ).rows,
    ).toHaveLength(2);
  });

  it("pauses the spec when any repo's baseline gate fails, with the waiting queue and a notify event", async () => {
    const { specId } = await draftSpec({
      repos: ["backend", "frontend"],
      cutSha: CUT,
    });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, { pass: true, reasons: [] });
    await completeBaseline(worker, {
      pass: false,
      reasons: ["test failed (exit 1)"],
      failingTests: ["orders exports"],
      log: "AssertionError: expected 1",
    });
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "paused",
      pause_reason: "baseline-gate-failed",
      baseline_gate_state: "pending",
    });
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["pending", "pending"]);
    expect(
      (await db.pool.query("SELECT type FROM jobs WHERE type = 'agent-run'"))
        .rows,
    ).toEqual([]);

    const blocked = await call("GET", "/blocked");
    expect(blocked.status).toBe(200);
    expect(blocked.body.specs).toMatchObject([
      {
        displayId: "S-1",
        title: "Order export",
        reason: "baseline-gate-failed",
        baselineFailures: [
          {
            repo: "frontend",
            reasons: ["test failed (exit 1)"],
            failingTests: ["orders exports"],
            log: "AssertionError: expected 1",
          },
        ],
      },
    ]);
    expect(blocked.body.specs[0].baselineFailures[0].run).toMatchObject({
      displayId: expect.stringMatching(/^R-/),
    });

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.pauseReason).toBe("baseline-gate-failed");
    expect(view.body.spec.baselineFailures).toMatchObject([
      {
        repo: "frontend",
        reasons: ["test failed (exit 1)"],
        failingTests: ["orders exports"],
      },
    ]);

    clock.advanceSeconds(30);
    await clock.flush();
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "需求已暂停",
          body: expect.stringContaining("基线门禁失败"),
        }),
      ]),
    );
  });

  it("continue-baseline resumes, starts tickets, and records a human action", async () => {
    const { specId } = await draftSpec({ cutSha: CUT });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, {
      pass: false,
      reasons: ["test failed (exit 1)"],
    });
    const continued = await call("POST", `/specs/${specId}/continue-baseline`);
    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({ state: "running" });
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "running",
      pause_reason: null,
      baseline_gate_state: "waived",
    });
    expect(
      (await db.pool.query("SELECT state FROM tickets")).rows[0].state,
    ).toBe("queued");
    expect(
      (
        await db.pool.query(
          "SELECT type, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          action: "continue-baseline",
        }),
      ]),
    );

    const again = await call("POST", `/specs/${specId}/continue-baseline`);
    expect(again.status).toBe(409);
    expect((await call("POST", "/specs/99/continue-baseline")).status).toBe(
      404,
    );
  });

  it("appending tickets does not enqueue baseline-gate jobs", async () => {
    const { specId } = await draftSpec({ cutSha: CUT });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, { pass: true, reasons: [] });
    const before = (await baselineJobs()).length;
    const appended = await call(
      "POST",
      `/specs/${specId}/tickets/import?append=true`,
      importBody(specId, {
        tickets: [ticket("extra")],
      }),
    );
    expect(appended.status).toBe(200);
    expect(await baselineJobs()).toHaveLength(before);
  });

  it("a stored baseline-gate result does not change a ticket gate lookup", async () => {
    const { specId } = await draftSpec({ cutSha: CUT });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, {
      pass: true,
      reasons: [],
      gate: {
        commitSha: CUT,
        configSha: CUT,
        treeSha: TREE,
        configBlob: BLOB,
        commandResults: [{ name: "test", exitCode: 0, ms: 1 }],
        testsTotal: 3,
        testsSkipped: 0,
      },
    });
    expect(
      (await db.pool.query("SELECT kind, tests_total FROM gate_results")).rows,
    ).toEqual([{ kind: "baseline-gate", tests_total: 3 }]);

    const implement = await worker.claim();
    expect(implement.body.job?.payload).toMatchObject({
      stage: "implement",
      ticketId: 1,
    });
    const implementJob = implement.body.job;
    if (!implementJob) throw new Error("no implement job");
    await worker.complete(implementJob.id, implementJob.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const next = await worker.claim();
    expect(next.body.job?.payload).toMatchObject({ stage: "gate" });
    const gateJob = next.body.job;
    if (!gateJob) throw new Error("no gate job");
    const lookup = await call(
      "POST",
      `/worker/jobs/${gateJob.id}/gate-result`,
      {
        workerId: worker.id,
        attempt: gateJob.attempt,
        tree: TREE,
        configBlob: BLOB,
      },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.body.gate).toBeNull();
  });

  it("waits for the planning commit before enqueueing baseline gates", async () => {
    const { specId } = await draftSpec({
      cutSha: CUT,
      planningRepo: "backend",
    });
    const confirmed = await call("POST", `/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(await baselineJobs()).toEqual([]);
    const worker = new FakeWorker(api.url, "w1");
    const planning = await worker.claim({ takeSlot: false });
    expect(planning.body.job?.type).toBe("planning-commit");
    const planningJob = planning.body.job;
    if (!planningJob) throw new Error("no planning-commit job");
    await worker.complete(planningJob.id, planningJob.attempt, {
      stage: "planning-commit",
      outcome: "unchanged",
      sha: CUT,
    });
    expect(await baselineJobs()).toMatchObject([
      { type: "baseline-gate", payload: { specId, repoId: 1, sha: CUT } },
    ]);
    expect(
      (await db.pool.query("SELECT state FROM tickets")).rows[0].state,
    ).toBe("pending");
  });

  it("does not enqueue baseline gates when the cut SHA is unknown", async () => {
    const { specId } = await draftSpec({});
    const confirmed = await call("POST", `/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(await baselineJobs()).toEqual([]);
    expect(confirmed.body.enqueued).toMatchObject([{ ticketId: 1 }]);
  });
});

describe("baseline gate recheck", () => {
  async function pauseOnBaselineFail(repos = ["backend"]) {
    const { specId } = await draftSpec({ repos, cutSha: CUT });
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    for (let i = 0; i < repos.length; i++) {
      await completeBaseline(worker, {
        pass: false,
        reasons: ["test failed (exit 1)"],
        failingTests: ["orders exports"],
        log: "AssertionError: expected 1",
      });
    }
    return { specId, worker };
  }

  it("recheck-baseline recuts stored SHAs, enqueues new gates, stays paused, and records a human action", async () => {
    const { specId, worker } = await pauseOnBaselineFail([
      "backend",
      "frontend",
    ]);
    await db.pool.query("UPDATE repos SET default_sha = $1", [NEW_CUT]);
    const before = (await baselineJobs()).length;

    const recut = await call("POST", `/specs/${specId}/recheck-baseline`);
    expect(recut.status).toBe(200);
    expect(recut.body).toMatchObject({ state: "paused" });
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "paused",
      pause_reason: "baseline-gate-failed",
      baseline_gate_state: "pending",
    });
    expect(
      (
        await db.pool.query(
          "SELECT integration_branches FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0].integration_branches,
    ).toEqual([
      expect.objectContaining({ repoId: 1, mainSha: NEW_CUT }),
      expect.objectContaining({ repoId: 2, mainSha: NEW_CUT }),
    ]);
    const jobs = await baselineJobs();
    expect(jobs).toHaveLength(before + 2);
    expect(jobs.slice(-2)).toMatchObject([
      {
        type: "baseline-gate",
        state: "queued",
        payload: { specId, repoId: 1, sha: NEW_CUT, recut: true },
      },
      {
        type: "baseline-gate",
        state: "queued",
        payload: { specId, repoId: 2, sha: NEW_CUT, recut: true },
      },
    ]);
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["pending", "pending"]);
    const claimed = await worker.claim({ takeSlot: false });
    const job = claimed.body.job;
    expect(job?.type).toBe("baseline-gate");
    if (!job) throw new Error("no baseline-gate job");
    const task = await call(
      "GET",
      `/worker/jobs/${job.id}/baseline-task?workerId=${worker.id}&attempt=${job.attempt}`,
    );
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({
      specId,
      sha: NEW_CUT,
      recut: { branch: expect.stringMatching(/^spec\//) },
    });
    expect(
      (
        await db.pool.query(
          "SELECT type, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          action: "recheck-baseline",
        }),
      ]),
    );
    expect(
      (
        await db.pool.query(
          "SELECT data->>'action' AS action FROM events WHERE type = 'action'",
        )
      ).rows.some((row) => row.action === "retry"),
    ).toBe(false);
  });

  it("passing every recut baseline gate resumes the spec and starts tickets from the new cut", async () => {
    const { specId, worker } = await pauseOnBaselineFail([
      "backend",
      "frontend",
    ]);
    await db.pool.query("UPDATE repos SET default_sha = $1", [NEW_CUT]);
    await call("POST", `/specs/${specId}/recheck-baseline`);
    await completeBaseline(worker, { pass: true, reasons: [] });
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["pending", "pending"]);
    await completeBaseline(worker, { pass: true, reasons: [] });
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "running",
      pause_reason: null,
      baseline_gate_state: "done",
    });
    expect(
      (await db.pool.query("SELECT state FROM tickets ORDER BY id")).rows.map(
        (row) => row.state,
      ),
    ).toEqual(["queued", "queued"]);
    expect(
      (
        await db.pool.query(
          "SELECT type FROM jobs WHERE type = 'agent-run' ORDER BY id",
        )
      ).rows,
    ).toHaveLength(2);
  });

  it("keeps the spec paused when a recut baseline gate still fails, and shows the new failing tests", async () => {
    const { specId, worker } = await pauseOnBaselineFail();
    await db.pool.query("UPDATE repos SET default_sha = $1", [NEW_CUT]);
    await call("POST", `/specs/${specId}/recheck-baseline`);
    await completeBaseline(worker, {
      pass: false,
      reasons: ["test failed (exit 1)"],
      failingTests: ["checkout totals"],
      log: "AssertionError: expected 2",
    });
    expect(
      (
        await db.pool.query(
          "SELECT state, pause_reason, baseline_gate_state FROM specs WHERE id = $1",
          [specId],
        )
      ).rows[0],
    ).toEqual({
      state: "paused",
      pause_reason: "baseline-gate-failed",
      baseline_gate_state: "pending",
    });
    expect(
      (await db.pool.query("SELECT state FROM tickets")).rows[0].state,
    ).toBe("pending");

    const blocked = await call("GET", "/blocked");
    expect(blocked.body.specs).toMatchObject([
      {
        displayId: "S-1",
        reason: "baseline-gate-failed",
        baselineFailures: [
          {
            repo: "backend",
            reasons: ["test failed (exit 1)"],
            failingTests: ["checkout totals"],
            log: "AssertionError: expected 2",
          },
        ],
      },
    ]);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.baselineFailures).toMatchObject([
      {
        repo: "backend",
        failingTests: ["checkout totals"],
      },
    ]);
  });

  it("requeues a failed recut baseline-gate job still as a recut of the new cut", async () => {
    const { specId, worker } = await pauseOnBaselineFail();
    await db.pool.query("UPDATE repos SET default_sha = $1", [NEW_CUT]);
    await call("POST", `/specs/${specId}/recheck-baseline`);
    const claimed = await worker.claim({ takeSlot: false });
    const job = claimed.body.job;
    expect(job?.type).toBe("baseline-gate");
    if (!job) throw new Error("no baseline-gate job");
    await worker.fail(job.id, job.attempt, "could not recut");
    const queued = (await baselineJobs()).filter(
      (row) => row.state === "queued",
    );
    expect(queued.at(-1)?.payload).toMatchObject({
      specId,
      repoId: 1,
      sha: NEW_CUT,
      recut: true,
    });
  });

  it("refuses recheck-baseline unless the spec is paused by baseline-gate-failed", async () => {
    const { specId } = await draftSpec({ cutSha: CUT });
    expect(
      (await call("POST", `/specs/${specId}/recheck-baseline`)).status,
    ).toBe(409);
    await call("POST", `/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1");
    await completeBaseline(worker, {
      pass: false,
      reasons: ["test failed (exit 1)"],
    });
    const continued = await call("POST", `/specs/${specId}/continue-baseline`);
    expect(continued.status).toBe(200);
    expect(
      (await call("POST", `/specs/${specId}/recheck-baseline`)).status,
    ).toBe(409);
    expect((await call("POST", "/specs/99/recheck-baseline")).status).toBe(404);
  });
});
