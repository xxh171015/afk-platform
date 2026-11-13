import { STAGES } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import type { Notice } from "../notify/notices.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";

// `plat bug` builds a bug draft and locates the original spec: not a ticket stage, not a
// diagnosis, and it does not import tickets or confirm (docs/specs S-28 Locate).

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;
let notices: Notice[];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  notices = [];
  clock = new FakeClock();
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

const REPORT =
  "TypeError: Cannot read properties of undefined (reading 'id')\nat exportOrders (src/orders.ts:12)";

async function shop() {
  const created = await call("POST", "/projects", { name: "shop" });
  const projectId = created.body.id as number;
  await call("POST", `/projects/${projectId}/repos`, {
    url: "git@x:backend",
    name: "backend",
  });
  await call("POST", `/projects/${projectId}/repos`, {
    url: "git@x:frontend",
    name: "frontend",
  });
  return projectId;
}

async function feature(projectId: number) {
  const spec = await call("POST", "/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
    body: "## Implementation Decisions\n\nUse CSV.\n\n## Out of Scope\n\nPDF.\n",
  });
  expect(spec.status).toBe(201);
  return spec.body.id as number;
}

async function submitBug(projectId: number, body = REPORT) {
  return call("POST", "/bugs", {
    projectId,
    body,
  });
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: Record<string, unknown>;
}

const claim = async () => (await worker.claim()).body.job as Claimed | null;

async function jobsOf(specId: number) {
  const { rows } = await db.pool.query<{
    type: string;
    payload: Record<string, unknown>;
    state: string;
  }>(
    `SELECT type, payload, state FROM jobs
     WHERE (payload->>'specId')::int = $1 ORDER BY id`,
    [specId],
  );
  return rows;
}

describe("POST /bugs", () => {
  it("creates a bug draft whose body is the report and enqueues one locate-bug agent job", async () => {
    const projectId = await shop();
    const created = await submitBug(projectId);
    expect(created.status).toBe(201);
    expect(created.body.displayId).toMatch(/^S-\d+$/);
    const specId = created.body.id as number;

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec).toMatchObject({
      type: "bug",
      state: "draft",
      body: REPORT,
      sourceSpec: null,
    });

    const jobs = await jobsOf(specId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "agent-run",
      payload: { stage: "locate-bug", specId },
    });
    expect(jobs[0]?.payload).not.toHaveProperty("ticketId");

    const tickets = await db.pool.query(
      "SELECT id FROM tickets WHERE spec_id = $1",
      [specId],
    );
    expect(tickets.rows).toEqual([]);
    expect([...STAGES]).not.toContain("locate-bug");
  });

  it("gives the worker every default branch as refs, no ticket, and no compose environment", async () => {
    const projectId = await shop();
    await submitBug(projectId);
    const job = await claim();
    expect(job?.payload.stage).toBe("locate-bug");
    const response = await fetch(
      `${api.url}/worker/jobs/${(job as Claimed).id}/bundle?workerId=w1&attempt=${(job as Claimed).attempt}`,
    );
    expect(response.status).toBe(200);
    const bundle = (await response.json()) as Json;
    expect(bundle).toMatchObject({
      job: { stage: "locate-bug" },
      ticket: null,
      environment: [],
      integrationBranch: null,
      repo: { name: "backend" },
    });
    expect(bundle.refs).toEqual([
      expect.objectContaining({ name: "frontend", sha: null }),
    ]);
    expect(bundle.agentBranch).toMatch(/S-\d+-locate$/);
  });
});

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function foundResult(specDisplayId: string) {
  return {
    stage: "locate-bug",
    outcome: "found",
    locate: {
      repo: "backend",
      files: ["src/orders.ts"],
      evidence: "exportOrders throws on a missing id",
      reproduction: "POST /orders/export",
      commits: [
        {
          sha: SHA,
          spec: specDisplayId,
          ticket: "T-1",
          run: "R-1",
        },
      ],
    },
    run: {
      output: {
        result: "found",
        repo: "backend",
        files: ["src/orders.ts"],
        evidence: "exportOrders throws on a missing id",
        reproduction: "POST /orders/export",
      },
    },
  };
}

describe("a locate that finds the original spec", () => {
  it("fills the source spec and appends pointers, not the file body, and does not import tickets or confirm", async () => {
    const projectId = await shop();
    const sourceId = await feature(projectId);
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    expect(job?.payload.stage).toBe("locate-bug");
    expect(job?.type).toBe("agent-run");
    const reply = await worker.complete(
      (job as Claimed).id,
      (job as Claimed).attempt,
      foundResult(`S-${sourceId}`),
    );
    expect(reply.status).toBe(200);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.state).toBe("draft");
    expect(view.body.spec.sourceSpec).toMatchObject({
      displayId: `S-${sourceId}`,
    });
    expect(view.body.spec.body).toContain(REPORT);
    expect(view.body.spec.body).toContain("src/orders.ts");
    expect(view.body.spec.body).toContain(`S-${sourceId}`);
    expect(view.body.spec.body).not.toContain("Use CSV");
    expect(view.body.tickets).toEqual([]);

    const jobs = await jobsOf(specId);
    expect(
      jobs.filter((row) => row.payload.stage === "locate-bug"),
    ).toHaveLength(1);
    expect(jobs.some((row) => row.payload.stage === "implement")).toBe(false);
  });
});

function unlocatedResult() {
  return {
    stage: "locate-bug",
    outcome: "unlocated",
    locate: {
      repo: "",
      files: [],
      evidence: "the stack names no file in this project",
      reproduction: "",
      commits: [],
    },
    run: {
      output: {
        result: "unlocated",
        repo: "",
        files: [],
        evidence: "the stack names no file in this project",
        reproduction: "",
      },
    },
  };
}

describe("a locate that cannot find the original spec", () => {
  it("keeps the draft, lists a locate waiting item with bug-unlocated from the spec, and creates no ticket", async () => {
    const projectId = await shop();
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    const reply = await worker.complete(
      (job as Claimed).id,
      (job as Claimed).attempt,
      unlocatedResult(),
    );
    expect(reply.status).toBe(200);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.state).toBe("draft");
    expect(view.body.spec.sourceSpec).toBeNull();
    expect(view.body.tickets).toEqual([]);

    const waiting = await call("GET", "/blocked");
    expect(waiting.body.locates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specId,
          specDisplayId: `S-${specId}`,
          reason: "bug-unlocated",
          failureSource: "spec",
        }),
      ]),
    );
    expect(waiting.body.items).toEqual(
      expect.arrayContaining([{ kind: "locate", specId }]),
    );
    expect(
      waiting.body.tickets.some(
        (row: { specId: number }) => row.specId === specId,
      ),
    ).toBe(false);
  });
});

describe("Locate OOM", () => {
  it("lists sandbox-oom from the platform, not bug-unlocated", async () => {
    const projectId = await shop();
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    const reply = await worker.fail(
      (job as Claimed).id,
      (job as Claimed).attempt,
      "sandbox-oom: container OOMKilled",
    );
    expect(reply.status).toBe(200);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.state).toBe("draft");
    const waiting = await call("GET", "/blocked");
    expect(waiting.body.locates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specId,
          reason: "sandbox-oom",
          failureSource: "platform",
        }),
      ]),
    );
    expect(waiting.body.locates[0]?.reason).not.toBe("bug-unlocated");
  });
});

describe("retrying a failed locate", () => {
  it("enqueues another locate-bug job and does not import tickets or confirm", async () => {
    const projectId = await shop();
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    await worker.complete(
      (job as Claimed).id,
      (job as Claimed).attempt,
      unlocatedResult(),
    );

    const retried = await call("POST", `/specs/${specId}/locate/retry`);
    expect(retried.status).toBe(200);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.state).toBe("draft");
    expect(view.body.tickets).toEqual([]);

    const waiting = await call("GET", "/blocked");
    expect(
      (waiting.body.locates as { specId: number }[]).some(
        (row) => row.specId === specId,
      ),
    ).toBe(false);

    const jobs = await jobsOf(specId);
    expect(
      jobs.filter((row) => row.payload.stage === "locate-bug"),
    ).toHaveLength(2);
    expect(jobs.some((row) => row.payload.stage === "implement")).toBe(false);
    expect(view.body.spec.state).not.toBe("planned");
  });
});

describe("locate notifications", () => {
  async function flushWindow() {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { rows } = await db.pool.query(
        "SELECT 1 FROM events WHERE type = 'locate' LIMIT 1",
      );
      if (rows[0]) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock.advanceSeconds(30);
    await clock.flush();
  }

  it("sends locate-succeeded when the original spec is filled", async () => {
    const projectId = await shop();
    const sourceId = await feature(projectId);
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    await worker.complete(
      (job as Claimed).id,
      (job as Claimed).attempt,
      foundResult(`S-${sourceId}`),
    );
    expect(notices).toEqual([]);
    await flushWindow();
    expect(notices).toEqual([
      {
        title: "定位成功",
        body: expect.stringContaining(`S-${specId}`),
      },
    ]);
    expect(notices[0]?.body).toContain("http://127.0.0.1:5173/specs/");
  });

  it("sends locate-failed when the original spec is not found", async () => {
    const projectId = await shop();
    const created = await submitBug(projectId);
    const specId = created.body.id as number;
    const job = await claim();
    await worker.complete(
      (job as Claimed).id,
      (job as Claimed).attempt,
      unlocatedResult(),
    );
    await flushWindow();
    expect(notices).toEqual([
      {
        title: "定位失败",
        body: expect.stringContaining(`S-${specId}`),
      },
    ]);
  });
});
