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

// After a failed e2e an agent diagnoses which repo is at fault, the platform makes a fix ticket there, and the
// integration ticket runs its e2e again once the fix is done: at most two rounds (docs/specs/m2-platform.md「联调」).

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool, clock: new FakeClock().now }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;
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
  return { status: response.status, body: (await response.json()) as Json };
}

async function runningSpec() {
  const created = await post("/projects", { name: "shop" });
  for (const name of ["backend", "frontend"])
    await post(`/projects/${created.body.id}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  const spec = await post("/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  const imported = await post(
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, {
      tickets: [
        {
          key: "e2e",
          repo: "frontend",
          type: "integration",
          title: "Order export e2e",
          modules: ["e2e/**"],
          acceptance: ["the export button downloads a file"],
          environment: ["backend"],
        },
      ],
    }),
  );
  expect(imported.status).toBe(200);
  await post(`/specs/${spec.body.id}/confirm`);
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: { stage: string; ticketId: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

async function stage(
  expected: string,
  result: Record<string, unknown>,
  ticketId?: number,
) {
  const job = await claim();
  expect(job?.payload.stage).toBe(expected);
  if (ticketId !== undefined) expect(job?.payload.ticketId).toBe(ticketId);
  const reply = await worker.complete(
    (job as Claimed).id,
    (job as Claimed).attempt,
    { stage: expected, ...result },
  );
  expect(reply.status).toBe(200);
  return job as Claimed;
}

// A ticket from its first stage to its merge.
async function mergeTicket(ticketId: number) {
  await stage("implement", { outcome: "done" }, ticketId);
  await stage("gate", { outcome: "passed" }, ticketId);
  await stage("review", { outcome: "pass" }, ticketId);
  await stage("merge", { outcome: "merged", headSha: "head" }, ticketId);
}

const diagnosed = (failingRepo = "backend") => ({
  outcome: "diagnosed",
  diagnosis: {
    failingRepo,
    evidence: "GET /orders/1/export answers 404: the route is not registered",
    failingTests: ["downloads the export", "shows the export button"],
  },
  // what the agent said, as the worker keeps it on the Run
  run: {
    output: {
      result: "fail",
      failingRepo,
      evidence: "GET /orders/1/export answers 404: the route is not registered",
      failingTests: ["downloads the export", "shows the export button"],
    },
  },
});

const ticket = async (id: number) =>
  (
    await db.pool.query(
      `SELECT id, state, blocked_reason, type, modules, title, body, acceptance_criteria, resume_stage,
              integration_rounds, fix_for_ticket_id, fix_round,
              (SELECT name FROM repos WHERE id = repo_id) AS repo
       FROM tickets WHERE id = $1`,
      [id],
    )
  ).rows[0];

// The integration ticket (T-1) merged, its e2e failed, the diagnosis blamed the backend: T-2 is the fix ticket.
async function failedOnce(failingRepo = "backend") {
  await runningSpec();
  await mergeTicket(1);
  await stage("e2e", { outcome: "failed" }, 1);
  await stage("diagnose", diagnosed(failingRepo), 1);
}

describe("a failed e2e", () => {
  it("is followed by a diagnosis, while the ticket stays merging", async () => {
    await runningSpec();
    await mergeTicket(1);
    const e2e = await stage("e2e", { outcome: "failed" }, 1);
    expect(e2e.type).toBe("e2e");
    expect(await ticket(1)).toMatchObject({ state: "merging" });
    const job = await claim();
    expect(job?.payload).toMatchObject({ stage: "diagnose", ticketId: 1 });
    expect(job?.type).toBe("agent-run");
  });
});

describe("a diagnosis that names a repo", () => {
  it("makes a fix ticket in that repo, in front of the integration ticket, and the integration ticket waits", async () => {
    await failedOnce();

    expect(await ticket(2)).toMatchObject({
      type: "fix",
      repo: "backend",
      modules: ["**"],
      state: "queued", // nothing blocks it: the scheduler has started it
      fix_for_ticket_id: 1,
      fix_round: 1,
    });
    const fix = await ticket(2);
    // the evidence and the failing tests, then the acceptance criteria of the integration ticket
    expect(fix.body).toContain("GET /orders/1/export answers 404");
    expect(fix.body).toContain("- downloads the export");
    expect(fix.body).toContain("- shows the export button");
    expect(fix.body).toContain("the export button downloads a file");
    expect(fix.acceptance_criteria[0]).toBe("联调票 T-1 的 e2e 通过");
    expect(fix.acceptance_criteria[1]).toContain("GET /orders/1/export");
    // the body is the issue template, and the stored criteria are what it says
    expect(fix.body).toMatch(
      /^## Parent\n\nS-1\n\n## What to build\n\n[\s\S]*\n## Acceptance criteria\n\n- \[ \] 联调票 T-1 的 e2e 通过\n- \[ \] 诊断指出的问题已修好：GET \/orders\/1\/export[^\n]*\n$/,
    );

    const edges = await db.pool.query(
      "SELECT from_ticket_id, to_ticket_id, kind FROM edges",
    );
    expect(edges.rows).toEqual([
      { from_ticket_id: 2, to_ticket_id: 1, kind: "blocks" },
    ]);
    // the integration ticket is merged already: it goes back to pending and starts again from its e2e
    expect(await ticket(1)).toMatchObject({
      state: "pending",
      resume_stage: "e2e",
      integration_rounds: 1,
    });
    // the backend had no integration branch in this spec until now
    const branches = (
      await db.pool.query("SELECT integration_branches FROM specs")
    ).rows[0].integration_branches;
    expect(branches).toHaveLength(2);
  });

  it("runs the e2e again, and only the e2e, when the fix ticket is done", async () => {
    await failedOnce();
    await mergeTicket(2);
    expect(await ticket(1)).toMatchObject({ state: "queued" });
    const job = await stage("e2e", { outcome: "passed" }, 1);
    expect(job.type).toBe("e2e");
    expect(await ticket(1)).toMatchObject({ state: "done" });
  });

  it("makes no second fix ticket when the diagnosis is handed in again", async () => {
    await runningSpec();
    await mergeTicket(1);
    await stage("e2e", { outcome: "failed" }, 1);
    const job = (await claim()) as Claimed;
    const first = await worker.complete(job.id, job.attempt, {
      stage: "diagnose",
      ...diagnosed(),
    });
    expect(first.status).toBe(200);
    const again = await worker.complete(job.id, job.attempt, {
      stage: "diagnose",
      ...diagnosed(),
    });
    expect(again.status).not.toBe(500);
    const fixes = await db.pool.query(
      "SELECT id FROM tickets WHERE fix_for_ticket_id = 1",
    );
    expect(fixes.rows).toHaveLength(1);
  });

  it("can name the repo of the e2e itself", async () => {
    await failedOnce("frontend");
    expect(await ticket(2)).toMatchObject({ repo: "frontend", type: "fix" });
  });

  it("is invalid output when it names a repo the ticket's environment does not have", async () => {
    await runningSpec();
    await mergeTicket(1);
    await stage("e2e", { outcome: "failed" }, 1);
    await stage("diagnose", diagnosed("payments"), 1);
    expect(await ticket(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "invalid-output",
    });
    const fixes = await db.pool.query(
      "SELECT id FROM tickets WHERE type = 'fix'",
    );
    expect(fixes.rows).toHaveLength(0);
  });
});

describe("a diagnosis that cannot say which repo", () => {
  it("blocks the ticket as integration-unknown-side, without a fix ticket", async () => {
    await runningSpec();
    await mergeTicket(1);
    await stage("e2e", { outcome: "failed" }, 1);
    await stage("diagnose", { outcome: "unknown-side" }, 1);
    expect(await ticket(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "integration-unknown-side",
    });
    expect((await db.pool.query("SELECT id FROM tickets")).rows).toHaveLength(
      1,
    );
  });
});

describe("the rounds", () => {
  async function secondRound() {
    await failedOnce();
    await mergeTicket(2);
    await stage("e2e", { outcome: "failed" }, 1);
    await stage("diagnose", diagnosed(), 1);
  }

  it("end at two: the third failed e2e blocks the ticket as integration-loop-exceeded", async () => {
    await secondRound();
    expect(await ticket(3)).toMatchObject({
      fix_for_ticket_id: 1,
      fix_round: 2,
    });
    await mergeTicket(3);
    await stage("e2e", { outcome: "failed" }, 1);
    expect(await ticket(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "integration-loop-exceeded",
      integration_rounds: 2,
    });
    // no third diagnosis and no third fix ticket
    expect(
      (await db.pool.query("SELECT id FROM tickets WHERE type = 'fix'")).rows,
    ).toHaveLength(2);
  });

  it("start over when a person re-runs the e2e of a blocked ticket", async () => {
    await secondRound();
    await mergeTicket(3);
    await stage("e2e", { outcome: "failed" }, 1);
    expect((await ticket(1)).state).toBe("blocked");

    const retried = await post("/tickets/1/retry", { mode: "continue" });
    expect(retried.status).toBe(200);
    expect(await ticket(1)).toMatchObject({
      integration_rounds: 0,
      resume_stage: "e2e",
    });
    // it runs its e2e, not its implement
    const job = await stage("e2e", { outcome: "failed" }, 1);
    expect(job.type).toBe("e2e");
    // a fresh round: this failure is diagnosed, and gets a fix ticket of its own
    await stage("diagnose", diagnosed(), 1);
    expect(await ticket(4)).toMatchObject({
      fix_for_ticket_id: 1,
      fix_round: 3,
    });
    expect(await ticket(1)).toMatchObject({
      state: "pending",
      integration_rounds: 1,
    });
  });

  it("start over when a person re-runs the e2e of a ticket blocked as unknown-side", async () => {
    await runningSpec();
    await mergeTicket(1);
    await stage("e2e", { outcome: "failed" }, 1);
    await stage("diagnose", { outcome: "unknown-side" }, 1);
    await post("/tickets/1/retry", { mode: "continue" });
    await stage("e2e", { outcome: "passed" }, 1);
    expect((await ticket(1)).state).toBe("done");
  });
});

describe("what a person sees", () => {
  async function get(path: string) {
    const response = await fetch(`${api.url}${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  }

  it("shows each e2e of the ticket with its diagnosis and its fix ticket", async () => {
    await failedOnce();
    await mergeTicket(2);
    await stage("e2e", { outcome: "passed" }, 1);
    const view = (await get("/tickets/1")).body;
    expect(view.integration.rounds).toBe(1);
    expect(view.integration.attempts).toHaveLength(2);
    const [first, second] = view.integration.attempts;
    expect(first.e2e).toMatchObject({ result: "failed" });
    expect(first.diagnosis).toMatchObject({
      failingRepo: "backend",
      failingTests: ["downloads the export", "shows the export button"],
    });
    expect(first.diagnosis.evidence).toContain("404");
    expect(first.fixTicket).toMatchObject({
      displayId: "T-2",
      repo: "backend",
      state: "done",
    });
    expect(second.e2e).toMatchObject({ result: "passed" });
    expect(second.diagnosis).toBeNull();
    expect(second.fixTicket).toBeNull();
  });

  it("has no integration section on a ticket that is not an integration ticket", async () => {
    await failedOnce();
    expect((await get("/tickets/2")).body.integration).toBeNull();
  });

  it("puts every round, with its evidence and fix ticket, in the brief of a ticket blocked for looping", async () => {
    await failedOnce();
    await mergeTicket(2);
    await stage("e2e", { outcome: "failed" }, 1);
    await stage("diagnose", diagnosed(), 1);
    await mergeTicket(3);
    await stage("e2e", { outcome: "failed" }, 1);

    const blocked = (await get("/blocked")).body;
    const entry = blocked.tickets.find((t: Json) => t.id === 1);
    expect(entry.blockedReason).toBe("integration-loop-exceeded");
    expect(entry.brief.attempts).toHaveLength(3);
    expect(
      entry.brief.attempts.map((r: Json) => r.fixTicket?.displayId ?? null),
    ).toEqual(["T-2", "T-3", null]);
    expect(entry.brief.attempts[0].diagnosis.evidence).toContain("404");
  });
});
