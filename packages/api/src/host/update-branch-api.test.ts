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

// main 前进后, running specs get one update-branch; later advances coalesce; conflict/gate-fail give a
// merge agent one try, then pause (docs/specs/m3-platform.md「多需求并行」). Host-sync reads default SHAs;
// paused/cancelled specs are left alone.

let db: TestDatabase;
let api: RunningApi;
let host: FakeWorker;
let agent: FakeWorker;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(
    testApp({ pool: db.pool, clock: clock.now, leaseSeconds: 3600 }),
  );
  host = new FakeWorker(api.url, "h1", ["host"]);
  agent = new FakeWorker(api.url, "a1", []);
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

const ticket = (key: string, repo: string) => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
});

async function runningSpecs(
  options: { repos?: { name: string; url: string }[]; slugs?: string[] } = {},
) {
  const repos = options.repos ?? [
    { name: "backend", url: "https://github.com/me/shop-backend.git" },
  ];
  const slugs = options.slugs ?? ["export"];
  const project = await call("POST", "/projects", { name: "shop" });
  for (const repo of repos)
    await call("POST", `/projects/${project.body.id}/repos`, repo);
  const specIds: number[] = [];
  for (const slug of slugs) {
    const spec = await call("POST", "/specs", {
      projectId: project.body.id,
      type: "feature",
      slug,
      title: slug,
    });
    await call(
      "POST",
      `/specs/${spec.body.id}/tickets/import`,
      importBody(spec.body.id, {
        tickets: [ticket(slug, repos[0]?.name as string)],
      }),
    );
    expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
      200,
    );
    specIds.push(spec.body.id as number);
  }
  await db.pool.query(
    "UPDATE jobs SET state = 'failed' WHERE payload->>'stage' = 'implement'",
  );
  return {
    projectId: project.body.id as number,
    specIds,
    repoUrl: repos[0]?.url as string,
  };
}

async function look(
  defaults: { repoUrl: string; sha: string }[],
  pulls: Record<string, unknown>[] = [],
) {
  for (let i = 0; i < 12; i++) {
    const due = await db.pool.query(
      `SELECT 1 FROM jobs WHERE type = 'host-sync' AND state = 'queued'
         AND (not_before IS NULL OR not_before <= $1)`,
      [clock.now()],
    );
    if (!due.rowCount) {
      clock.advanceSeconds(61);
      continue;
    }
    const job = (await host.claim()).body.job as {
      id: number;
      attempt: number;
      type: string;
    } | null;
    expect(job?.type).toBe("host-sync");
    const claimed = job as { id: number; attempt: number };
    const reply = await host.complete(claimed.id, claimed.attempt, {
      stage: "host-sync",
      pulls,
      defaults,
    });
    expect(reply.status).toBe(200);
    return;
  }
  throw new Error("no host-sync job");
}

const pullFacts = (
  id: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  state: "open",
  draft: false,
  headSha: "sha",
  ci: "pending",
  review: "none",
  conflictsWithDefault: false,
  ...extra,
});

async function openPull(specId: number) {
  const inserted = await db.pool.query<{ id: number }>(
    `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, draft, head_sha, ci, review)
     VALUES ($1, 1, 7, 'https://github.com/me/shop-backend/pull/7', 'open', false, 'abc', 'pending', 'none')
     RETURNING id`,
    [specId],
  );
  return inserted.rows[0]?.id as number;
}

const updateJobs = async () =>
  (
    await db.pool.query(
      `SELECT type, state, lock_key, payload, idempotency_key FROM jobs
       WHERE payload->>'stage' = 'update-branch' ORDER BY id`,
    )
  ).rows as Json[];

const specRow = async (id = 1) =>
  (
    await db.pool.query("SELECT state, pause_reason FROM specs WHERE id = $1", [
      id,
    ])
  ).rows[0] as { state: string; pause_reason: string | null };

describe("host-sync watching default branches", () => {
  it("names the default branches of repos that have a running spec", async () => {
    const { repoUrl } = await runningSpecs();
    const job = (await host.claim()).body.job as {
      id: number;
      attempt: number;
    };
    const task = await fetch(
      `${api.url}/worker/jobs/${job.id}/host-task?workerId=h1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(task).toEqual({
      kind: "host-sync",
      pulls: [],
      defaults: [{ repoUrl, branch: "main" }],
    });
  });

  it("stores the first SHA without enqueueing an update-branch", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    expect(
      (await db.pool.query("SELECT default_sha FROM repos")).rows[0]
        .default_sha,
    ).toBe("aaa111");
    expect(
      (
        await db.pool.query(
          "SELECT integration_branches FROM specs WHERE id = $1",
          [specIds[0]],
        )
      ).rows[0].integration_branches,
    ).toEqual([expect.objectContaining({ repoId: 1, mainSha: "aaa111" })]);
    expect(await updateJobs()).toEqual([]);
  });

  it("names them for a spec waiting for review", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    await openPull(specIds[0] as number);
    const job = (await host.claim()).body.job as {
      id: number;
      attempt: number;
    };
    const task = await fetch(
      `${api.url}/worker/jobs/${job.id}/host-task?workerId=h1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(task.defaults).toEqual([{ repoUrl, branch: "main" }]);
  });

  it("does not list paused or cancelled specs", async () => {
    const { specIds, repoUrl } = await runningSpecs({
      slugs: ["export", "other"],
    });
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
      [specIds[0]],
    );
    await db.pool.query("UPDATE specs SET state = 'cancelled' WHERE id = $1", [
      specIds[1],
    ]);
    const job = (await host.claim()).body.job as {
      id: number;
      attempt: number;
    };
    const task = await fetch(
      `${api.url}/worker/jobs/${job.id}/host-task?workerId=h1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(task.defaults).toEqual([]);
    await host.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [],
      defaults: [{ repoUrl, sha: "bbb222" }],
    });
    expect(await updateJobs()).toEqual([]);
  });
});

describe("enqueueing update-branch when main advances", () => {
  it("queues one update-branch per running spec of that repo, with the integration lock", async () => {
    const { specIds, repoUrl } = await runningSpecs({
      slugs: ["export", "other"],
    });
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const jobs = await updateJobs();
    expect(jobs).toMatchObject([
      {
        state: "queued",
        lock_key: "integration:1:spec/export",
        payload: {
          stage: "update-branch",
          specId: specIds[0],
          repoId: 1,
          mainSha: "bbb222",
        },
      },
      {
        state: "queued",
        lock_key: "integration:1:spec/other",
        payload: {
          stage: "update-branch",
          specId: specIds[1],
          repoId: 1,
          mainSha: "bbb222",
        },
      },
    ]);
  });

  it("coalesces later advances onto the one queued job", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    await look([{ repoUrl, sha: "ccc333" }]);
    expect(await updateJobs()).toMatchObject([
      { state: "queued", payload: { mainSha: "ccc333" } },
    ]);
  });

  it("queues one more while an update-branch is running, still coalescing onto that one", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const running = (await agent.claim()).body.job;
    expect(running?.payload).toMatchObject({ stage: "update-branch" });
    await look([{ repoUrl, sha: "ccc333" }]);
    await look([{ repoUrl, sha: "ddd444" }]);
    expect(await updateJobs()).toMatchObject([
      { state: "running", payload: { mainSha: "bbb222" } },
      { state: "queued", payload: { mainSha: "ddd444" } },
    ]);
  });

  it("does not update a paused or cancelled spec when main moves", async () => {
    const { specIds, repoUrl } = await runningSpecs({
      slugs: ["export", "other"],
    });
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
      [specIds[0]],
    );
    await db.pool.query("UPDATE specs SET state = 'cancelled' WHERE id = $1", [
      specIds[1],
    ]);
    await look([{ repoUrl, sha: "bbb222" }]);
    expect(await updateJobs()).toEqual([]);
  });

  it("does the same for a GitLab repo", async () => {
    const repoUrl = "https://gitlab.example/me/shop-backend.git";
    await runningSpecs({
      repos: [{ name: "backend", url: repoUrl }],
    });
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    expect(await updateJobs()).toMatchObject([
      {
        lock_key: "integration:1:spec/export",
        payload: { mainSha: "bbb222" },
      },
    ]);
  });

  it("keeps looking while a spec is running, even with no pull requests", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    expect((await host.claim()).body.job).toBeNull();
    clock.advanceSeconds(61);
    expect((await host.claim()).body.job?.type).toBe("host-sync");
  });

  it("looks again after a paused spec is resumed", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
      [specIds[0]],
    );
    await look([{ repoUrl, sha: "aaa111" }]);
    expect((await host.claim()).body.job).toBeNull();
    clock.advanceSeconds(61);
    expect((await host.claim()).body.job).toBeNull();
    expect(
      (
        await call("POST", `/specs/${specIds[0]}/resume`, {
          extraSeconds: 3600,
        })
      ).status,
    ).toBe(200);
    expect((await host.claim()).body.job?.type).toBe("host-sync");
  });
});

async function queuedUpdate() {
  const { repoUrl } = await runningSpecs();
  await look([{ repoUrl, sha: "aaa111" }]);
  await look([{ repoUrl, sha: "bbb222" }]);
  return (await agent.claim()).body.job as {
    id: number;
    attempt: number;
    payload: Json;
    lockKey: string | null;
  };
}

describe("the update-branch job", () => {
  it("hands the worker a bundle on the spec's temp branch, with no ticket", async () => {
    const job = await queuedUpdate();
    expect(job.lockKey).toBe("integration:1:spec/export");
    const bundle = await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?workerId=a1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(bundle.job.stage).toBe("update-branch");
    expect(bundle.ticket).toBeNull();
    expect(bundle.agentBranch).toMatch(/^agent\/[0-9a-f]{6}\/S-1-update$/);
    expect(bundle.repo.defaultBranch).toBe("main");
    expect(bundle.integrationBranch).toContain("spec/");
    expect(bundle.run.displayId).toMatch(/^R-/);
    expect(bundle.spec.displayId).toBe("S-1");
  });

  it("gives a conflict to one merge agent, then a locked merge of that branch, and pauses only the second time", async () => {
    const job = await queuedUpdate();
    expect(
      (
        await agent.complete(job.id, job.attempt, {
          stage: "update-branch",
          outcome: "conflict",
          run: { output: { failureLog: "# merge conflict\n\nshared.ts\n" } },
        })
      ).status,
    ).toBe(200);
    expect(await specRow()).toEqual({ state: "running", pause_reason: null });
    const fix = (await agent.claim()).body.job as {
      id: number;
      type: string;
      attempt: number;
      lockKey: string | null;
      payload: Json;
    };
    expect(fix).toMatchObject({
      type: "agent-run",
      lockKey: null,
      payload: { stage: "update-branch", fix: true },
    });
    const bundle = await fetch(
      `${api.url}/worker/jobs/${fix.id}/bundle?workerId=a1&attempt=${fix.attempt}`,
    ).then((r) => r.json());
    expect(bundle.agentBranch).toMatch(/^agent\/[0-9a-f]{6}\/S-1-update$/);
    expect(bundle.ticket).toBeNull();
    expect(bundle.failureLog).toBe("# merge conflict\n\nshared.ts\n");
    expect(
      (await call("GET", "/specs/1")).body.finalRuns.some(
        (run: Json) =>
          run.stage === "update-branch" && run.result === "conflict",
      ),
    ).toBe(true);

    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "done",
    });
    const again = (await agent.claim()).body.job as {
      type: string;
      lockKey: string | null;
      payload: Json;
      id: number;
      attempt: number;
    };
    expect(again).toMatchObject({
      type: "merge",
      lockKey: "integration:1:spec/export",
      payload: { afterFix: true },
    });
    const after = await fetch(
      `${api.url}/worker/jobs/${again.id}/bundle?workerId=a1&attempt=${again.attempt}`,
    ).then((r) => r.json());
    expect(after.agentBranch).toBe(bundle.agentBranch);

    await agent.complete(again.id, again.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-conflict",
    });
  });

  it("pauses with update-branch-gate-failed only after the merge agent has already tried", async () => {
    const job = await queuedUpdate();
    await agent.complete(job.id, job.attempt, {
      stage: "update-branch",
      outcome: "gate-failed",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "done",
    });
    const again = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(again.id, again.attempt, {
      stage: "update-branch",
      outcome: "gate-failed",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-gate-failed",
    });
  });

  it("pauses when the merge agent gives up, with the reason the merge had", async () => {
    const job = await queuedUpdate();
    await agent.complete(job.id, job.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "agent-gave-up",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-conflict",
    });
  });

  it("drops a queued update-branch when the spec is paused, and a merged outcome does not pause", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const running = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await look([{ repoUrl, sha: "ccc333" }]);
    expect(await updateJobs()).toHaveLength(2);
    await agent.complete(running.id, running.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    // the later SHA is kept for the agent; the extra locked merge is not left to run beside it
    expect(await specRow()).toEqual({ state: "running", pause_reason: null });
    expect(await updateJobs()).toMatchObject([
      { type: "merge", state: "done" },
      { type: "merge", state: "failed" },
      { type: "agent-run", state: "queued", payload: { mainSha: "ccc333" } },
    ]);
  });

  it("coalesces a later SHA onto the merge agent instead of starting another locked merge", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const first = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(first.id, first.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    await look([{ repoUrl, sha: "ddd444" }]);
    expect(
      (await updateJobs()).filter(
        (row) => row.type === "merge" && row.state === "queued",
      ),
    ).toEqual([]);
    expect(
      (await updateJobs()).find((row) => row.type === "agent-run"),
    ).toMatchObject({
      state: "queued",
      payload: { mainSha: "ddd444" },
    });
  });

  it("keeps the spec running when the second merge succeeds, and drops a queued job when the second merge fails", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const first = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(first.id, first.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "done",
    });
    const again = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(again.id, again.attempt, {
      stage: "update-branch",
      outcome: "merged",
    });
    expect(await specRow()).toEqual({ state: "running", pause_reason: null });

    await look([{ repoUrl, sha: "eee555" }]);
    const next = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(next.id, next.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix2 = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix2.id, fix2.attempt, {
      stage: "update-branch",
      outcome: "done",
    });
    const last = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await look([{ repoUrl, sha: "fff666" }]);
    await agent.complete(last.id, last.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-conflict",
    });
    expect(
      (await updateJobs()).some(
        (row) => row.type === "merge" && row.state === "failed",
      ),
    ).toBe(true);
  });

  it("leaves the spec running when the merge lands", async () => {
    const job = await queuedUpdate();
    await agent.complete(job.id, job.attempt, {
      stage: "update-branch",
      outcome: "merged",
      headSha: "merged-head",
    });
    expect(await specRow()).toEqual({ state: "running", pause_reason: null });
    expect(await updateJobs()).toMatchObject([{ state: "done" }]);
    expect(
      (
        await db.pool.query(
          "SELECT integration_branches FROM specs WHERE id = 1",
        )
      ).rows[0].integration_branches,
    ).toEqual([expect.objectContaining({ mainSha: "bbb222" })]);
  });
});

describe("update-branch during 收尾 and 验收", () => {
  it("does not update an awaiting-review spec when main moves", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    await openPull(specIds[0] as number);
    await look([{ repoUrl, sha: "bbb222" }]);
    expect(await updateJobs()).toEqual([]);
  });

  it("updates an awaiting-review spec when its pull request conflicts with the default branch", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    const pullId = await openPull(specIds[0] as number);
    await look(
      [{ repoUrl, sha: "aaa111" }],
      [pullFacts(pullId, { conflictsWithDefault: true })],
    );
    expect(await updateJobs()).toMatchObject([
      {
        state: "queued",
        lock_key: "integration:1:spec/export",
        payload: {
          stage: "update-branch",
          specId: specIds[0],
          repoId: 1,
          mainSha: "aaa111",
        },
      },
    ]);
  });

  it("does not update an awaiting-review spec whose pull request is still mergeable", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    const pullId = await openPull(specIds[0] as number);
    await look([{ repoUrl, sha: "aaa111" }], [pullFacts(pullId)]);
    expect(await updateJobs()).toEqual([]);
  });

  it("updates a partially-merged spec when an open pull request conflicts", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'partially-merged' WHERE id = $1",
      [specIds[0]],
    );
    const pullId = await openPull(specIds[0] as number);
    await look(
      [{ repoUrl, sha: "aaa111" }],
      [pullFacts(pullId, { conflictsWithDefault: true })],
    );
    expect(await updateJobs()).toMatchObject([
      { payload: { specId: specIds[0], mainSha: "aaa111" } },
    ]);
  });

  it("pauses a finalizing spec when the merge agent gives up, and resume returns it to 收尾", async () => {
    const job = await queuedUpdate();
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = 1");
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES (1, 1)",
    );
    await agent.complete(job.id, job.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "agent-gave-up",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-conflict",
    });
    expect((await call("POST", "/specs/1/resume", {})).body.state).toBe(
      "finalizing",
    );
    expect(await specRow()).toEqual({
      state: "finalizing",
      pause_reason: null,
    });
  });

  it("coalesces a later SHA onto a finalizing spec's in-flight update-branch", async () => {
    const { repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await look([{ repoUrl, sha: "bbb222" }]);
    const running = (await agent.claim()).body.job;
    expect(running?.payload).toMatchObject({ stage: "update-branch" });
    await db.pool.query("UPDATE specs SET state = 'finalizing'");
    await look([{ repoUrl, sha: "ccc333" }]);
    expect(await updateJobs()).toMatchObject([
      { state: "running", payload: { mainSha: "bbb222" } },
      { state: "queued", payload: { mainSha: "ccc333" } },
    ]);
  });

  it("does not queue another update-branch after allow while the pull request is still conflicted", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, 1)",
      [specIds[0]],
    );
    const pullId = await openPull(specIds[0] as number);
    await look(
      [{ repoUrl, sha: "aaa111" }],
      [pullFacts(pullId, { conflictsWithDefault: true })],
    );
    const first = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(first.id, first.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "agent-gave-up",
    });
    expect(await specRow()).toEqual({
      state: "paused",
      pause_reason: "update-branch-conflict",
    });
    expect((await call("POST", `/specs/${specIds[0]}/allow`)).body.state).toBe(
      "awaiting-review",
    );
    await look(
      [{ repoUrl, sha: "aaa111" }],
      [pullFacts(pullId, { conflictsWithDefault: true })],
    );
    expect(
      (await updateJobs()).filter((row) => row.state === "queued"),
    ).toEqual([]);
  });

  it("queues update-branch again on retry while the pull request is still conflicted", async () => {
    const { specIds, repoUrl } = await runningSpecs();
    await look([{ repoUrl, sha: "aaa111" }]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specIds[0]],
    );
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, 1)",
      [specIds[0]],
    );
    const pullId = await openPull(specIds[0] as number);
    await look(
      [{ repoUrl, sha: "aaa111" }],
      [pullFacts(pullId, { conflictsWithDefault: true })],
    );
    const first = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(first.id, first.attempt, {
      stage: "update-branch",
      outcome: "conflict",
    });
    const fix = (await agent.claim()).body.job as {
      id: number;
      attempt: number;
    };
    await agent.complete(fix.id, fix.attempt, {
      stage: "update-branch",
      outcome: "agent-gave-up",
    });
    expect(
      (await call("POST", `/specs/${specIds[0]}/resume`, {})).body.state,
    ).toBe("awaiting-review");
    expect(
      (await updateJobs()).filter((row) => row.state === "queued"),
    ).toMatchObject([{ payload: { specId: specIds[0], mainSha: "aaa111" } }]);
  });
});
