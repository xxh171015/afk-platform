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
  method: "GET" | "POST" | "PUT" | "DELETE",
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
const SHA3 = "c".repeat(40);
const SHA4 = "e".repeat(40);
const UNKNOWN = "f".repeat(40);

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
    if (job.type === "review-note" && type !== "review-note") {
      await worker.complete(job.id, job.attempt, {
        stage: "review-note",
        outcome: "upserted",
      });
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
  sincePatch: "@@ -1 +1 @@\n-old\n+b\n",
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

async function readyRevision(
  files: Record<string, unknown>[] = [aFile()],
  blobs: { sha: string; content: string; bytes: number }[] = [
    { sha: SHA2, content: "line-one\nline-two\nline-three\n", bytes: 29 },
  ],
) {
  const opened = await settledAndOpen();
  const job = await claimOf("review-revision");
  expect(
    (
      await worker.complete(
        job.id,
        job.attempt,
        revisionResult({
          headSha: opened.headSha,
          filesCount: files.length,
          additions: files.length,
          files,
          blobs,
        }),
      )
    ).status,
  ).toBe(200);
  return opened;
}

function viewedPath(pullId: number, path: string) {
  return `/pull-requests/${pullId}/viewed-files/${encodeURIComponent(path)}`;
}

describe("GET /specs/{id}/review", () => {
  it("returns 404 when the spec does not exist", async () => {
    expect((await call("GET", "/specs/9/review")).status).toBe(404);
  });

  it("returns each PR's head, pending Review revision, User Stories, ticket stories, and pack fields without stories", async () => {
    const { specId, pullId, headSha } = await settledAndOpen();
    const got = await call("GET", `/specs/${specId}/review`);
    expect(got.status).toBe(200);
    expect(got.body.spec).toMatchObject({
      id: specId,
      displayId: `S-${specId}`,
      title: "Export orders",
    });
    expect(got.body.userStories).toEqual([
      { number: 1, text: "As a merchant, I want to export orders." },
    ]);
    expect(got.body.pullRequests).toMatchObject([
      {
        id: pullId,
        repo: "backend",
        number: 7,
        headSha,
        reviewNoteError: null,
        revision: {
          state: "pending",
          viewedCount: 0,
          commentCount: 0,
        },
      },
    ]);
    expect(got.body.tickets[0]).toMatchObject({
      displayId: "T-1",
      stories: [1],
      criteria: [
        expect.objectContaining({
          text: "be works",
          status: expect.stringMatching(/verified|unverified/),
        }),
      ],
    });
    expect(got.body.acceptancePack.repos[0].tickets[0]).not.toHaveProperty(
      "stories",
    );
    expect(
      got.body.findings.every((item: Json) => item.path === undefined),
    ).toBe(true);
    expect(got.body.autoMerge).toMatchObject({ policy: "manual" });
  });
});

describe("GET /pull-requests/{id}/review-revision", () => {
  it("returns 404 for a pull request that does not exist", async () => {
    expect(
      (await call("GET", `/pull-requests/99/review-revision?head=${SHA}`))
        .status,
    ).toBe(404);
  });

  it("enqueues compute and returns pending when the current head is not ready, including after a failure", async () => {
    const { pullId, headSha } = await settledAndOpen();
    const first = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${headSha}`,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "pending", headSha });
    const queued = await jobsOf("review-revision");
    expect(queued).toHaveLength(1);
    expect(Object.keys(queued[0].payload).sort()).toEqual([
      "headSha",
      "previousHeadSha",
      "pullId",
    ]);
    const job = await claimOf("review-revision");
    expect((await worker.fail(job.id, job.attempt, "git failed")).status).toBe(
      200,
    );
    const again = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${headSha}`,
    );
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("pending");
    expect(await jobsOf("review-revision")).toHaveLength(2);
    expect((await jobsOf("review-revision"))[1].idempotency_key).toBe(
      `pull-${pullId}:review-revision:${headSha}:2`,
    );
  });

  it("returns the file list, attributions and viewed flags when the revision is ready", async () => {
    const { pullId, headSha } = await readyRevision();
    const got = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${headSha}`,
    );
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      state: "ready",
      headSha,
      filesCount: 1,
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          newBlob: SHA2,
          attributions: [{ ticket: "T-1" }],
          viewed: false,
        },
      ],
    });
    expect(got.body.files[0].patch).toBeUndefined();
  });

  it("returns 404 for a head that is not this pull request's current head and has no ready revision", async () => {
    const { pullId } = await settledAndOpen();
    expect(
      (
        await call(
          "GET",
          `/pull-requests/${pullId}/review-revision?head=${UNKNOWN}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("GET /review-files/{id}", () => {
  it("returns the stored patch or the since-last-review patch", async () => {
    const opened = await readyRevision();
    const files = await call(
      "GET",
      `/pull-requests/${opened.pullId}/review-revision?head=${opened.headSha}`,
    );
    const fileId = files.body.files[0].id as number;
    const all = await call("GET", `/review-files/${fileId}?view=all`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      id: fileId,
      path: "src/a.ts",
      view: "all",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    });
    const since = await call("GET", `/review-files/${fileId}?view=since`);
    expect(since.body).toMatchObject({
      view: "since",
      patch: "@@ -1 +1 @@\n-old\n+b\n",
    });
  });

  it("returns 404 for an unknown file", async () => {
    expect((await call("GET", "/review-files/9?view=all")).status).toBe(404);
  });
});

describe("GET /review-blobs/{sha}", () => {
  it("returns the requested lines of a blob that belongs to a Review revision", async () => {
    await readyRevision();
    const got = await call("GET", `/review-blobs/${SHA2}?from=2&to=3`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      sha: SHA2,
      from: 2,
      to: 3,
      stored: true,
      lines: ["line-two", "line-three"],
    });
  });

  it("returns 404 for a SHA that is not in any Review revision", async () => {
    await readyRevision();
    expect(
      (await call("GET", `/review-blobs/${UNKNOWN}?from=1&to=1`)).status,
    ).toBe(404);
  });

  it("returns no lines when the blob was not stored because it was too large", async () => {
    const { pullId, headSha } = await readyRevision(
      [aFile({ newBlob: SHA3 })],
      [],
    );
    expect(pullId).toBeGreaterThan(0);
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);
    const got = await call("GET", `/review-blobs/${SHA3}?from=1&to=20`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      sha: SHA3,
      from: 1,
      to: 20,
      stored: false,
      lines: [],
    });
  });
});

describe("PUT and DELETE viewed files", () => {
  it("marks a file viewed by blob so unchanged content stays viewed and a changed blob does not", async () => {
    const { specId, pullId, headSha } = await readyRevision([
      aFile(),
      aFile({ path: "src/b.ts", newBlob: SHA3, oldBlob: SHA, patch: "@@\n" }),
    ]);
    const mark = await call("PUT", viewedPath(pullId, "src/a.ts"), {
      newBlob: SHA2,
    });
    expect(mark.status).toBe(200);
    expect(mark.body).toEqual({ viewed: true });
    const revision = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${headSha}`,
    );
    expect(
      revision.body.files.map((file: Json) => [file.path, file.viewed]),
    ).toEqual([
      ["src/a.ts", true],
      ["src/b.ts", false],
    ]);
    const spec = await call("GET", `/specs/${specId}/review`);
    expect(spec.body.pullRequests[0].revision).toMatchObject({
      filesCount: 2,
      viewedCount: 1,
    });
    expect(
      (await call("DELETE", viewedPath(pullId, "src/a.ts"), { newBlob: SHA2 }))
        .body,
    ).toEqual({ viewed: false });
    const after = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${headSha}`,
    );
    expect(after.body.files[0].viewed).toBe(false);
    await call("PUT", viewedPath(pullId, "src/a.ts"), { newBlob: SHA2 });
    await db.pool.query(
      "UPDATE pull_requests SET head_sha = $2 WHERE id = $1",
      [pullId, SHA4],
    );
    const pending = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${SHA4}`,
    );
    expect(pending.body.state).toBe("pending");
    const next = await claimOf("review-revision");
    await worker.complete(
      next.id,
      next.attempt,
      revisionResult({
        headSha: SHA4,
        filesCount: 1,
        files: [aFile({ newBlob: SHA2 })],
        blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
      }),
    );
    const sameBlob = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${SHA4}`,
    );
    expect(sameBlob.body.files[0].viewed).toBe(true);
    await db.pool.query(
      "UPDATE pull_requests SET head_sha = $2 WHERE id = $1",
      [pullId, UNKNOWN],
    );
    const later = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${UNKNOWN}`,
    );
    expect(later.body.state).toBe("pending");
    const third = await claimOf("review-revision");
    await worker.complete(
      third.id,
      third.attempt,
      revisionResult({
        headSha: UNKNOWN,
        filesCount: 1,
        files: [aFile({ newBlob: SHA3 })],
        blobs: [],
      }),
    );
    const changed = await call(
      "GET",
      `/pull-requests/${pullId}/review-revision?head=${UNKNOWN}`,
    );
    expect(changed.body.files[0].viewed).toBe(false);
  });

  it("returns 404 when the pull request does not exist", async () => {
    expect(
      (await call("PUT", viewedPath(99, "src/a.ts"), { newBlob: SHA2 })).status,
    ).toBe(404);
    expect(
      (await call("DELETE", viewedPath(99, "src/a.ts"), { newBlob: SHA2 }))
        .status,
    ).toBe(404);
  });
});

describe("review table events", () => {
  it("writes review-revision and viewed-file events from the tables' triggers", async () => {
    const { pullId, headSha } = await readyRevision();
    const types = (
      await db.pool.query<{ type: string; to_state: string | null }>(
        `SELECT type, to_state FROM events
         WHERE type IN ('review-revision', 'review-file-view') ORDER BY id`,
      )
    ).rows;
    expect(types).toEqual(
      expect.arrayContaining([
        { type: "review-revision", to_state: "pending" },
        { type: "review-revision", to_state: "ready" },
      ]),
    );
    await call("PUT", viewedPath(pullId, "src/a.ts"), { newBlob: SHA2 });
    const viewed = (
      await db.pool.query<{ type: string; to_state: string | null }>(
        `SELECT type, to_state FROM events WHERE type = 'review-file-view' ORDER BY id`,
      )
    ).rows;
    expect(viewed).toEqual([{ type: "review-file-view", to_state: "viewed" }]);
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
