import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeClock,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  clock = new FakeClock();
  api = await listen(
    testApp({
      pool: db.pool,
      clock: clock.now,
    }),
  );
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
  return {
    status: response.status,
    body: (await response.json()) as Json,
  };
}

const sha = (digit: string) => digit.repeat(40);

async function shop(name = "shop") {
  const project = await db.pool.query<{ id: number }>(
    "INSERT INTO projects (name) VALUES ($1) RETURNING id",
    [name],
  );
  const projectId = project.rows[0].id;
  const backend = await db.pool.query<{ id: number }>(
    `INSERT INTO repos (project_id, url, name)
     VALUES ($1, 'git@x:backend', 'backend') RETURNING id`,
    [projectId],
  );
  return { projectId, backendId: backend.rows[0].id };
}

async function specRow(input: {
  projectId: number;
  slug: string;
  title: string;
  state: string;
  type?: string;
}) {
  const spec = await db.pool.query<{ id: number }>(
    `INSERT INTO specs (project_id, type, slug, title, state)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.projectId,
      input.type ?? "feature",
      input.slug,
      input.title,
      input.state,
    ],
  );
  return spec.rows[0].id;
}

async function addPull(
  specId: number,
  repoId: number,
  number: number,
  input: { headSha?: string; ci?: string; conflicts?: boolean } = {},
) {
  const pull = await db.pool.query<{ id: number }>(
    `INSERT INTO pull_requests
       (spec_id, repo_id, number, url, state, head_sha, ci, conflicts_with_default)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)
     RETURNING id`,
    [
      specId,
      repoId,
      number,
      `https://git.example/pr/${number}`,
      input.headSha ?? sha("a"),
      input.ci ?? "none",
      input.conflicts === true,
    ],
  );
  return pull.rows[0].id;
}

async function addReadyRevision(
  pullId: number,
  files: {
    path: string;
    additions: number;
    deletions: number;
    newBlob: string;
    viewed?: boolean;
    sincePatch?: string | null;
  }[],
  headSha = sha("a"),
) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const revision = await db.pool.query<{ id: number }>(
    `INSERT INTO review_revisions
       (pull_request_id, head_sha, state, complete, files_count, additions, deletions, ready_at)
     VALUES ($1, $2, 'ready', true, $3, $4, $5, now())
     RETURNING id`,
    [pullId, headSha, files.length, additions, deletions],
  );
  const revisionId = revision.rows[0].id;
  for (const file of files) {
    await db.pool.query(
      `INSERT INTO review_files
         (revision_id, path, status, old_blob, new_blob, additions, deletions, since_patch)
       VALUES ($1, $2, 'modified', $3, $4, $5, $6, $7)`,
      [
        revisionId,
        file.path,
        sha("0"),
        file.newBlob,
        file.additions,
        file.deletions,
        file.sincePatch ?? null,
      ],
    );
    if (file.viewed) {
      await db.pool.query(
        `INSERT INTO review_file_views (pull_request_id, path, new_blob, viewed_at)
         VALUES ($1, $2, $3, now())`,
        [pullId, file.path, file.newBlob],
      );
    }
  }
}

async function setPack(specId: number, content: Record<string, unknown>) {
  await db.pool.query(
    `INSERT INTO acceptance_packs (spec_id, content) VALUES ($1, $2::jsonb)
     ON CONFLICT (spec_id) DO UPDATE SET content = $2::jsonb`,
    [specId, JSON.stringify(content)],
  );
}

function idsOf(rows: { spec: { id: number } }[]) {
  return rows.map((row) => row.spec.id);
}

describe("GET /review-queue", () => {
  it("returns four empty groups when nothing is waiting for review", async () => {
    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      waitingForYou: [],
      inProgress: [],
      inRework: [],
      readyToMerge: [],
    });
  });

  it("puts specs into 等你审, 审到一半, 返工中 and 看完待合并", async () => {
    const { projectId, backendId } = await shop();
    const waitingId = await specRow({
      projectId,
      slug: "wait",
      title: "Wait",
      state: "awaiting-review",
    });
    const waitingPull = await addPull(waitingId, backendId, 1);
    await addReadyRevision(waitingPull, [
      { path: "a.ts", additions: 4, deletions: 1, newBlob: sha("1") },
    ]);

    const halfId = await specRow({
      projectId,
      slug: "half",
      title: "Half",
      state: "awaiting-review",
    });
    const halfPull = await addPull(halfId, backendId, 2);
    await addReadyRevision(halfPull, [
      {
        path: "a.ts",
        additions: 2,
        deletions: 0,
        newBlob: sha("2"),
        viewed: true,
      },
      { path: "b.ts", additions: 3, deletions: 0, newBlob: sha("3") },
    ]);

    const sinceId = await specRow({
      projectId,
      slug: "since",
      title: "Since",
      state: "awaiting-review",
    });
    const sincePull = await addPull(sinceId, backendId, 3);
    await addReadyRevision(sincePull, [
      {
        path: "a.ts",
        additions: 1,
        deletions: 0,
        newBlob: sha("4"),
        sincePatch: "diff --git a/a.ts b/a.ts",
      },
    ]);

    const readyId = await specRow({
      projectId,
      slug: "ready",
      title: "Ready",
      state: "awaiting-review",
    });
    const readyPull = await addPull(readyId, backendId, 4);
    await addReadyRevision(readyPull, [
      {
        path: "a.ts",
        additions: 1,
        deletions: 0,
        newBlob: sha("5"),
        viewed: true,
      },
    ]);

    const partialId = await specRow({
      projectId,
      slug: "partial",
      title: "Partial",
      state: "partially-merged",
    });
    await addPull(partialId, backendId, 5);

    const runningId = await specRow({
      projectId,
      slug: "run",
      title: "Running",
      state: "running",
    });

    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(idsOf(reply.body.waitingForYou)).toEqual([waitingId]);
    expect(idsOf(reply.body.inProgress).sort()).toEqual(
      [halfId, sinceId].sort(),
    );
    expect(idsOf(reply.body.readyToMerge).sort()).toEqual(
      [readyId, partialId].sort(),
    );
    expect(idsOf(reply.body.inRework)).toEqual([]);
    expect(
      idsOf(reply.body.waitingForYou).concat(idsOf(reply.body.inProgress)),
    ).not.toContain(runningId);

    const wait = reply.body.waitingForYou[0];
    expect(wait.spec).toMatchObject({
      id: waitingId,
      displayId: `S-${waitingId}`,
      title: "Wait",
      type: "feature",
      state: "awaiting-review",
      project: "shop",
    });
    expect(wait.repos).toEqual(["backend"]);
    expect(wait.pullRequestCount).toBe(1);
    expect(wait.additions).toBe(4);
    expect(wait.deletions).toBe(1);
    expect(wait.viewedCount).toBe(0);
    expect(wait.filesCount).toBe(1);

    const half = reply.body.inProgress.find(
      (row: { spec: { id: number } }) => row.spec.id === halfId,
    );
    expect(half.viewedCount).toBe(1);
    expect(half.filesCount).toBe(2);
  });

  it("puts append-ticket reworking and change-request finalizing in 返工中, and keeps a first wrap-up out", async () => {
    const { projectId, backendId } = await shop();
    const appendId = await specRow({
      projectId,
      slug: "append",
      title: "Append",
      state: "reworking",
    });
    await addPull(appendId, backendId, 1);

    const changeId = await specRow({
      projectId,
      slug: "change",
      title: "Change",
      state: "awaiting-review",
    });
    await addPull(changeId, backendId, 2);
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = $1", [
      changeId,
    ]);

    const firstId = await specRow({
      projectId,
      slug: "first",
      title: "First wrap-up",
      state: "finalizing",
    });
    await addPull(firstId, backendId, 3);

    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(idsOf(reply.body.inRework).sort()).toEqual(
      [appendId, changeId].sort(),
    );
    expect(idsOf(reply.body.inRework)).not.toContain(firstId);
    expect(idsOf(reply.body.waitingForYou)).not.toContain(firstId);
    expect(idsOf(reply.body.inProgress)).not.toContain(firstId);
    expect(idsOf(reply.body.readyToMerge)).not.toContain(firstId);
  });

  it("orders a group by risk tags, not a score", async () => {
    const { projectId, backendId } = await shop();
    const frontend = await db.pool.query<{ id: number }>(
      `INSERT INTO repos (project_id, url, name)
       VALUES ($1, 'git@x:frontend', 'frontend') RETURNING id`,
      [projectId],
    );
    const frontendId = frontend.rows[0].id;

    const humanId = await specRow({
      projectId,
      slug: "human",
      title: "Needs human",
      state: "awaiting-review",
    });
    const humanPull = await addPull(humanId, backendId, 1);
    await addReadyRevision(humanPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("1") },
    ]);
    await setPack(humanId, {
      needsDecision: [{ kind: "needs-human" }],
      orderBroken: [],
      repos: [],
    });

    const ciId = await specRow({
      projectId,
      slug: "ci",
      title: "CI failed",
      state: "awaiting-review",
    });
    const ciPull = await addPull(ciId, backendId, 2, { ci: "failure" });
    await addReadyRevision(ciPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("2") },
    ]);

    const unverifiedId = await specRow({
      projectId,
      slug: "unverified",
      title: "Unverified",
      state: "awaiting-review",
    });
    const unverifiedPull = await addPull(unverifiedId, backendId, 3);
    await addReadyRevision(unverifiedPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("3") },
    ]);
    await setPack(unverifiedId, {
      needsDecision: [{ kind: "deferred" }, { kind: "host-check" }],
      orderBroken: [],
      repos: [
        {
          tickets: [
            {
              criteria: [{ status: "unverified" }],
            },
          ],
          protectedPathApprovals: [],
        },
      ],
    });

    const protectedId = await specRow({
      projectId,
      slug: "prot",
      title: "Protected",
      state: "awaiting-review",
    });
    const protectedPull = await addPull(protectedId, backendId, 4);
    await addReadyRevision(protectedPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("4") },
    ]);
    await db.pool.query(
      `INSERT INTO tickets
         (spec_id, repo_id, type, title, allowed_protected_paths, allowed_removed_tests)
       VALUES ($1, $2, 'implementation', 'T', ARRAY['AGENTS.md'], $3::jsonb)`,
      [protectedId, backendId, JSON.stringify([{ classname: "A", name: "b" }])],
    );

    const multiId = await specRow({
      projectId,
      slug: "multi",
      title: "Multi",
      state: "awaiting-review",
    });
    const multiPullA = await addPull(multiId, backendId, 5);
    const multiPullB = await addPull(multiId, frontendId, 6, {
      headSha: sha("b"),
    });
    await addReadyRevision(multiPullA, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("5") },
    ]);
    await addReadyRevision(
      multiPullB,
      [{ path: "b.ts", additions: 1, deletions: 0, newBlob: sha("6") }],
      sha("b"),
    );
    const fromTicket = await db.pool.query<{ id: number }>(
      `INSERT INTO tickets (spec_id, repo_id, type, title)
       VALUES ($1, $2, 'implementation', 'From') RETURNING id`,
      [multiId, backendId],
    );
    const toTicket = await db.pool.query<{ id: number }>(
      `INSERT INTO tickets (spec_id, repo_id, type, title)
       VALUES ($1, $2, 'implementation', 'To') RETURNING id`,
      [multiId, frontendId],
    );
    await db.pool.query(
      `INSERT INTO edges (from_ticket_id, to_ticket_id, kind)
       VALUES ($1, $2, 'contract')`,
      [fromTicket.rows[0].id, toTicket.rows[0].id],
    );

    const linesId = await specRow({
      projectId,
      slug: "lines",
      title: "Lines",
      state: "awaiting-review",
    });
    const linesPull = await addPull(linesId, backendId, 7);
    await addReadyRevision(linesPull, [
      { path: "a.ts", additions: 40, deletions: 2, newBlob: sha("7") },
    ]);

    const oldId = await specRow({
      projectId,
      slug: "old",
      title: "Old",
      state: "awaiting-review",
    });
    const oldPull = await addPull(oldId, backendId, 8);
    await addReadyRevision(oldPull, [
      { path: "a.ts", additions: 2, deletions: 0, newBlob: sha("8") },
    ]);
    await db.pool.query(
      `UPDATE events SET at = $2
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'awaiting-review'`,
      [oldId, new Date(clock.now().getTime() - 3 * 3600 * 1000)],
    );
    await db.pool.query(
      `UPDATE events SET at = $2
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'awaiting-review'`,
      [linesId, new Date(clock.now().getTime() - 60 * 1000)],
    );

    const conflictId = await specRow({
      projectId,
      slug: "conflict",
      title: "Conflict",
      state: "awaiting-review",
    });
    const conflictPull = await addPull(conflictId, backendId, 9, {
      conflicts: true,
    });
    await addReadyRevision(conflictPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("9") },
    ]);
    await db.pool.query(
      `UPDATE specs SET order_broken = $2::jsonb WHERE id = $1`,
      [
        conflictId,
        JSON.stringify([{ repo: "frontend", skipped: ["backend"] }]),
      ],
    );

    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(idsOf(reply.body.waitingForYou)).toEqual([
      humanId,
      ciId,
      conflictId,
      unverifiedId,
      protectedId,
      multiId,
      linesId,
      oldId,
    ]);
    expect(
      reply.body.waitingForYou.map(
        (row: { spec: { id: number }; riskTags: string[] }) => [
          row.spec.id,
          row.riskTags,
        ],
      ),
    ).toEqual([
      [humanId, ["待人定"]],
      [ciId, ["CI 失败"]],
      [conflictId, ["与默认分支冲突", "合并顺序被打破"]],
      [unverifiedId, ["未验证验收标准", "没做掉的 deferred", "host-check"]],
      [protectedId, ["保护路径改动", "删除测试"]],
      [multiId, ["多仓库", "有契约边"]],
      [linesId, []],
      [oldId, []],
    ]);
  });

  it("puts a spec with drafts in 审到一半 even when no file is viewed, and keeps drafts out of 看完待合并", async () => {
    const { projectId, backendId } = await shop("drafts");
    const draftOnlyId = await specRow({
      projectId,
      slug: "draft-only",
      title: "Draft only",
      state: "awaiting-review",
    });
    const draftPull = await addPull(draftOnlyId, backendId, 1);
    await addReadyRevision(draftPull, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("1") },
    ]);
    const draftRevision = await db.pool.query<{ id: number }>(
      "SELECT id FROM review_revisions WHERE pull_request_id = $1",
      [draftPull],
    );
    await db.pool.query(
      `INSERT INTO review_comments (
         spec_id, pull_request_id, revision_id, path, body, state
       ) VALUES ($1, $2, $3, 'a.ts', 'fix the empty list', 'draft')`,
      [draftOnlyId, draftPull, draftRevision.rows[0].id],
    );

    const viewedWithDraftId = await specRow({
      projectId,
      slug: "viewed-draft",
      title: "Viewed with draft",
      state: "awaiting-review",
    });
    const viewedPull = await addPull(viewedWithDraftId, backendId, 2);
    await addReadyRevision(viewedPull, [
      {
        path: "a.ts",
        additions: 1,
        deletions: 0,
        newBlob: sha("2"),
        viewed: true,
      },
    ]);
    const viewedRevision = await db.pool.query<{ id: number }>(
      "SELECT id FROM review_revisions WHERE pull_request_id = $1",
      [viewedPull],
    );
    await db.pool.query(
      `INSERT INTO review_comments (
         spec_id, pull_request_id, revision_id, path, body, state
       ) VALUES ($1, $2, $3, 'a.ts', 'rename this', 'draft')`,
      [viewedWithDraftId, viewedPull, viewedRevision.rows[0].id],
    );

    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(idsOf(reply.body.waitingForYou)).not.toContain(draftOnlyId);
    expect(idsOf(reply.body.inProgress).sort()).toEqual(
      [draftOnlyId, viewedWithDraftId].sort(),
    );
    expect(idsOf(reply.body.readyToMerge)).not.toContain(viewedWithDraftId);
  });

  it("tags 人审意见未处理 when a submitted Review comment is declined", async () => {
    const { projectId, backendId } = await shop("declined");
    const specId = await specRow({
      projectId,
      slug: "declined",
      title: "Declined comment",
      state: "awaiting-review",
    });
    const pullId = await addPull(specId, backendId, 1);
    await addReadyRevision(pullId, [
      { path: "a.ts", additions: 1, deletions: 0, newBlob: sha("1") },
    ]);
    const revision = await db.pool.query<{ id: number }>(
      "SELECT id FROM review_revisions WHERE pull_request_id = $1",
      [pullId],
    );
    await db.pool.query(
      `INSERT INTO review_comments (
         spec_id, pull_request_id, revision_id, path, body, state
       ) VALUES ($1, $2, $3, 'a.ts', 'do not do this', 'declined')`,
      [specId, pullId, revision.rows[0].id],
    );

    const reply = await call("GET", "/review-queue");
    expect(reply.status).toBe(200);
    expect(reply.body.waitingForYou).toMatchObject([
      {
        spec: { id: specId },
        riskTags: ["人审意见未处理"],
      },
    ]);
  });

  it("shows 未计算 and enqueues a Review revision when the spec has no ready one", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({
      projectId,
      slug: "pending",
      title: "Pending",
      state: "awaiting-review",
    });
    const pullId = await addPull(specId, backendId, 1, { headSha: sha("c") });

    const first = await call("GET", "/review-queue");
    expect(first.status).toBe(200);
    expect(first.body.waitingForYou).toMatchObject([
      {
        spec: { id: specId },
        viewedCount: null,
        filesCount: null,
      },
    ]);

    const jobs = await db.pool.query<{
      type: string;
      payload: { pullId: number; headSha: string };
    }>("SELECT type, payload FROM jobs WHERE type = 'review-revision'");
    expect(jobs.rows).toMatchObject([
      {
        type: "review-revision",
        payload: { pullId, headSha: sha("c") },
      },
    ]);

    const second = await call("GET", "/review-queue");
    expect(second.status).toBe(200);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM jobs WHERE type = 'review-revision'",
        )
      ).rowCount,
    ).toBe(1);
  });
});
