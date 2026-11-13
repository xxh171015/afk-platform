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
  // today, so the weeks line up with the events the database stamps with now()
  clock = new FakeClock();
  clock.advanceSeconds((Date.now() - clock.now().getTime()) / 1000);
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

const ticket = (key: string) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
});

async function runningSpec(keys: string[], projectName = "shop") {
  const created = await call("POST", "/projects", { name: projectName });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: `git@x:${projectName}-backend`,
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
  return {
    projectId: created.body.id as number,
    specId: spec.body.id as number,
  };
}

async function mergeSpec(
  specId: number,
  at: Date,
  extra: { platformHead?: boolean } = {},
) {
  const repoId = (
    await db.pool.query<{ repo_id: number }>(
      "SELECT repo_id FROM tickets WHERE spec_id = $1 LIMIT 1",
      [specId],
    )
  ).rows[0]?.repo_id;
  await db.pool.query("UPDATE specs SET state = 'merged' WHERE id = $1", [
    specId,
  ]);
  await db.pool.query(
    `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha, synced_at, merged_at)
     VALUES ($1, $2, 1, 'https://git.example/pr/1', 'merged', 'aaa', $3, $3)`,
    [specId, repoId, at],
  );
  if (extra.platformHead !== undefined) {
    await db.pool.query(
      `INSERT INTO events (spec_id, repo_id, type, to_state, source, data, at)
       VALUES ($1, $2, 'pull-request', 'merged', 'host-sync',
               jsonb_build_object('number', 1, 'headSha', 'aaa', 'platformHead', $3::boolean),
               $4)`,
      [specId, repoId, extra.platformHead, at],
    );
  }
}

const thisWeek = (metrics: Json) => metrics.weeks.at(-1);

type Claimed = { id: number; attempt: number; payload: { stage: string } };

// The next job is claimed and comes back with this outcome.
async function report(
  stage: string,
  outcome: string,
  extra: Record<string, unknown> = {},
) {
  const job = (await worker.claim()).body.job as Claimed;
  expect(job?.payload.stage).toBe(stage);
  expect(
    (await worker.complete(job.id, job.attempt, { stage, outcome, ...extra }))
      .status,
  ).toBe(200);
}

describe("GET /metrics", () => {
  it("returns 12 empty weeks when nothing has ended", async () => {
    const view = await call("GET", "/metrics");
    expect(view.status).toBe(200);
    expect(view.body.weeks).toHaveLength(12);
    expect(thisWeek(view.body)).toMatchObject({
      leadTime: { ended: 0, medianMs: null, specs: [] },
      attribution: { recovered: [], needsHuman: [] },
      failureRate: {
        ended: 0,
        platform: null,
        external: null,
        jobPlatform: null,
      },
      success: {
        mergedPulls: 0,
        mergeRate: null,
        humanCommitsRate: null,
        untouchedRate: null,
      },
    });
  });

  it("puts a merged spec in 工期 and a cancelled one only in the ended count", async () => {
    const merged = await runningSpec(["a"]);
    const confirmAt = (
      await db.pool.query<{ at: Date }>(
        `SELECT at FROM events
         WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'
         ORDER BY id LIMIT 1`,
        [merged.specId],
      )
    ).rows[0].at;
    const started = new Date(confirmAt.getTime() + 60_000);
    const finished = new Date(started.getTime() + 3_600_000);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, result, started_at, finished_at)
       SELECT $1, repo_id, id, 'implement', 'done', $2, $3
       FROM tickets WHERE spec_id = $1`,
      [merged.specId, started, finished],
    );
    await mergeSpec(merged.specId, new Date(finished.getTime() + 60_000));
    const cancelled = await runningSpec(["b"], "other");
    expect(
      (await call("POST", `/specs/${cancelled.specId}/cancel`)).status,
    ).toBe(200);

    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.leadTime.ended).toBe(1);
    expect(week.leadTime.specs).toEqual([
      expect.objectContaining({ id: merged.specId, displayId: "S-1" }),
    ]);
    expect(week.leadTime.agentMs).toBeGreaterThan(3_500_000);
    expect(week.leadTime.agentMs).toBeLessThan(3_700_000);
    expect(week.failureRate.ended).toBe(2);
  });

  it("attributes a cancelled spec's blocked ticket as 要人处理, not 工期", async () => {
    const { specId } = await runningSpec(["a"]);
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
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(200);
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.leadTime.ended).toBe(0);
    expect(week.failureRate.ended).toBe(1);
    expect(week.attribution.needsHuman).toEqual([
      expect.objectContaining({ source: "agent", reason: "agent-gave-up" }),
    ]);
  });

  it("raises 平台故障率 when a cancelled spec had a 要人处理 platform failure", async () => {
    const { specId } = await runningSpec(["a"]);
    for (let i = 0; i < 3; i++) {
      const job = (await worker.claim()).body.job as {
        id: number;
        attempt: number;
      };
      expect(
        (await worker.fail(job.id, job.attempt, "sandbox exited with code 137"))
          .status,
      ).toBe(200);
    }
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(200);
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.leadTime.ended).toBe(0);
    expect(week.failureRate.ended).toBe(1);
    expect(week.failureRate.platform).toBe(1);
    expect(week.attribution.needsHuman).toEqual([
      expect.objectContaining({ source: "platform", reason: "job-failed" }),
    ]);
  });

  it("counts 自动恢复 separately from 要人处理", async () => {
    const { specId } = await runningSpec(["a"]);
    const job = (await worker.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await worker.fail(job.id, job.attempt, "npm error code EAI_AGAIN");
    await mergeSpec(specId, new Date());
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.attribution.recovered).toEqual([
      expect.objectContaining({ source: "external", reason: "job-failed" }),
    ]);
    expect(week.attribution.needsHuman).toEqual([]);
    expect(week.failureRate.external).toBe(0);
    expect(week.failureRate.platform).toBe(0);
  });

  it("counts a ticket's stage that ran again on its own and then finished as 自动恢复", async () => {
    const { specId } = await runningSpec(["a"]);
    await report("implement", "timeout");
    await report("implement", "done");
    await mergeSpec(specId, new Date());
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.attribution.recovered).toEqual([
      { source: "agent", reason: "timeout", count: 1 },
    ]);
    expect(week.attribution.needsHuman).toEqual([]);
  });

  it("counts a finalization step that ran again on its own and then passed as 自动恢复", async () => {
    const { specId } = await runningSpec(["a"]);
    await report("implement", "done");
    await report("gate", "passed");
    await report("review", "pass");
    await report("merge", "merged", { headSha: "h" });
    await report("final-review", "invalid-output");
    await report("final-review", "pass");
    await mergeSpec(specId, new Date());
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.attribution.recovered).toEqual([
      { source: "agent", reason: "invalid-output", count: 1 },
    ]);
    expect(week.attribution.needsHuman).toEqual([]);
  });

  it("counts a stage that blocked after running again on its own as 要人处理 only", async () => {
    const { specId } = await runningSpec(["a"]);
    await report("implement", "timeout");
    await report("implement", "timeout");
    await call("POST", "/tickets/1/retry", { mode: "continue" });
    await report("implement", "done");
    await mergeSpec(specId, new Date());
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.attribution.recovered).toEqual([]);
    expect(week.attribution.needsHuman).toEqual([
      { source: "agent", reason: "timeout", count: 1 },
    ]);
  });

  it("counts a finalization step that blocked after running again on its own as 要人处理 only", async () => {
    const { specId } = await runningSpec(["a"]);
    await report("implement", "done");
    await report("gate", "passed");
    await report("review", "pass");
    await report("merge", "merged", { headSha: "h" });
    await report("final-review", "timeout");
    await report("final-review", "timeout");
    await call("POST", `/specs/${specId}/final/retry`, {});
    await report("final-review", "pass");
    await mergeSpec(specId, new Date());
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.attribution.recovered).toEqual([]);
    expect(week.attribution.needsHuman).toEqual([
      { source: "agent", reason: "timeout", count: 1 },
    ]);
  });

  it("lists the agents' pauses with how long each lasted and whether it ended on its own", async () => {
    await runningSpec(["a", "b"]);
    const outOfUsage =
      "ActionRequiredError: Increase limits for faster responses You're out of usage.";
    const first = (await worker.claim()).body.job as Claimed;
    await worker.fail(first.id, first.attempt, outOfUsage);
    clock.advanceSeconds(15 * 60);
    const probe = (await worker.claim()).body.job as Claimed;
    await worker.complete(probe.id, probe.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const second = (await worker.claim()).body.job as Claimed;
    await worker.fail(second.id, second.attempt, outOfUsage);
    clock.advanceSeconds(5 * 60);
    await call("POST", "/agents/resume");

    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.agentsPauses).toEqual([
      { pausedMinutes: 15, automatic: true },
      { pausedMinutes: 5, automatic: false },
    ]);
  });

  it("counts merged and closed pull requests for 合并率", async () => {
    const merged = await runningSpec(["a"]);
    await mergeSpec(merged.specId, new Date());
    const closed = await runningSpec(["b"], "other");
    const repoId = (
      await db.pool.query<{ repo_id: number }>(
        "SELECT repo_id FROM tickets WHERE spec_id = $1 LIMIT 1",
        [closed.specId],
      )
    ).rows[0].repo_id;
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha, synced_at)
       VALUES ($1, $2, 1, 'https://git.example/pr/2', 'closed', 'bbb', now())`,
      [closed.specId, repoId],
    );
    await db.pool.query(
      `INSERT INTO events (spec_id, repo_id, type, to_state, source, data)
       VALUES ($1, $2, 'pull-request', 'closed', 'host-sync', '{"number":1}')`,
      [closed.specId, repoId],
    );
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.success.mergedPulls).toBe(1);
    expect(week.success.mergeRate).toBe(0.5);
  });

  it("counts 合并前要人补 commit from the merge event's platformHead", async () => {
    const clean = await runningSpec(["a"]);
    await mergeSpec(clean.specId, new Date(), { platformHead: true });
    const extra = await runningSpec(["b"], "other");
    await mergeSpec(extra.specId, new Date(), { platformHead: false });
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.success.humanCommitsRate).toBe(0.5);
  });

  it("counts 无人插手 when a merged spec had no action after confirm", async () => {
    const clean = await runningSpec(["a"]);
    await mergeSpec(clean.specId, new Date());
    const nudged = await runningSpec(["b"], "other");
    const confirmAt = (
      await db.pool.query<{ at: Date }>(
        `SELECT at FROM events
         WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'
         ORDER BY id LIMIT 1`,
        [nudged.specId],
      )
    ).rows[0].at;
    // now() vs Date() in the same millisecond can put the retry after merged_at.
    const actionAt = new Date(confirmAt.getTime() + 60_000);
    await db.pool.query(
      `INSERT INTO events (spec_id, type, source, data, at)
       VALUES ($1, 'action', 'page', '{"action":"retry"}', $2)`,
      [nudged.specId, actionAt],
    );
    await mergeSpec(nudged.specId, new Date(actionAt.getTime() + 60_000));
    const week = thisWeek((await call("GET", "/metrics")).body);
    expect(week.success.untouchedRate).toBe(0.5);
  });

  it("filters by project", async () => {
    const { specId, projectId } = await runningSpec(["a"]);
    await mergeSpec(specId, new Date());
    const other = await runningSpec(["b"], "other");
    await mergeSpec(other.specId, new Date());
    const filtered = thisWeek(
      (await call("GET", `/metrics?projectId=${projectId}`)).body,
    );
    expect(filtered.leadTime.ended).toBe(1);
    expect(filtered.leadTime.specs[0].id).toBe(specId);
  });
});
