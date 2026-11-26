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
    }
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

async function commentsOf(pullId: number) {
  return call("GET", `/pull-requests/${pullId}/review-comments`);
}

describe("POST /pull-requests/{id}/review-comments", () => {
  it("writes a line draft on awaiting-review, lists it as C-n, and pins it to that revision", async () => {
    const opened = await readyRevision();
    const created = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      {
        revisionId: opened.revisionId,
        path: "src/a.ts",
        side: "new",
        lineStart: 1,
        lineEnd: 1,
        excerpt: "b",
        body: "empty list should return 200 and []",
      },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      displayId: `C-${created.body.id}`,
      state: "draft",
      path: "src/a.ts",
      side: "new",
      lineStart: 1,
      lineEnd: 1,
      excerpt: "b",
      body: "empty list should return 200 and []",
      changeRequestId: null,
      writtenOn: opened.headSha,
    });
    const listed = await commentsOf(opened.pullId);
    expect(listed.status).toBe(200);
    expect(listed.body.comments).toEqual([created.body]);
    const review = await call("GET", `/specs/${opened.specId}/review`);
    expect(review.body.pullRequests[0].revision.commentCount).toBe(1);
  });

  it("writes a file draft and a PR draft", async () => {
    const opened = await readyRevision();
    const file = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      {
        revisionId: opened.revisionId,
        path: "src/a.ts",
        body: "rename this to match the glossary",
      },
    );
    const pr = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      {
        revisionId: opened.revisionId,
        body: "migrations must be safe to re-run",
      },
    );
    expect(file.status).toBe(201);
    expect(file.body).toMatchObject({
      path: "src/a.ts",
      side: null,
      lineStart: null,
      lineEnd: null,
      state: "draft",
    });
    expect(pr.status).toBe(201);
    expect(pr.body).toMatchObject({
      path: null,
      side: null,
      lineStart: null,
      lineEnd: null,
      state: "draft",
    });
    const listed = await commentsOf(opened.pullId);
    expect(listed.body.comments.map((row: Json) => row.displayId)).toEqual([
      file.body.displayId,
      pr.body.displayId,
    ]);
  });

  it("refuses a draft when the spec is not awaiting-review", async () => {
    const opened = await readyRevision();
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = $1", [
      opened.specId,
    ]);
    const refused = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      {
        revisionId: opened.revisionId,
        body: "too late",
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/awaiting-review/);
    expect((await commentsOf(opened.pullId)).body.comments).toEqual([]);
  });

  it("refuses a body outside 1..4000 characters", async () => {
    const opened = await readyRevision();
    expect(
      (
        await call("POST", `/pull-requests/${opened.pullId}/review-comments`, {
          revisionId: opened.revisionId,
          body: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/pull-requests/${opened.pullId}/review-comments`, {
          revisionId: opened.revisionId,
          body: "x".repeat(4001),
        })
      ).status,
    ).toBe(400);
  });
});

describe("PATCH and DELETE /review-comments/{id}", () => {
  it("edits and deletes a draft", async () => {
    const opened = await readyRevision();
    const created = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      {
        revisionId: opened.revisionId,
        path: "src/a.ts",
        body: "first wording",
      },
    );
    const edited = await call("PATCH", `/review-comments/${created.body.id}`, {
      body: "second wording",
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      id: created.body.id,
      displayId: created.body.displayId,
      body: "second wording",
      state: "draft",
    });
    expect(
      (await call("DELETE", `/review-comments/${created.body.id}`)).status,
    ).toBe(200);
    expect((await commentsOf(opened.pullId)).body.comments).toEqual([]);
  });

  it("does not edit or delete a submitted comment", async () => {
    const opened = await readyRevision();
    const seeded = await db.pool.query<{ id: number }>(
      `INSERT INTO review_comments (
         spec_id, pull_request_id, revision_id, path, body, state
       ) VALUES ($1, $2, $3, $4, $5, 'submitted')
       RETURNING id`,
      [
        opened.specId,
        opened.pullId,
        opened.revisionId,
        "src/a.ts",
        "already sent",
      ],
    );
    const id = seeded.rows[0]?.id as number;
    expect(
      (
        await call("PATCH", `/review-comments/${id}`, {
          body: "rewrite",
        })
      ).status,
    ).toBe(409);
    expect((await call("DELETE", `/review-comments/${id}`)).status).toBe(409);
    const listed = await commentsOf(opened.pullId);
    expect(listed.body.comments).toMatchObject([
      { id, displayId: `C-${id}`, state: "submitted", body: "already sent" },
    ]);
  });

  it("refuses edit and delete when the spec is not awaiting-review", async () => {
    const opened = await readyRevision();
    const created = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      { revisionId: opened.revisionId, body: "hold this" },
    );
    await db.pool.query("UPDATE specs SET state = 'running' WHERE id = $1", [
      opened.specId,
    ]);
    expect(
      (
        await call("PATCH", `/review-comments/${created.body.id}`, {
          body: "changed",
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("DELETE", `/review-comments/${created.body.id}`)).status,
    ).toBe(409);
    expect((await commentsOf(opened.pullId)).body.comments).toMatchObject([
      { id: created.body.id, body: "hold this", state: "draft" },
    ]);
  });
});

describe("cancelling a spec", () => {
  it("deletes drafts and leaves submitted comments", async () => {
    const opened = await readyRevision();
    const draft = await call(
      "POST",
      `/pull-requests/${opened.pullId}/review-comments`,
      { revisionId: opened.revisionId, body: "scratch this" },
    );
    const seeded = await db.pool.query<{ id: number }>(
      `INSERT INTO review_comments (
         spec_id, pull_request_id, revision_id, body, state
       ) VALUES ($1, $2, $3, $4, 'submitted')
       RETURNING id`,
      [opened.specId, opened.pullId, opened.revisionId, "keep this"],
    );
    expect((await call("POST", `/specs/${opened.specId}/cancel`)).status).toBe(
      200,
    );
    const listed = await commentsOf(opened.pullId);
    expect(listed.body.comments).toMatchObject([
      {
        id: seeded.rows[0]?.id,
        displayId: `C-${seeded.rows[0]?.id}`,
        state: "submitted",
        body: "keep this",
      },
    ]);
    expect(listed.body.comments.map((row: Json) => row.id)).not.toContain(
      draft.body.id,
    );
  });
});
