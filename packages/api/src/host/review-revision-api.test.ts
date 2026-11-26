import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { LogStore } from "../logs/log-store.ts";
import { retainLogs } from "../logs/retention.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";
import {
  enqueueReviewRevision,
  markReviewFileViewed,
} from "./review-revision.ts";

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

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

const ticket = (key: string, repo: string) => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
});

async function settledAndOpen(): Promise<{ pullId: number; headSha: string }> {
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
  return { pullId: pull.rows[0]?.id as number, headSha };
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
    }
  }
  throw new Error(`no ${type} job`);
}

const jobsOf = async (type: string) =>
  (
    await db.pool.query(
      "SELECT state, payload, idempotency_key FROM jobs WHERE type = $1 ORDER BY id",
      [type],
    )
  ).rows as Json[];

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
  hunks: null,
  ...over,
});

describe("review-revision jobs", () => {
  it("pre-enqueues a slotless job when the spec enters awaiting-review", async () => {
    const { pullId, headSha } = await settledAndOpen();
    expect(await specState()).toBe("awaiting-review");
    expect(await jobsOf("review-revision")).toMatchObject([
      {
        state: "queued",
        payload: { pullId, headSha, previousHeadSha: null },
      },
    ]);
    expect((await jobsOf("review-revision"))[0].idempotency_key).toBe(
      `pull-${pullId}:review-revision:${headSha}:1`,
    );
    const job = await claimOf("review-revision");
    const task = await fetch(
      `${api.url}/worker/jobs/${job.id}/host-task?workerId=w1&attempt=${job.attempt}`,
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as Json }));
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({
      kind: "review-revision",
      pullId,
      headSha,
      previousHeadSha: null,
      repoName: "backend",
      defaultBranch: "main",
    });
  });

  it("stores one revision per PR head as ready, unique on (PR, head)", async () => {
    const { pullId, headSha } = await settledAndOpen();
    const job = await claimOf("review-revision");
    expect(
      (
        await worker.complete(
          job.id,
          job.attempt,
          revisionResult({
            filesCount: 1,
            additions: 1,
            files: [aFile()],
            blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
          }),
        )
      ).status,
    ).toBe(200);
    const rows = await db.pool.query(
      "SELECT pull_request_id, head_sha, state, complete, files_count, additions FROM review_revisions",
    );
    expect(rows.rows).toEqual([
      {
        pull_request_id: pullId,
        head_sha: headSha,
        state: "ready",
        complete: true,
        files_count: 1,
        additions: 1,
      },
    ]);
    const files = await db.pool.query(
      "SELECT path, status, test, lockfile, patch_omitted, new_blob FROM review_files",
    );
    expect(files.rows).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        test: false,
        lockfile: false,
        patch_omitted: null,
        new_blob: SHA2,
      },
    ]);
    const blobs = await db.pool.query(
      "SELECT sha, content, bytes FROM review_blobs",
    );
    expect(blobs.rows).toEqual([{ sha: SHA2, content: "b\n", bytes: 2 }]);
    await inTransaction(db.pool, async (client: pg.PoolClient) => {
      await enqueueReviewRevision(client, pullId);
    });
    expect(await jobsOf("review-revision")).toHaveLength(1);
  });

  it("re-enqueues the same row after a failure, and a new head gets a new row", async () => {
    const { pullId, headSha } = await settledAndOpen();
    const job = await claimOf("review-revision");
    expect((await worker.fail(job.id, job.attempt, "git failed")).status).toBe(
      200,
    );
    const failed = await db.pool.query(
      "SELECT state, error FROM review_revisions",
    );
    expect(failed.rows).toEqual([{ state: "failed", error: "git failed" }]);
    await inTransaction(db.pool, async (client: pg.PoolClient) => {
      await enqueueReviewRevision(client, pullId);
    });
    expect(await jobsOf("review-revision")).toMatchObject([
      { state: "failed" },
      {
        state: "queued",
        payload: { pullId, headSha },
        idempotency_key: `pull-${pullId}:review-revision:${headSha}:2`,
      },
    ]);
    expect(
      (await db.pool.query("SELECT state FROM review_revisions")).rows,
    ).toEqual([{ state: "pending" }]);
    const retry = await claimOf("review-revision");
    await worker.complete(retry.id, retry.attempt, revisionResult());
    const nextHead = "e".repeat(40);
    await db.pool.query(
      "UPDATE pull_requests SET head_sha = $2 WHERE id = $1",
      [pullId, nextHead],
    );
    await inTransaction(db.pool, async (client: pg.PoolClient) => {
      await enqueueReviewRevision(client, pullId);
    });
    expect(
      (
        await db.pool.query(
          "SELECT head_sha, state FROM review_revisions ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { head_sha: headSha, state: "ready" },
      { head_sha: nextHead, state: "pending" },
    ]);
  });

  it("marks ready only after the last chunk", async () => {
    const { pullId } = await settledAndOpen();
    const job = await claimOf("review-revision");
    expect(
      (
        await worker.complete(
          job.id,
          job.attempt,
          revisionResult({
            filesCount: 2,
            files: [aFile({ path: "a.ts" })],
            done: false,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await db.pool.query("SELECT state FROM review_revisions")).rows,
    ).toEqual([{ state: "pending" }]);
    expect((await db.pool.query("SELECT path FROM review_files")).rows).toEqual(
      [{ path: "a.ts" }],
    );
    expect(
      (
        await worker.complete(
          job.id,
          job.attempt,
          revisionResult({
            filesCount: 2,
            files: [aFile({ path: "b.ts", newBlob: SHA3 })],
            done: true,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await db.pool.query("SELECT state FROM review_revisions")).rows,
    ).toEqual([{ state: "ready" }]);
    expect(
      (await db.pool.query("SELECT path FROM review_files ORDER BY path")).rows,
    ).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
    expect(pullId).toBeGreaterThan(0);
  });

  it("records a seen-by-blob row so an unchanged blob stays viewed across heads", async () => {
    const { pullId } = await settledAndOpen();
    const job = await claimOf("review-revision");
    await worker.complete(
      job.id,
      job.attempt,
      revisionResult({
        filesCount: 1,
        files: [aFile()],
        blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
      }),
    );
    await inTransaction(db.pool, async (client: pg.PoolClient) => {
      await markReviewFileViewed(client, {
        pullId,
        path: "src/a.ts",
        newBlob: SHA2,
        viewedAt: clock.now(),
      });
    });
    const views = await db.pool.query(
      "SELECT path, new_blob FROM review_file_views",
    );
    expect(views.rows).toEqual([{ path: "src/a.ts", new_blob: SHA2 }]);
    await inTransaction(db.pool, async (client: pg.PoolClient) => {
      await markReviewFileViewed(client, {
        pullId,
        path: "src/a.ts",
        newBlob: SHA3,
        viewedAt: clock.now(),
      });
    });
    expect(
      (await db.pool.query("SELECT path, new_blob FROM review_file_views"))
        .rows,
    ).toEqual([{ path: "src/a.ts", new_blob: SHA3 }]);
  });

  it("drops patches, hunks and unreferenced blobs 90 days after the spec is cancelled", async () => {
    const { pullId } = await settledAndOpen();
    const job = await claimOf("review-revision");
    await worker.complete(
      job.id,
      job.attempt,
      revisionResult({
        filesCount: 1,
        files: [
          aFile({
            hunks: [
              {
                newStart: 1,
                newLines: 1,
                oldStart: 1,
                oldLines: 1,
                owners: [{ ticket: "T-1", lines: 1 }],
              },
            ],
            sincePatch: "@@ -1 +1 @@\n-a\n+b\n",
          }),
        ],
        blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
      }),
    );
    const specId = (
      await db.pool.query<{ spec_id: number }>(
        "SELECT spec_id FROM pull_requests WHERE id = $1",
        [pullId],
      )
    ).rows[0]?.spec_id as number;
    await db.pool.query("UPDATE specs SET state = 'cancelled' WHERE id = $1", [
      specId,
    ]);
    await db.pool.query(
      `UPDATE events SET at = $2 WHERE spec_id = $1 AND type = 'spec' AND to_state = 'cancelled'`,
      [specId, clock.now()],
    );
    const DAY = 24 * 60 * 60;
    clock.advanceSeconds(89 * DAY);
    await retainLogs({
      pool: db.pool,
      logs: new LogStore("/tmp/afk-review-rev-logs"),
      now: clock.now(),
      retentionDays: 90,
    });
    expect(
      (await db.pool.query("SELECT patch FROM review_files")).rows[0].patch,
    ).not.toBeNull();
    clock.advanceSeconds(DAY);
    await retainLogs({
      pool: db.pool,
      logs: new LogStore("/tmp/afk-review-rev-logs"),
      now: clock.now(),
      retentionDays: 90,
    });
    const file = (
      await db.pool.query(
        "SELECT path, patch, since_patch, hunks FROM review_files",
      )
    ).rows[0];
    expect(file).toMatchObject({
      path: "src/a.ts",
      patch: null,
      since_patch: null,
      hunks: null,
    });
    expect((await db.pool.query("SELECT sha FROM review_blobs")).rows).toEqual(
      [],
    );
  });
});

const specState = async () =>
  (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;
