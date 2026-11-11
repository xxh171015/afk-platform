import { isAgentProviderUnavailable } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { migrate } from "./db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "./db/test-db.ts";
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

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  notices = [];
  api = await listen(
    createApp({
      pool: db.pool,
      clock: new FakeClock().now,
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
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

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
