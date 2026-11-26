import {
  CHANGE_REQUEST_IN_REWORK,
  CHANGE_REQUEST_NO_DRAFTS,
  CHANGE_REQUEST_NOT_AWAITING,
  CHANGE_REQUEST_PR_NOT_OPEN,
  changeRequestPartiallyMergedMessage,
} from "@afk/shared";
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
  clock = new FakeClock();
  api = await listen(testApp({ pool: db.pool, clock: clock.now }));
  worker = new FakeWorker(api.url, "w1", ["host"]);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function call(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
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

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const STORIES_BODY = [
  "## User Stories",
  "",
  "1. As a merchant, I want to export orders.",
  "",
].join("\n");

const ticket = (key: string, repo: string) => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
  stories: [1],
});

async function settledAndOpen(): Promise<{
  specId: number;
  pullId: number;
  headSha: string;
}> {
  const project = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${project.body.id}/repos`, {
    url: "https://github.com/me/shop-backend.git",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: project.body.id,
    type: "feature",
    slug: "export",
    title: "Export orders",
    body: STORIES_BODY,
  });
  await call(
    "POST",
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, { tickets: [ticket("be", "backend")] }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  for (let i = 0; i < 60; i++) {
    const waiting = await db.pool.query(
      "SELECT 1 FROM jobs WHERE type = 'open-pr'",
    );
    if (waiting.rowCount) break;
    const claimed = (await worker.claim()).body.job as {
      id: number;
      type: string;
      attempt: number;
      payload: Json;
    } | null;
    if (!claimed) break;
    if (claimed.type === "host-sync") {
      await worker.complete(claimed.id, claimed.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    await worker.complete(claimed.id, claimed.attempt, {
      stage: claimed.payload.stage,
      outcome:
        claimed.payload.stage === "gate"
          ? "passed"
          : claimed.payload.stage === "review" ||
              claimed.payload.stage === "final-review"
            ? "pass"
            : claimed.payload.stage === "merge"
              ? "merged"
              : "done",
      ...(claimed.payload.stage === "merge" ? { headSha: "head" } : {}),
      ...(claimed.payload.stage === "final-review"
        ? {
            run: {
              output: { verdict: "pass", mustFix: [], suggestions: [] },
            },
          }
        : {}),
    });
  }
  const open = await claimOf("open-pr");
  const headSha = "d".repeat(40);
  await worker.complete(open.id, open.attempt, {
    stage: "open-pr",
    outcome: "opened",
    number: 7,
    url: "https://github.com/me/shop/pull/7",
    state: "open",
    draft: false,
    headSha,
    ci: "none",
    review: "none",
  });
  const pull = await db.pool.query<{ id: number }>(
    "SELECT id FROM pull_requests",
  );
  return {
    specId: spec.body.id as number,
    pullId: pull.rows[0]?.id as number,
    headSha,
  };
}

async function claimOf(type: string) {
  for (let i = 0; i < 12; i++) {
    const job = (await worker.claim()).body.job;
    if (!job) break;
    if (job.type === type)
      return job as { id: number; attempt: number; payload: Json };
    if (job.type === "patch-pr-body") {
      await worker.complete(job.id, job.attempt, {
        stage: "patch-pr-body",
        outcome: "patched",
      });
      continue;
    }
    if (job.type === "host-sync") {
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    if (job.type === "review-revision" && type !== "review-revision") {
      await worker.complete(job.id, job.attempt, {});
      continue;
    }
    if (job.type === "pr-draft" || job.type === "agent-run") continue;
  }
  throw new Error(`no ${type} job`);
}

function revisionResult(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stage: "review-revision",
    headSha: SHA,
    baseSha: SHA2,
    mergeBaseSha: SHA,
    complete: true,
    omittedReason: null,
    filesCount: 0,
    additions: 0,
    deletions: 0,
    files: [],
    blobs: [],
    done: true,
    ...over,
  };
}

const aFile = (over: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  oldBlob: SHA,
  newBlob: SHA2,
  additions: 1,
  deletions: 0,
  binary: false,
  generated: false,
  test: false,
  lockfile: false,
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  patchOmitted: null,
  sincePatch: null,
  attributions: [{ ticket: "T-1" }],
  hunks: [
    {
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      owners: [{ ticket: "T-1", lines: 1 }],
    },
  ],
  ...over,
});

async function readyRevision() {
  const opened = await settledAndOpen();
  const job = await claimOf("review-revision");
  expect(
    (
      await worker.complete(
        job.id,
        job.attempt,
        revisionResult({
          headSha: opened.headSha,
          filesCount: 1,
          additions: 1,
          files: [aFile()],
          blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
        }),
      )
    ).status,
  ).toBe(200);
  const revision = await call(
    "GET",
    `/pull-requests/${opened.pullId}/review-revision?head=${opened.headSha}`,
  );
  return {
    ...opened,
    revisionId: revision.body.id as number,
  };
}

async function draftOn(opened: {
  pullId: number;
  revisionId: number;
  body?: string;
}) {
  return call("POST", `/pull-requests/${opened.pullId}/review-comments`, {
    revisionId: opened.revisionId,
    path: "src/a.ts",
    side: "new",
    lineStart: 1,
    lineEnd: 1,
    excerpt: "b",
    body: opened.body ?? "empty list should return 200",
  });
}

describe("POST /specs/{id}/change-requests", () => {
  it("submits every draft as one Change request, starts Rework, drafts PRs, and stops auto-merge", async () => {
    const opened = await readyRevision();
    const created = await draftOn(opened);
    await db.pool.query(
      `INSERT INTO jobs (type, payload, idempotency_key, required_capabilities)
       VALUES ('auto-merge', $1::jsonb, $2, '{host}')`,
      [
        JSON.stringify({
          specId: opened.specId,
          pullId: opened.pullId,
          expectedHeadSha: opened.headSha,
        }),
        `S-${opened.specId}:auto-merge`,
      ],
    );
    await db.pool.query(
      "INSERT INTO final_e2e (spec_id, state) VALUES ($1, 'done')",
      [opened.specId],
    );

    const submitted = await call(
      "POST",
      `/specs/${opened.specId}/change-requests`,
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({
      number: 1,
      state: "active",
      comments: [created.body.displayId],
    });
    expect(
      (
        await db.pool.query(
          "SELECT state, change_request_id FROM review_comments WHERE id = $1",
          [created.body.id],
        )
      ).rows[0],
    ).toEqual({
      state: "submitted",
      change_request_id: submitted.body.id,
    });
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("finalizing");
    expect(
      (
        await db.pool.query(
          `SELECT type, from_state, to_state, reason, source FROM events
           WHERE type = 'spec' AND to_state = 'finalizing' AND from_state = 'awaiting-review'
           ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0],
    ).toEqual({
      type: "spec",
      from_state: "awaiting-review",
      to_state: "finalizing",
      reason: `提交修改要求 ${created.body.displayId}`,
      source: "page",
    });
    expect(
      (
        await db.pool.query(
          "SELECT data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].action,
    ).toBe("request-changes");
    expect(
      (
        await db.pool.query(
          "SELECT step, state, blocked_reason, auto_retried FROM finalizations WHERE spec_id = $1",
          [opened.specId],
        )
      ).rows,
    ).toEqual([
      {
        step: "rework",
        state: "active",
        blocked_reason: null,
        auto_retried: false,
      },
    ]);
    expect(
      (
        await db.pool.query(
          `SELECT type, payload->>'stage' AS stage, state FROM jobs
           WHERE payload->>'final' = 'true' AND payload->>'stage' = 'rework'`,
        )
      ).rows,
    ).toEqual([{ type: "agent-run", stage: "rework", state: "queued" }]);
    expect(
      (
        await db.pool.query(
          "SELECT type, payload, state FROM jobs WHERE type = 'pr-draft'",
        )
      ).rows,
    ).toEqual([
      {
        type: "pr-draft",
        payload: { pullId: opened.pullId },
        state: "queued",
      },
    ]);
    expect(
      (
        await db.pool.query(
          "SELECT state, error FROM jobs WHERE type = 'auto-merge'",
        )
      ).rows[0],
    ).toEqual({ state: "failed", error: "提交了修改要求" });
    expect(
      (
        await db.pool.query("SELECT 1 FROM final_e2e WHERE spec_id = $1", [
          opened.specId,
        ])
      ).rowCount,
    ).toBe(0);

    const again = await call("POST", `/specs/${opened.specId}/change-requests`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(CHANGE_REQUEST_IN_REWORK);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM change_requests"))
        .rows[0].n,
    ).toBe(1);
  });

  it("leaves a repo without comments done and still drafts every open PR", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    const extra = await db.pool.query<{ id: number }>(
      `INSERT INTO repos (project_id, url, name)
       SELECT project_id, 'https://github.com/me/shop-frontend.git', 'frontend'
       FROM specs WHERE id = $1 RETURNING id`,
      [opened.specId],
    );
    const repoId = extra.rows[0]?.id as number;
    await db.pool.query(
      `INSERT INTO finalizations (spec_id, repo_id, step, state)
       VALUES ($1, $2, 'final-review', 'done')`,
      [opened.specId, repoId],
    );
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, head_sha, state)
       VALUES ($1, $2, 8, 'https://github.com/me/shop/pull/8', $3, 'open')`,
      [opened.specId, repoId, opened.headSha],
    );
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    expect(
      (
        await db.pool.query(
          `SELECT r.name, f.step, f.state
           FROM finalizations f JOIN repos r ON r.id = f.repo_id
           WHERE f.spec_id = $1 ORDER BY r.name`,
          [opened.specId],
        )
      ).rows,
    ).toEqual([
      { name: "backend", step: "rework", state: "active" },
      { name: "frontend", step: "final-review", state: "done" },
    ]);
    expect(
      (
        await db.pool.query(
          "SELECT payload->>'pullId' AS pull FROM jobs WHERE type = 'pr-draft' ORDER BY id",
        )
      ).rows.map((row: { pull: string }) => Number(row.pull)),
    ).toHaveLength(2);
  });

  it("refuses when there is no draft", async () => {
    const opened = await readyRevision();
    const refused = await call(
      "POST",
      `/specs/${opened.specId}/change-requests`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CHANGE_REQUEST_NO_DRAFTS);
  });

  it("refuses when a draft's pull request is not open", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    await db.pool.query(
      "UPDATE pull_requests SET state = 'closed' WHERE id = $1",
      [opened.pullId],
    );
    const refused = await call(
      "POST",
      `/specs/${opened.specId}/change-requests`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CHANGE_REQUEST_PR_NOT_OPEN);
  });

  it("refuses partially-merged with the bug-spec sentence", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    await db.pool.query(
      "UPDATE specs SET state = 'partially-merged' WHERE id = $1",
      [opened.specId],
    );
    const refused = await call(
      "POST",
      `/specs/${opened.specId}/change-requests`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      changeRequestPartiallyMergedMessage(`S-${opened.specId}`),
    );
  });

  it("refuses reworking and other states", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    await db.pool.query("UPDATE specs SET state = 'reworking' WHERE id = $1", [
      opened.specId,
    ]);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).body
        .error,
    ).toBe(CHANGE_REQUEST_IN_REWORK);
    await db.pool.query("UPDATE specs SET state = 'running' WHERE id = $1", [
      opened.specId,
    ]);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).body
        .error,
    ).toBe(CHANGE_REQUEST_NOT_AWAITING);
  });

  it("returns stale drafts unless acknowledgeStale is set", async () => {
    const opened = await readyRevision();
    const created = await draftOn(opened);
    const nextHead = "e".repeat(40);
    await db.pool.query(
      "UPDATE pull_requests SET head_sha = $2 WHERE id = $1",
      [opened.pullId, nextHead],
    );
    const stale = await call("POST", `/specs/${opened.specId}/change-requests`);
    expect(stale.status).toBe(409);
    expect(stale.body.stale).toEqual([
      {
        displayId: created.body.displayId,
        writtenOn: opened.headSha,
        currentHead: nextHead,
      },
    ]);
    expect(
      (
        await db.pool.query("SELECT state FROM review_comments WHERE id = $1", [
          created.body.id,
        ])
      ).rows[0].state,
    ).toBe("draft");

    const submitted = await call(
      "POST",
      `/specs/${opened.specId}/change-requests`,
      { acknowledgeStale: true },
    );
    expect(submitted.status).toBe(200);
    expect(
      (
        await db.pool.query("SELECT state FROM review_comments WHERE id = $1", [
          created.body.id,
        ])
      ).rows[0].state,
    ).toBe("submitted");
  });

  it("returns 404 when the spec is missing", async () => {
    expect((await call("POST", "/specs/99/change-requests")).status).toBe(404);
  });
});

describe("auto-merge after a Change request or append", () => {
  it("never auto-merges after submitted Review comments, including once back in awaiting-review", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    await db.pool.query(
      "UPDATE projects SET merge_policy = 'auto-improvement'",
    );
    await db.pool.query("UPDATE specs SET type = 'improvement' WHERE id = $1", [
      opened.specId,
    ]);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [opened.specId],
    );
    await db.pool.query(
      `UPDATE pull_requests SET human_comments = 0, ci = 'success', draft = false,
         conflicts_with_default = false, review = 'none' WHERE spec_id = $1`,
      [opened.specId],
    );
    const view = await call("GET", `/specs/${opened.specId}`);
    expect(view.body.autoMerge).toMatchObject({
      willMerge: false,
      reason: "平台上有人审意见",
    });
  });

  it("does not auto-merge while append-ticket rework is in progress", async () => {
    const opened = await readyRevision();
    await db.pool.query(
      "UPDATE projects SET merge_policy = 'auto-improvement'",
    );
    await db.pool.query("UPDATE specs SET type = 'improvement' WHERE id = $1", [
      opened.specId,
    ]);
    await db.pool.query(
      "INSERT INTO final_e2e (spec_id, state) VALUES ($1, 'done')",
      [opened.specId],
    );
    const appended = await call(
      "POST",
      `/specs/${opened.specId}/tickets/import?append=true`,
      importBody(opened.specId, {
        tickets: [ticket("extra", "backend")],
      }),
    );
    expect(appended.status).toBe(200);
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("reworking");
    expect(
      (
        await db.pool.query("SELECT 1 FROM final_e2e WHERE spec_id = $1", [
          opened.specId,
        ])
      ).rowCount,
    ).toBe(0);
    const view = await call("GET", `/specs/${opened.specId}`);
    expect(view.body.autoMerge).toMatchObject({
      willMerge: false,
      reason: "返工中",
    });
  });
});

describe("a pull request merged while wrap-up is a second pass", () => {
  async function hostSyncMerged(pullId: number) {
    clock.advanceSeconds(61);
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [
        {
          id: pullId,
          state: "merged",
          draft: false,
          headSha: "merged-head",
          ci: "success",
          review: "none",
        },
      ],
    });
  }

  it("merges a Change-request finalizing spec, supersedes the request, and stops wrap-up jobs", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    await hostSyncMerged(opened.pullId);
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("merged");
    expect(
      (
        await db.pool.query(
          `SELECT type, from_state, to_state, reason FROM events
           WHERE type = 'spec' AND to_state = 'merged' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0],
    ).toMatchObject({
      from_state: "finalizing",
      to_state: "merged",
      reason: "返工中 PR 被合并",
    });
    expect(
      (await db.pool.query("SELECT state FROM change_requests")).rows[0].state,
    ).toBe("superseded");
    expect(
      (
        await db.pool.query(
          "SELECT state FROM review_comments WHERE spec_id = $1",
          [opened.specId],
        )
      ).rows[0].state,
    ).toBe("submitted");
    expect(
      (
        await db.pool.query(
          `SELECT state FROM jobs
           WHERE payload->>'final' = 'true' AND payload->>'stage' = 'rework'`,
        )
      ).rows[0].state,
    ).toBe("failed");
    expect(
      (await db.pool.query("SELECT 1 FROM jobs WHERE type = 'spec-cleanup'"))
        .rowCount,
    ).toBe(1);
  });

  it("merges an append wrap-up that is finalizing after awaiting-review", async () => {
    const opened = await readyRevision();
    const appended = await call(
      "POST",
      `/specs/${opened.specId}/tickets/import?append=true`,
      importBody(opened.specId, {
        tickets: [ticket("extra", "backend")],
      }),
    );
    expect(appended.status).toBe(200);
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE appended");
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = $1", [
      opened.specId,
    ]);
    await hostSyncMerged(opened.pullId);
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("merged");
    expect(
      (
        await db.pool.query(
          `SELECT from_state, reason FROM events
           WHERE type = 'spec' AND to_state = 'merged' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0],
    ).toMatchObject({
      from_state: "finalizing",
      reason: "返工中 PR 被合并",
    });
  });

  it("does not treat the first wrap-up as rework when a PR is merged before awaiting-review", async () => {
    const project = await call("POST", "/projects", { name: "shop" });
    await call("POST", `/projects/${project.body.id}/repos`, {
      url: "https://github.com/me/shop-backend.git",
      role: "backend",
    });
    const spec = await call("POST", "/specs", {
      projectId: project.body.id,
      type: "feature",
      slug: "first",
      title: "First wrap-up",
    });
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = $1", [
      spec.body.id,
    ]);
    await db.pool.query(
      `INSERT INTO finalizations (spec_id, repo_id, step, state)
       VALUES ($1, 1, 'final-review', 'active')`,
      [spec.body.id],
    );
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, head_sha, state)
       VALUES ($1, 1, 1, 'https://github.com/me/shop/pull/1', $2, 'merged')`,
      [spec.body.id, SHA],
    );
    clock.advanceSeconds(61);
    await db.pool.query(
      `INSERT INTO jobs (type, payload, idempotency_key, required_capabilities)
       VALUES ('host-sync', '{"projectId":1}', 'project-1:host-sync', '{host}')`,
    );
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [
        {
          id: 1,
          state: "merged",
          draft: false,
          headSha: SHA,
          ci: "success",
          review: "none",
        },
      ],
    });
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          spec.body.id,
        ])
      ).rows[0].state,
    ).toBe("finalizing");
  });
});

const NEW_HEAD = "e".repeat(40);

async function claimStage(stage: string) {
  for (let i = 0; i < 24; i++) {
    const job = (await worker.claim()).body.job as {
      id: number;
      type: string;
      attempt: number;
      payload: Json;
    } | null;
    if (!job) break;
    if (job.payload?.stage === stage) return job;
    if (job.type === "host-sync") {
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    if (job.type === "pr-draft") {
      await worker.complete(job.id, job.attempt, {
        stage: "pr-draft",
        state: "open",
        draft: true,
        headSha: SHA,
        ci: "none",
        review: "none",
      });
      continue;
    }
    if (job.type === "pr-ready") {
      await worker.complete(job.id, job.attempt, {
        stage: "pr-ready",
        state: "open",
        draft: false,
        headSha: NEW_HEAD,
        ci: "none",
        review: "none",
      });
      continue;
    }
    if (job.type === "patch-pr-body") {
      await worker.complete(job.id, job.attempt, {
        stage: "patch-pr-body",
        outcome: "patched",
      });
      continue;
    }
    if (job.type === "review-revision") {
      await worker.complete(job.id, job.attempt, {});
    }
  }
  throw new Error(`no ${stage} job`);
}

async function bundleOf(job: { id: number; attempt: number }) {
  const response = await fetch(
    `${api.url}/worker/jobs/${job.id}/bundle?workerId=${worker.id}&attempt=${job.attempt}`,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function drainHost() {
  for (let i = 0; i < 24; i++) {
    const state = (
      await db.pool.query<{ state: string }>("SELECT state FROM specs")
    ).rows[0]?.state;
    if (state === "awaiting-review") return;
    const job = (await worker.claim()).body.job as {
      id: number;
      type: string;
      attempt: number;
      payload: Json;
    } | null;
    if (!job) return;
    if (job.type === "host-sync") {
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    if (job.type === "pr-draft") {
      await worker.complete(job.id, job.attempt, {
        stage: "pr-draft",
        state: "open",
        draft: true,
        headSha: SHA,
        ci: "none",
        review: "none",
      });
      continue;
    }
    if (job.type === "pr-ready") {
      await worker.complete(job.id, job.attempt, {
        stage: "pr-ready",
        state: "open",
        draft: false,
        headSha: NEW_HEAD,
        ci: "none",
        review: "none",
      });
      continue;
    }
    if (job.type === "patch-pr-body") {
      await worker.complete(job.id, job.attempt, {
        stage: "patch-pr-body",
        outcome: "patched",
      });
      continue;
    }
    if (job.type === "review-revision") {
      await worker.complete(job.id, job.attempt, {});
      continue;
    }
    if (job.payload?.finalE2e) {
      await worker.complete(job.id, job.attempt, {
        stage: job.payload.stage,
        outcome: "passed",
        run: { headSha: "fe", testsTotal: 1, testsFailed: 0 },
        gate: {
          kind: "e2e",
          commitSha: "fe",
          configSha: "cfg",
          testsTotal: 1,
          testsSkipped: 0,
        },
      });
    }
  }
}

describe("Rework wrap-up after a Change request", () => {
  it("hands the agent the rework branch and review-comments, persists them after merge, and returns to awaiting-review with a new Review revision", async () => {
    const opened = await readyRevision();
    const created = await draftOn(opened);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const ns = (
      await db.pool.query<{ branch_namespace: string }>(
        "SELECT branch_namespace FROM specs WHERE id = $1",
        [opened.specId],
      )
    ).rows[0]?.branch_namespace;
    const rework = await claimStage("rework");
    const bundle = await bundleOf(rework);
    expect(bundle.status).toBe(200);
    expect(bundle.body.agentBranch).toBe(
      `agent/${ns}/S-${opened.specId}-rework-1`,
    );
    expect(bundle.body.allowedProtectedPaths).toEqual([]);
    expect(bundle.body.reviewComments).toEqual({
      changeRequest: 1,
      currentHead: opened.headSha,
      comments: [
        expect.objectContaining({
          id: created.body.displayId,
          writtenOn: opened.headSha,
          path: "src/a.ts",
          side: "new",
          lines: [1],
          excerpt: "b",
          body: "empty list should return 200",
        }),
      ],
    });
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: created.body.displayId,
          outcome: "addressed",
          reply: "empty list now returns 200",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "handled comments",
          comments: [
            {
              id: created.body.displayId,
              outcome: "addressed",
              reply: "empty list now returns 200",
            },
          ],
          acceptance: {},
          decisions: [],
        },
        commits: ["f".repeat(40)],
      },
    });
    expect(
      (await call("GET", `/pull-requests/${opened.pullId}/review-comments`))
        .body.comments[0].state,
    ).toBe("submitted");
    const merge = await claimStage("final-merge");
    expect((await bundleOf(merge)).body.agentBranch).toBe(
      `agent/${ns}/S-${opened.specId}-rework-1`,
    );
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    const comments = await call(
      "GET",
      `/pull-requests/${opened.pullId}/review-comments`,
    );
    expect(comments.body.comments[0]).toMatchObject({
      state: "addressed",
      reply: "empty list now returns 200",
      reworkRunId: expect.any(Number),
    });
    expect(
      (
        await db.pool.query(
          "SELECT state FROM change_requests WHERE spec_id = $1",
          [opened.specId],
        )
      ).rows[0].state,
    ).toBe("done");
    await drainHost();
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("awaiting-review");
    expect(
      (
        await db.pool.query(
          `SELECT payload->>'headSha' AS head FROM jobs
           WHERE type = 'review-revision' AND state = 'queued'
           ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0].head,
    ).toBe(NEW_HEAD);
    const links = await call("GET", `/links?sha=${"f".repeat(40)}`);
    expect(links.body.links).toEqual([
      expect.objectContaining({
        kind: "ticket",
        specId: opened.specId,
        ticketId: null,
        sha: "f".repeat(40),
      }),
    ]);
  });

  it("keeps comments submitted when wrap-up merge fails", async () => {
    const opened = await readyRevision();
    const created = await draftOn(opened);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const rework = await claimStage("rework");
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: created.body.displayId,
          outcome: "addressed",
          reply: "would have fixed",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "handled",
          comments: [
            {
              id: created.body.displayId,
              outcome: "addressed",
              reply: "would have fixed",
            },
          ],
          acceptance: {},
          decisions: [],
        },
      },
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "conflict",
    });
    expect(
      (await call("GET", `/pull-requests/${opened.pullId}/review-comments`))
        .body.comments[0].state,
    ).toBe("submitted");
    expect(
      (
        await db.pool.query(
          "SELECT state, blocked_reason FROM finalizations WHERE spec_id = $1",
          [opened.specId],
        )
      ).rows[0],
    ).toEqual({ state: "blocked", blocked_reason: "merge-conflict" });
  });

  it("declines a protected-path comment with conflict, finishes wrap-up, and does not block", async () => {
    const opened = await readyRevision();
    const created = await draftOn({
      ...opened,
      body: "always run the protected workflow",
    });
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const rework = await claimStage("rework");
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: created.body.displayId,
          outcome: "declined",
          reply: "protected path; append a ticket and approve it",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "left protected path alone",
          comments: [
            {
              id: created.body.displayId,
              outcome: "declined",
              reply: "protected path; append a ticket and approve it",
            },
          ],
          acceptance: {},
          decisions: [
            {
              kind: "conflict",
              text: "comment asked to edit a protected path",
            },
          ],
        },
      },
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    expect(
      (await call("GET", `/pull-requests/${opened.pullId}/review-comments`))
        .body.comments[0],
    ).toMatchObject({
      state: "declined",
      reply: "protected path; append a ticket and approve it",
    });
    await drainHost();
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("awaiting-review");
    const pack = await call("GET", `/specs/${opened.specId}`);
    expect(pack.body.acceptancePack.needsDecision).toEqual([
      expect.objectContaining({
        kind: "needs-human",
        text: "comment asked to edit a protected path",
        source: expect.stringMatching(/rework$/),
      }),
    ]);
  });

  it("Rechecks a Rework that hit existing tests, then merges from the rework branch", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const ns = (
      await db.pool.query<{ branch_namespace: string }>(
        "SELECT branch_namespace FROM specs WHERE id = $1",
        [opened.specId],
      )
    ).rows[0]?.branch_namespace;
    const rework = await claimStage("rework");
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: "C-1",
          outcome: "addressed",
          reply: "flipped the assertion",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "flipped",
          comments: [
            {
              id: "C-1",
              outcome: "addressed",
              reply: "flipped the assertion",
            },
          ],
          acceptance: {},
          decisions: [],
        },
        recheck: {
          hit: true,
          paths: ["src/a.test.ts"],
          fromSha: "a".repeat(40),
          toSha: "b".repeat(40),
        },
      },
    });
    const rec = await claimStage("recheck");
    expect((await bundleOf(rec)).body.agentBranch).toBe(
      `agent/${ns}/S-${opened.specId}-rework-1`,
    );
    await worker.complete(rec.id, rec.attempt, {
      stage: "recheck",
      outcome: "pass",
      run: { output: { verdict: "pass" } },
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    await drainHost();
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("awaiting-review");
  });

  it("runs e2e again when Rework changed the integration branch of a spec with an integration ticket", async () => {
    const opened = await readyRevision();
    await draftOn(opened);
    const extra = await db.pool.query<{ id: number }>(
      `INSERT INTO repos (project_id, url, name)
       SELECT project_id, 'https://github.com/me/shop-frontend.git', 'frontend'
       FROM specs WHERE id = $1 RETURNING id`,
      [opened.specId],
    );
    const repoId = extra.rows[0]?.id as number;
    await db.pool.query(
      `INSERT INTO tickets (
         spec_id, repo_id, title, type, state, content_version, modules, acceptance_criteria
       ) VALUES ($1, $2, 'e2e', 'integration', 'done', 1, '{}', '{}')`,
      [opened.specId, repoId],
    );
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const rework = await claimStage("rework");
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [{ id: "C-1", outcome: "addressed", reply: "ok" }],
      run: {
        output: {
          status: "done",
          summary: "ok",
          comments: [{ id: "C-1", outcome: "addressed", reply: "ok" }],
          acceptance: {},
          decisions: [],
        },
      },
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    expect(
      (
        await db.pool.query("SELECT state FROM final_e2e WHERE spec_id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("active");
    expect(
      (
        await db.pool.query(
          `SELECT 1 FROM jobs WHERE payload->>'finalE2e' = 'true' AND state = 'queued'`,
        )
      ).rowCount,
    ).toBe(1);
  });

  it("uses a new rework branch for a second Change request", async () => {
    const opened = await readyRevision();
    const first = await draftOn(opened);
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const ns = (
      await db.pool.query<{ branch_namespace: string }>(
        "SELECT branch_namespace FROM specs WHERE id = $1",
        [opened.specId],
      )
    ).rows[0]?.branch_namespace;
    const rework = await claimStage("rework");
    await worker.complete(rework.id, rework.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: first.body.displayId,
          outcome: "addressed",
          reply: "done",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "done",
          comments: [
            {
              id: first.body.displayId,
              outcome: "addressed",
              reply: "done",
            },
          ],
          acceptance: {},
          decisions: [],
        },
      },
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    await drainHost();
    const revision = await claimOf("review-revision");
    expect(
      (
        await worker.complete(
          revision.id,
          revision.attempt,
          revisionResult({
            headSha: NEW_HEAD,
            filesCount: 1,
            additions: 1,
            files: [aFile()],
            blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
          }),
        )
      ).status,
    ).toBe(200);
    const ready = await call(
      "GET",
      `/pull-requests/${opened.pullId}/review-revision?head=${NEW_HEAD}`,
    );
    const second = await draftOn({
      pullId: opened.pullId,
      revisionId: ready.body.id as number,
      body: "name the helper",
    });
    expect(
      (await call("POST", `/specs/${opened.specId}/change-requests`)).status,
    ).toBe(200);
    const again = await claimStage("rework");
    expect((await bundleOf(again)).body.agentBranch).toBe(
      `agent/${ns}/S-${opened.specId}-rework-2`,
    );
    await worker.complete(again.id, again.attempt, {
      stage: "rework",
      outcome: "done",
      comments: [
        {
          id: second.body.displayId,
          outcome: "addressed",
          reply: "named",
        },
      ],
      run: {
        output: {
          status: "done",
          summary: "named",
          comments: [
            {
              id: second.body.displayId,
              outcome: "addressed",
              reply: "named",
            },
          ],
          acceptance: {},
          decisions: [],
        },
      },
    });
  });
});

describe("append-ticket wrap-up after awaiting-review", () => {
  it("returns to awaiting-review and enqueues a Review revision for the new head", async () => {
    const opened = await readyRevision();
    const appended = await call(
      "POST",
      `/specs/${opened.specId}/tickets/import?append=true`,
      importBody(opened.specId, {
        tickets: [ticket("extra", "backend")],
      }),
    );
    expect(appended.status).toBe(200);
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("reworking");
    for (const stage of ["implement", "gate", "review", "merge"] as const) {
      const job = await claimStage(stage);
      await worker.complete(job.id, job.attempt, {
        stage,
        outcome:
          stage === "gate"
            ? "passed"
            : stage === "review"
              ? "pass"
              : stage === "merge"
                ? "merged"
                : "done",
        ...(stage === "merge" ? { headSha: NEW_HEAD } : {}),
        ...(stage === "review"
          ? {
              run: {
                output: { verdict: "pass", mustFix: [], suggestions: [] },
              },
            }
          : {}),
      });
    }
    const review = await claimStage("final-review");
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
    const fix = await claimStage("final-fix");
    await worker.complete(fix.id, fix.attempt, {
      stage: "final-fix",
      outcome: "done",
    });
    const merge = await claimStage("final-merge");
    await worker.complete(merge.id, merge.attempt, {
      stage: "final-merge",
      outcome: "merged",
      headSha: NEW_HEAD,
    });
    await drainHost();
    expect(
      (
        await db.pool.query("SELECT state FROM specs WHERE id = $1", [
          opened.specId,
        ])
      ).rows[0].state,
    ).toBe("awaiting-review");
    expect(
      (
        await db.pool.query(
          `SELECT payload->>'headSha' AS head FROM jobs
           WHERE type = 'review-revision' AND state = 'queued'
           ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0].head,
    ).toBe(NEW_HEAD);
  });
});
