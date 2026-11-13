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

const ticket = (key: string) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
});

async function runningSpec(keys: string[]) {
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
    importBody(spec.body.id, { tickets: keys.map(ticket) }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  return spec.body.id as number;
}

const hour = 3_600_000;

describe("lead time on a spec", () => {
  it("splits wall time so the four segments sum to the span, counting overlapping agent runs once", async () => {
    const specId = await runningSpec(["a", "b"]);
    await db.pool.query(
      `UPDATE events SET at = now() - interval '10 hours'
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'`,
      [specId],
    );
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, result, started_at, finished_at)
       VALUES
         ($1, 1, 1, 'implement', 'done', now() - interval '9 hours', now() - interval '6 hours'),
         ($1, 1, 2, 'implement', 'done', now() - interval '8 hours', now() - interval '5 hours'),
         ($1, 1, 1, 'gate', 'passed', now() - interval '5 hours', now() - interval '4 hours')`,
      [specId],
    );
    const view = await call("GET", `/specs/${specId}`);
    const lt = view.body.leadTime;
    // 3h + 3h overlapping by 2h is 4h of agent, not 6h
    expect(lt.agentMs).toBeGreaterThan(3.9 * hour);
    expect(lt.agentMs).toBeLessThan(4.1 * hour);
    expect(lt.gateMs).toBeGreaterThan(0.9 * hour);
    expect(lt.gateMs).toBeLessThan(1.1 * hour);
    expect(lt.agentMs + lt.gateMs + lt.queuedMs + lt.waitingMs).toBe(
      lt.totalMs,
    );
    expect(lt.totalMs).toBeGreaterThan(9.9 * hour);
    expect(lt.totalMs).toBeLessThan(10.2 * hour);
  });

  it("does not compute lead time for a cancelled spec", async () => {
    const specId = await runningSpec(["a"]);
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(200);
    expect((await call("GET", `/specs/${specId}`)).body.leadTime).toBeNull();
  });

  it("counts a startable pending ticket as 排队, not 等人", async () => {
    const specId = await runningSpec(["a"]);
    await db.pool.query(
      `INSERT INTO tickets (spec_id, repo_id, type, title, state)
       VALUES ($1, 1, 'implementation', 'held', 'pending')`,
      [specId],
    );
    await db.pool.query(
      `UPDATE events SET at = now() - interval '2 hours'
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'`,
      [specId],
    );
    await db.pool.query(
      `UPDATE tickets SET created_at = now() - interval '2 hours'
       WHERE spec_id = $1 AND title = 'held'`,
      [specId],
    );
    const lt = (await call("GET", `/specs/${specId}`)).body.leadTime;
    expect(lt.queuedMs).toBeGreaterThan(1.8 * hour);
    expect(lt.waitingMs).toBeLessThan(0.3 * hour);
    expect(lt.agentMs + lt.gateMs + lt.queuedMs + lt.waitingMs).toBe(
      lt.totalMs,
    );
  });

  it("cuts an in-progress agent run at now", async () => {
    const specId = await runningSpec(["a"]);
    await db.pool.query(
      `UPDATE events SET at = now() - interval '2 hours'
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'`,
      [specId],
    );
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, result, started_at, finished_at)
       VALUES ($1, 1, 1, 'implement', NULL, now() - interval '1 hour', NULL)`,
      [specId],
    );
    const lt = (await call("GET", `/specs/${specId}`)).body.leadTime;
    expect(lt.agentMs).toBeGreaterThan(0.9 * hour);
    expect(lt.agentMs).toBeLessThan(1.1 * hour);
    expect(lt.agentMs + lt.gateMs + lt.queuedMs + lt.waitingMs).toBe(
      lt.totalMs,
    );
  });
});

describe("failure source on the timeline", () => {
  it("marks a blocked ticket and a pause with their failure source on the timeline", async () => {
    const specId = await runningSpec(["a"]);
    const job = (await worker.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "agent-gave-up",
      run: {
        output: {
          status: "cannot-proceed",
          blockedReason: "agent-gave-up",
          detail: "needs a decision",
        },
      },
    });
    await db.pool.query(
      `UPDATE specs SET state = 'paused', pause_reason = 'update-branch-conflict' WHERE id = $1`,
      [specId],
    );
    const timeline = (await call("GET", `/specs/${specId}`)).body.timeline as {
      kind: string;
      failureSource?: string;
    }[];
    expect(
      timeline.find((event) => event.kind === "ticket-blocked"),
    ).toMatchObject({ failureSource: "agent" });
    expect(timeline.find((event) => event.kind === "pause")).toMatchObject({
      failureSource: "spec",
    });
  });
});
