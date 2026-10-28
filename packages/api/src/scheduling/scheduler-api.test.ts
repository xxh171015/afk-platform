import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";
import { completeTicket, scheduleSpec } from "./scheduler.ts";

let db: TestDatabase;
let api: RunningApi;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(createApp({ pool: db.pool }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

interface Reply {
  id: number;
  state: string;
  error: string;
  integrationBranches: { repoId: number; branch: string }[];
  enqueued: { ticketId: number; displayId: string; jobId: number }[];
}

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply };
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

// A project with a backend and a frontend repo and one draft spec holding the given tickets.
async function draftSpec(
  tickets: Record<string, unknown>[],
  limits?: Record<string, number>,
) {
  const project = await post("/projects", { name: "shop", limits });
  const projectId = project.body.id;
  for (const role of ["backend", "frontend"]) {
    await post(`/projects/${projectId}/repos`, { url: `git@x:${role}`, role });
  }
  const spec = await post("/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  const imported = await post(`/specs/${spec.body.id}/tickets/import`, {
    tickets,
  });
  expect(imported.status).toBe(200);
  return { projectId, specId: spec.body.id };
}

// contract -> be (blocks), contract -> fe (contract edge, other repo), be + fe -> e2e
const chain = () => [
  ticket("contract", { type: "contract" }),
  ticket("be", { blocked_by: ["contract"] }),
  ticket("fe", { repo: "frontend", contract: "contract" }),
  ticket("e2e", { type: "integration", blocked_by: ["be", "fe"] }),
];

const jobPayloads = async () =>
  (
    await db.pool.query(
      "SELECT payload, idempotency_key, state FROM jobs ORDER BY id",
    )
  ).rows;
const ticketStates = async () =>
  (await db.pool.query("SELECT id, state FROM tickets ORDER BY id")).rows.map(
    (r) => `${r.id}:${r.state}`,
  );

// The fake worker claims the next job and hands back a successful result for its stage.
const SUCCESS = {
  implement: { outcome: "done" },
  gate: { outcome: "passed" },
  review: { outcome: "pass" },
  merge: { outcome: "merged", headSha: "integration-head" },
} as const;

async function step(worker: FakeWorker) {
  const claimed = (await worker.claim()).body.job;
  if (!claimed) return undefined;
  const { ticketId, stage } = claimed.payload as {
    ticketId: number;
    stage: keyof typeof SUCCESS;
  };
  const reply = await worker.complete(claimed.id, claimed.attempt, {
    stage,
    ...SUCCESS[stage],
  });
  expect(reply.status).toBe(200);
  return { ticketId, stage };
}

// Works jobs until a ticket has been merged, and says which one.
async function workUntilMerged(worker: FakeWorker) {
  for (let i = 0; i < 20; i++) {
    const done = await step(worker);
    if (!done) return undefined;
    if (done.stage === "merge") return done.ticketId;
  }
  throw new Error("no ticket was merged");
}

describe("confirming the split", () => {
  it("runs the spec, names one integration branch per repo and queues only the tickets that can start", async () => {
    const { specId } = await draftSpec(chain());
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe("running");
    expect(confirmed.body.integrationBranches).toEqual([
      { repoId: 1, branch: "spec/order-export" },
      { repoId: 2, branch: "spec/order-export" },
    ]);
    expect(confirmed.body.enqueued).toMatchObject([
      { ticketId: 1, displayId: "T-1" },
    ]);
    expect(await ticketStates()).toEqual([
      "1:queued",
      "2:pending",
      "3:pending",
      "4:pending",
    ]);
    const stored = await db.pool.query(
      "SELECT state, integration_branches FROM specs WHERE id = $1",
      [specId],
    );
    expect(stored.rows[0]).toEqual({
      state: "running",
      integration_branches: confirmed.body.integrationBranches,
    });
    expect(await jobPayloads()).toEqual([
      {
        payload: {
          stage: "implement",
          ticketId: 1,
          specId,
          repoId: 1,
          contentVersion: 1,
        },
        idempotency_key: "T-1:1:implement:1",
        state: "queued",
      },
    ]);
  });

  it("refuses an unknown spec, a spec without tickets, and a second confirmation", async () => {
    expect((await post("/specs/99/confirm")).status).toBe(404);
    const project = await post("/projects", { name: "p" });
    const empty = await post("/specs", {
      projectId: project.body.id,
      type: "feature",
      slug: "empty",
      title: "Empty",
    });
    expect((await post(`/specs/${empty.body.id}/confirm`)).status).toBe(409);

    const { specId } = await draftSpec(chain());
    expect((await post(`/specs/${specId}/confirm`)).status).toBe(200);
    const again = await post(`/specs/${specId}/confirm`);
    expect(again.status).toBe(409);
    expect((await jobPayloads()).length).toBe(1);
  });
});

describe("scheduling along the dependency chain", () => {
  it("starts tickets in dependency order as a fake worker hands results back", async () => {
    const { specId } = await draftSpec(chain());
    await post(`/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1", []);

    // Only the contract ticket is claimable; its stages run implement -> gate -> review -> merge.
    expect(await workUntilMerged(worker)).toBe(1);
    expect(await ticketStates()).toEqual([
      "1:done",
      "2:queued",
      "3:queued",
      "4:pending",
    ]);
    // The integration branch head recorded at the merge is the contract SHA that frees the contract edge.
    const sha = await db.pool.query(
      "SELECT contract_sha FROM tickets WHERE id = 1",
    );
    expect(sha.rows[0].contract_sha).toBe("integration-head");

    const order = [
      1,
      await workUntilMerged(worker),
      await workUntilMerged(worker),
    ];
    expect(await ticketStates()).toEqual([
      "1:done",
      "2:done",
      "3:done",
      "4:queued",
    ]);
    order.push(await workUntilMerged(worker));
    expect(order).toEqual([1, 2, 3, 4]);
    // the spec is finished, so what is left is its overall review
    const final = (await worker.claim()).body.job;
    expect(final?.payload).toMatchObject({ stage: "final-review" });
  });

  it("does not free the ticket behind a blocks edge until the blocker is done", async () => {
    const { specId } = await draftSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
    ]);
    await post(`/specs/${specId}/confirm`);
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 1");
    expect((await scheduleSpec(db.pool, specId)).enqueued).toEqual([]);
    expect(await ticketStates()).toEqual(["1:running", "2:pending"]);
  });

  it("will not finish a contract ticket without a contract SHA", async () => {
    const { specId } = await draftSpec(chain());
    await post(`/specs/${specId}/confirm`);
    await db.pool.query("UPDATE tickets SET state = 'merging' WHERE id = 1");
    expect(await completeTicket(db.pool, 1)).toEqual({
      status: "missing-contract-sha",
    });
    expect(await ticketStates()).toEqual([
      "1:merging",
      "2:pending",
      "3:pending",
      "4:pending",
    ]);
  });

  it("refuses to complete a ticket that is not merging, or does not exist", async () => {
    const { specId } = await draftSpec(chain());
    await post(`/specs/${specId}/confirm`);
    expect(
      await completeTicket(db.pool, 1, { contractSha: "x" }),
    ).toMatchObject({ status: "not-mergeable" });
    expect(await completeTicket(db.pool, 99)).toEqual({ status: "no-ticket" });
  });

  it("queues each ticket once however often the scheduler runs, even concurrently", async () => {
    const { specId } = await draftSpec([
      ticket("a"),
      ticket("b"),
      ticket("c", { repo: "frontend" }),
    ]);
    await post(`/specs/${specId}/confirm`);
    await Promise.all([
      scheduleSpec(db.pool, specId),
      scheduleSpec(db.pool, specId),
      scheduleSpec(db.pool, specId),
    ]);
    // the project allows two runs at once, so exactly two jobs, not one per pass
    expect((await jobPayloads()).length).toBe(2);
  });

  it("queues a retried ticket again under a new idempotency key", async () => {
    const { specId } = await draftSpec([ticket("a")]);
    await post(`/specs/${specId}/confirm`);
    const worker = new FakeWorker(api.url, "w1", []);
    const claimed = (await worker.claim()).body.job;
    await worker.complete(claimed?.id as number, claimed?.attempt as number, {
      stage: "implement",
      outcome: "agent-gave-up",
    });
    // a person retries it: back to pending, and the scheduler queues it again
    expect((await post("/tickets/1/retry", { mode: "continue" })).status).toBe(
      200,
    );
    expect((await jobPayloads()).map((j) => j.idempotency_key)).toEqual([
      "T-1:1:implement:1",
      "T-1:1:implement:2",
    ]);
  });

  it("does nothing for a spec that is not running", async () => {
    const { specId } = await draftSpec([ticket("a")]);
    expect(await scheduleSpec(db.pool, specId)).toEqual({
      enqueued: [],
      paused: false,
    });
    expect(await jobPayloads()).toEqual([]);
  });
});

describe("concurrency limits", () => {
  const independent = (n: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ticket(`t${i}`, extra));

  it("allows two agent runs per repo by default and starts the next as one finishes", async () => {
    const { specId } = await draftSpec(independent(3));
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.body.enqueued.map((t) => t.ticketId)).toEqual([1, 2]);
    expect(await ticketStates()).toEqual(["1:queued", "2:queued", "3:pending"]);

    const worker = new FakeWorker(api.url, "w1", []);
    const merged = await workUntilMerged(worker);
    const states = await ticketStates();
    expect(states).toContain(`${merged}:done`);
    expect(states[2]).toBe("3:queued");
  });

  it("allows two per project across repos by default", async () => {
    const { specId } = await draftSpec([
      ticket("a"),
      ticket("b"),
      ticket("c", { repo: "frontend" }),
      ticket("d", { repo: "frontend" }),
    ]);
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.body.enqueued.map((t) => t.ticketId)).toEqual([1, 2]);
  });

  it("counts runs of the project's other specs", async () => {
    const { projectId, specId } = await draftSpec(independent(1));
    const other = await post("/specs", {
      projectId,
      type: "feature",
      slug: "other",
      title: "Other",
    });
    await post(`/specs/${other.body.id}/tickets/import`, {
      tickets: independent(3),
    });
    await post(`/specs/${other.body.id}/confirm`);
    expect(await ticketStates()).toEqual([
      "1:pending",
      "2:queued",
      "3:queued",
      "4:pending",
    ]);
    // the first spec has to wait for a free slot
    expect((await post(`/specs/${specId}/confirm`)).body.enqueued).toEqual([]);
  });

  it("keeps two specs of one project within the project limit when they schedule at once", async () => {
    const { projectId } = await draftSpec(independent(2));
    const other = await post("/specs", {
      projectId,
      type: "feature",
      slug: "other",
      title: "Other",
    });
    await post(`/specs/${other.body.id}/tickets/import`, {
      tickets: independent(2),
    });
    await db.pool.query("UPDATE specs SET state = 'running'");
    await Promise.all([
      scheduleSpec(db.pool, 1),
      scheduleSpec(db.pool, other.body.id),
    ]);
    const queued = await db.pool.query(
      "SELECT count(*) FROM tickets WHERE state = 'queued'",
    );
    expect(Number(queued.rows[0].count)).toBe(2);
  });

  it("does not stall on an edge from another spec; the ticket just stays blocked", async () => {
    const { projectId, specId } = await draftSpec([ticket("a")]);
    const other = await post("/specs", {
      projectId,
      type: "feature",
      slug: "other",
      title: "Other",
    });
    await post(`/specs/${other.body.id}/tickets/import`, {
      tickets: [ticket("x")],
    });
    await db.pool.query(
      "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES (2, 1, 'blocks')",
    );
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.enqueued).toEqual([]);
  });

  it("honours the project's own limits", async () => {
    const { specId } = await draftSpec(independent(3), {
      repoConcurrency: 1,
      projectConcurrency: 5,
    });
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.body.enqueued).toHaveLength(1);
  });

  it("uses max_concurrency as the project limit when set", async () => {
    const { projectId, specId } = await draftSpec(independent(3), {
      repoConcurrency: 5,
    });
    await db.pool.query(
      "UPDATE projects SET max_concurrency = 1 WHERE id = $1",
      [projectId],
    );
    expect((await post(`/specs/${specId}/confirm`)).body.enqueued).toHaveLength(
      1,
    );
  });

  it("rejects an unknown or non-positive limit when the project is created", async () => {
    expect(
      (await post("/projects", { name: "x", limits: { nope: 1 } })).status,
    ).toBe(400);
    expect(
      (await post("/projects", { name: "x", limits: { repoConcurrency: 0 } }))
        .status,
    ).toBe(400);
  });
});

describe("the spec's agent time budget", () => {
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const addRun = (specId: number, durationMs: number) =>
    db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, duration_ms) VALUES ($1, 1, 'implement', $2)",
      [specId, durationMs],
    );

  it("pauses the spec and queues nothing once the 12 hours are used", async () => {
    const { specId } = await draftSpec(chain());
    await addRun(specId, TWELVE_HOURS_MS);
    const confirmed = await post(`/specs/${specId}/confirm`);
    expect(confirmed.body).toMatchObject({ state: "paused", enqueued: [] });
    const stored = await db.pool.query(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    expect(stored.rows[0].state).toBe("paused");
    expect(await jobPayloads()).toEqual([]);
  });

  it("pauses when the limit is reached while the spec is running, and stops scheduling", async () => {
    const { specId } = await draftSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
    ]);
    await post(`/specs/${specId}/confirm`);
    await addRun(specId, TWELVE_HOURS_MS - 1000);
    await db.pool.query("UPDATE tickets SET state = 'merging' WHERE id = 1");
    expect(await completeTicket(db.pool, 1)).toMatchObject({
      status: "ok",
      schedule: { enqueued: [{ ticketId: 2 }] },
    });

    await addRun(specId, 1000);
    await db.pool.query("UPDATE tickets SET state = 'pending' WHERE id = 2");
    expect(await scheduleSpec(db.pool, specId)).toEqual({
      enqueued: [],
      paused: true,
    });
    const stored = await db.pool.query(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    expect(stored.rows[0].state).toBe("paused");
    expect(await scheduleSpec(db.pool, specId)).toEqual({
      enqueued: [],
      paused: false,
    });
  });

  it("counts a run that is still going, but never more than the longest a run may take", async () => {
    const { specId } = await draftSpec([ticket("a")], {
      specAgentSeconds: 90 * 60,
    });
    // started nine hours ago and never finished: counts one hour (the cap of a run), not nine
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, started_at) VALUES ($1, 1, 'implement', now() - interval '9 hours')",
      [specId],
    );
    expect((await post(`/specs/${specId}/confirm`)).body.state).toBe("running"); // 1 h of 1.5 h
    // a second run that has been going for 45 minutes: 1 h + 45 min is past the hour and a half
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, started_at) VALUES ($1, 1, 'implement', now() - interval '45 minutes')",
      [specId],
    );
    expect(await scheduleSpec(db.pool, specId)).toEqual({
      enqueued: [],
      paused: true,
    });
  });

  it("does not count a run twice once it has finished", async () => {
    const { specId } = await draftSpec([ticket("a")], {
      specAgentSeconds: 2 * 3600,
    });
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, started_at, finished_at, duration_ms) VALUES ($1, 1, 'implement', now() - interval '5 hours', now() - interval '4 hours', 60000)",
      [specId],
    );
    expect((await post(`/specs/${specId}/confirm`)).body.state).toBe("running"); // one minute used, not five hours
  });

  it("honours a project override of the budget", async () => {
    const { specId } = await draftSpec([ticket("a")], { specAgentSeconds: 60 });
    await addRun(specId, 61_000);
    expect((await post(`/specs/${specId}/confirm`)).body.state).toBe("paused");
  });
});
