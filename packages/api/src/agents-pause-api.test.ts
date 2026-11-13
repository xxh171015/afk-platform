import { isAgentProviderUnavailable } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createMigratedTestDatabase, type TestDatabase } from "./db/test-db.ts";
import type { Notice } from "./notify/notices.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
} from "./test/fake-worker.ts";
import { importBody } from "./test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let notices: Notice[];
let clock: FakeClock;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  notices = [];
  clock = new FakeClock();
  api = await listen(
    createApp({
      pool: db.pool,
      clock: clock.now,
      statDisk: async () => ({ freeBytes: 100 * 1024 ** 3, dirBytes: 0 }),
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
): Promise<number> {
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
  return spec.body.id;
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

const REFUSED_KEY =
  "(FiberFailure) AgentError: cursor exited with code 1:\nActionRequiredError: Unauthorized request. Invalid internal service header";
const OUT_OF_USAGE =
  "(FiberFailure) AgentError: cursor exited with code 1:\nActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";

describe("telling the provider's refusal from other failures", () => {
  it("knows Cursor's out-of-usage and refused-key errors, and nothing else", () => {
    expect(isAgentProviderUnavailable(OUT_OF_USAGE)).toBe(true);
    expect(
      isAgentProviderUnavailable(
        "(FiberFailure) AgentError: cursor exited with code 1:\nActionRequiredError: Unauthorized request. Invalid internal service header",
      ),
    ).toBe(true);
    expect(isAgentProviderUnavailable("docker daemon not running")).toBe(false);
    expect(
      isAgentProviderUnavailable(
        "push failed: remote: Invalid username or token. unauthorized",
      ),
    ).toBe(false);
  });
});

describe("the agents' provider refusing work", () => {
  it("puts the job back as it was, blocks nothing, and hands out no agent job until resumed", async () => {
    await runningSpec([ticket("a"), ticket("b")]);
    const first = (await claim()) as Claimed;
    const second = (await claim()) as Claimed;
    expect([first.payload.stage, second.payload.stage]).toEqual([
      "implement",
      "implement",
    ]);
    expect(
      (await worker.fail(first.id, first.attempt, OUT_OF_USAGE)).status,
    ).toBe(200);
    // the one already running fails the same way: no second notice
    await worker.fail(second.id, second.attempt, OUT_OF_USAGE);

    const tickets = await db.pool.query(
      "SELECT state, blocked_reason FROM tickets ORDER BY id",
    );
    expect(tickets.rows.map((r) => r.blocked_reason)).toEqual([null, null]);
    const jobs = await db.pool.query(
      "SELECT state, attempt FROM jobs WHERE type = 'agent-run' ORDER BY id",
    );
    expect(jobs.rows).toEqual([
      { state: "queued", attempt: 2 },
      { state: "queued", attempt: 2 },
    ]);
    // the Runs end with the reason, and let go of the jobs
    const runs = await db.pool.query(
      "SELECT job_id, result, output->>'error' AS error FROM runs ORDER BY id",
    );
    expect(runs.rows.map((r) => [r.job_id, r.result])).toEqual([
      [null, "provider-unavailable"],
      [null, "provider-unavailable"],
    ]);
    expect(runs.rows[0].error).toBe("Cursor 额度用完，充值或换模型后再试");
    const deadline = Date.now() + 2_000;
    while (notices.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Agent 已暂停");
    expect(notices[0]?.body).toContain("Cursor 额度用完");

    expect(await claim()).toBeNull();
    const board = (await call("GET", "/workbench")).body;
    expect(board.status.agentsPaused).toMatchObject({
      reason: "Cursor 额度用完，充值或换模型后再试",
    });

    expect((await call("POST", "/agents/resume")).body).toEqual({
      resumed: true,
    });
    expect((await call("GET", "/workbench")).body.status.agentsPaused).toBe(
      null,
    );
    const again = (await claim()) as Claimed;
    expect(again).toMatchObject({ id: first.id, attempt: 2 });
    await worker.complete(again.id, again.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const fresh = await db.pool.query(
      "SELECT result FROM runs WHERE job_id = $1",
      [first.id],
    );
    expect(fresh.rows).toEqual([{ result: "done" }]);
    expect((await call("POST", "/agents/resume")).body).toEqual({
      resumed: false,
    });
  });

  it("still hands out the jobs that need no agent while paused", async () => {
    await runningSpec([ticket("a"), ticket("b")]);
    const implement = (await claim()) as Claimed;
    await worker.complete(implement.id, implement.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const other = (await claim()) as Claimed;
    expect(other.payload.stage).toBe("implement");
    await worker.fail(other.id, other.attempt, OUT_OF_USAGE);
    const gate = (await claim()) as Claimed;
    expect(gate).toMatchObject({ type: "gate", payload: { stage: "gate" } });
  });

  it("leaves an ordinary failure to the usual three tries", async () => {
    await runningSpec([ticket("a")]);
    const job = (await claim()) as Claimed;
    await worker.fail(job.id, job.attempt, "docker daemon not running");
    expect(notices).toEqual([]);
    const jobs = await db.pool.query(
      "SELECT state FROM jobs WHERE type = 'agent-run' ORDER BY id",
    );
    expect(jobs.rows.map((r) => r.state)).toEqual(["failed", "queued"]);
  });
});

const minutes = (n: number) => clock.advanceSeconds(n * 60);

async function waitForNotices(count: number) {
  const deadline = Date.now() + 2_000;
  while (notices.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function resumedEvents() {
  const { rows } = await db.pool.query(
    "SELECT source, data FROM events WHERE type = 'system' AND data->>'kind' = 'agents-resumed' ORDER BY id",
  );
  return rows;
}

// Both tickets' implement jobs ran into the usage limit: the agents are paused and nothing agent is running.
async function outOfUsage(): Promise<Claimed[]> {
  await runningSpec([ticket("a"), ticket("b")]);
  const jobs = [(await claim()) as Claimed, (await claim()) as Claimed];
  for (const job of jobs) await worker.fail(job.id, job.attempt, OUT_OF_USAGE);
  return jobs;
}

describe("trying the provider again after its usage ran out", () => {
  it("hands out one agent job 15 minutes after the pause, and none before", async () => {
    await outOfUsage();
    minutes(14);
    expect(await claim()).toBeNull();
    minutes(1);
    const probe = (await claim()) as Claimed;
    expect(probe).toMatchObject({
      type: "agent-run",
      payload: { stage: "implement" },
    });
    // the other agent job waits for what the first one finds out
    expect(await claim()).toBeNull();
    expect((await call("GET", "/workbench")).body.status.agentsPaused).toEqual(
      expect.objectContaining({ nextProbeAt: "2026-01-01T00:45:00.000Z" }),
    );
  });

  it("waits 30, then 60 minutes after probes that find the usage still gone, and no longer than 60", async () => {
    await outOfUsage();
    minutes(15);
    for (const wait of [30, 60, 60]) {
      const probe = (await claim()) as Claimed;
      expect(probe?.type).toBe("agent-run");
      await worker.fail(probe.id, probe.attempt, OUT_OF_USAGE);
      minutes(wait - 1);
      expect(await claim()).toBeNull();
      minutes(1);
    }
    expect((await claim())?.type).toBe("agent-run");
    // a probe that found the usage gone is no failure of the ticket's
    const tickets = await db.pool.query(
      "SELECT state, blocked_reason FROM tickets ORDER BY id",
    );
    expect(tickets.rows.map((r) => r.blocked_reason)).toEqual([null, null]);
    const runs = await db.pool.query(
      "SELECT count(*)::int AS n FROM runs WHERE result = 'provider-unavailable'",
    );
    expect(runs.rows[0].n).toBe(5);
    const failed = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE state = 'failed'",
    );
    expect(failed.rows[0].n).toBe(0);
  });

  it("resumes the agents when a ticket's probe comes back with a result, and says so", async () => {
    await outOfUsage();
    await waitForNotices(1);
    minutes(15);
    const probe = (await claim()) as Claimed;
    await worker.complete(probe.id, probe.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect((await call("GET", "/workbench")).body.status.agentsPaused).toBe(
      null,
    );
    expect((await resumedEvents()).map((r) => r.data)).toEqual([
      { kind: "agents-resumed", automatic: true, pausedMinutes: 15 },
    ]);
    await waitForNotices(2);
    expect(notices[1]?.title).toBe("Agent 已自动恢复");
    expect(notices[1]?.body).toContain("暂停了 15 分钟");
    // the other ticket's implement is handed out again
    const stages: string[] = [];
    for (let job = await claim(); job; job = await claim())
      stages.push(job.payload.stage);
    expect(stages).toContain("implement");
  });

  it("resumes the agents when a finalization's probe comes back with a result", async () => {
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
    const review = (await claim()) as Claimed;
    expect(review.payload.stage).toBe("final-review");
    await worker.fail(review.id, review.attempt, OUT_OF_USAGE);
    minutes(15);
    const probe = (await claim()) as Claimed;
    expect(probe.payload.stage).toBe("final-review");
    await worker.complete(probe.id, probe.attempt, {
      stage: "final-review",
      outcome: "pass",
      run: { output: { verdict: "pass", mustFix: [], suggestions: [] } },
    });
    expect((await call("GET", "/workbench")).body.status.agentsPaused).toBe(
      null,
    );
    expect((await resumedEvents()).map((r) => r.data.automatic)).toEqual([
      true,
    ]);
  });

  it("never tries again on its own when the key was refused", async () => {
    await runningSpec([ticket("a")]);
    const job = (await claim()) as Claimed;
    await worker.fail(job.id, job.attempt, REFUSED_KEY);
    expect((await call("GET", "/workbench")).body.status.agentsPaused).toEqual(
      expect.objectContaining({ nextProbeAt: null }),
    );
    minutes(24 * 60);
    expect(await claim()).toBeNull();
  });

  it("stops trying when a probe finds the key refused", async () => {
    await outOfUsage();
    minutes(15);
    const probe = (await claim()) as Claimed;
    await worker.fail(probe.id, probe.attempt, REFUSED_KEY);
    minutes(24 * 60);
    expect(await claim()).toBeNull();
    expect(
      (await call("GET", "/workbench")).body.status.agentsPaused.reason,
    ).toContain("CURSOR_API_KEY");
  });

  it("records a person's resume as not automatic, and tells them apart in the notice", async () => {
    await outOfUsage();
    await waitForNotices(1);
    minutes(5);
    await call("POST", "/agents/resume");
    expect((await resumedEvents()).map((r) => [r.source, r.data])).toEqual([
      ["page", { kind: "agents-resumed", automatic: false, pausedMinutes: 5 }],
    ]);
    await waitForNotices(2);
    expect(notices[1]?.title).toBe("Agent 已恢复");
    expect((await claim())?.type).toBe("agent-run");
  });
});
