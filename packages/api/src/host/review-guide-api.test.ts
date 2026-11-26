import { formatDisplayId } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { listen, type RunningApi, testApp } from "../test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
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

const sha = (digit: string) => digit.repeat(40);

const STORIES_BODY = [
  "## User Stories",
  "",
  "1. As a merchant, I want to export orders.",
  "2. As a clerk, I want to print a packing slip.",
  "",
].join("\n");

async function shop() {
  const project = await db.pool.query<{ id: number }>(
    "INSERT INTO projects (name) VALUES ('shop') RETURNING id",
  );
  const projectId = project.rows[0].id;
  const backend = await db.pool.query<{ id: number }>(
    `INSERT INTO repos (project_id, url, name)
     VALUES ($1, 'git@x:backend', 'backend') RETURNING id`,
    [projectId],
  );
  const frontend = await db.pool.query<{ id: number }>(
    `INSERT INTO repos (project_id, url, name)
     VALUES ($1, 'git@x:frontend', 'frontend') RETURNING id`,
    [projectId],
  );
  return {
    projectId,
    backendId: backend.rows[0].id,
    frontendId: frontend.rows[0].id,
  };
}

async function specRow(input: {
  projectId: number;
  title?: string;
  type?: string;
  body?: string;
  sourceSpecId?: number;
}) {
  const spec = await db.pool.query<{ id: number }>(
    `INSERT INTO specs (project_id, type, slug, title, state, body, source_spec_id)
     VALUES ($1, $2, $3, $4, 'awaiting-review', $5, $6) RETURNING id`,
    [
      input.projectId,
      input.type ?? "feature",
      `spec-${Math.random().toString(16).slice(2, 8)}`,
      input.title ?? "Export orders",
      input.body ?? STORIES_BODY,
      input.sourceSpecId ?? null,
    ],
  );
  return spec.rows[0].id;
}

async function addTicket(input: {
  specId: number;
  repoId: number;
  title: string;
  stories?: number[];
  criteria?: string[];
  appended?: boolean;
}) {
  const ticket = await db.pool.query<{ id: number }>(
    `INSERT INTO tickets
       (spec_id, repo_id, type, title, state, stories, acceptance_criteria, appended)
     VALUES ($1, $2, 'implementation', $3, 'done', $4, $5, $6)
     RETURNING id`,
    [
      input.specId,
      input.repoId,
      input.title,
      input.stories ?? [1],
      input.criteria ?? ["export works"],
      input.appended === true,
    ],
  );
  return ticket.rows[0].id;
}

async function addPull(specId: number, repoId: number, number: number) {
  const pull = await db.pool.query<{ id: number }>(
    `INSERT INTO pull_requests
       (spec_id, repo_id, number, url, state, head_sha)
     VALUES ($1, $2, $3, $4, 'open', $5)
     RETURNING id`,
    [specId, repoId, number, `https://git.example/pr/${number}`, sha("a")],
  );
  return pull.rows[0].id;
}

async function addRun(input: {
  specId: number;
  repoId: number;
  ticketId?: number | null;
  stage: string;
  result: string;
  output: unknown;
  finishedAt: Date;
  axis?: string | null;
}) {
  const run = await db.pool.query<{ id: number }>(
    `INSERT INTO runs
       (spec_id, repo_id, ticket_id, stage, result, output, finished_at, axis)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      input.specId,
      input.repoId,
      input.ticketId ?? null,
      input.stage,
      input.result,
      JSON.stringify(input.output),
      input.finishedAt,
      input.axis ?? null,
    ],
  );
  return run.rows[0].id;
}

type FileSpec = {
  path: string;
  attributions: unknown[];
  hunks: unknown[] | null;
  newBlob?: string;
};

async function addReadyRevision(
  pullId: number,
  files: FileSpec[],
  headSha = sha("a"),
) {
  const revision = await db.pool.query<{ id: number }>(
    `INSERT INTO review_revisions
       (pull_request_id, head_sha, state, complete, files_count, additions, deletions, ready_at)
     VALUES ($1, $2, 'ready', true, $3, $3, 0, now())
     RETURNING id`,
    [pullId, headSha, files.length],
  );
  const revisionId = revision.rows[0].id;
  const ids: number[] = [];
  for (const file of files) {
    const row = await db.pool.query<{ id: number }>(
      `INSERT INTO review_files
         (revision_id, path, status, old_blob, new_blob, additions, deletions,
          attributions, hunks)
       VALUES ($1, $2, 'modified', $3, $4, 1, 0, $5::jsonb, $6::jsonb)
       RETURNING id`,
      [
        revisionId,
        file.path,
        sha("0"),
        file.newBlob ?? sha("b"),
        JSON.stringify(file.attributions),
        file.hunks === null ? null : JSON.stringify(file.hunks),
      ],
    );
    ids.push(row.rows[0].id);
  }
  return { revisionId, fileIds: ids };
}

function hunk(
  ticket: string | null,
  extra: {
    newStart?: number;
    newLines?: number;
    oldStart?: number;
    oldLines?: number;
    kind?: string;
    owners?: unknown[];
    lines?: number;
  } = {},
): Record<string, unknown> {
  const owners = extra.owners
    ? extra.owners
    : ticket
      ? [{ ticket, lines: extra.lines ?? 1 }]
      : [{ kind: extra.kind ?? "unknown", lines: extra.lines ?? 1 }];
  return {
    newStart: extra.newStart ?? 1,
    newLines: extra.newLines ?? 1,
    oldStart: extra.oldStart ?? 1,
    oldLines: extra.oldLines ?? 1,
    owners,
  };
}

describe("GET /review-revisions/{id}/guide", () => {
  it("returns 404 when the Review revision does not exist", async () => {
    expect((await call("GET", "/review-revisions/99/guide")).status).toBe(404);
  });

  it("names the original spec on a bug", async () => {
    const { projectId, backendId } = await shop();
    const sourceId = await specRow({ projectId, title: "Export orders" });
    const specId = await specRow({
      projectId,
      type: "bug",
      title: "Export is empty",
      sourceSpecId: sourceId,
    });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Fix empty export",
    });
    const pullId = await addPull(specId, backendId, 7);
    const { revisionId } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
      },
    ]);
    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.spec).toMatchObject({
      title: "Export is empty",
      type: "bug",
      sourceSpec: {
        id: sourceId,
        displayId: formatDisplayId("spec", sourceId),
        title: "Export orders",
      },
    });
  });

  it("orders ticket sections by dependency edges and same-layer ticket id", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const t2 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export CSV",
      stories: [1],
      criteria: ["csv works"],
    });
    const t3 = await addTicket({
      specId,
      repoId: backendId,
      title: "Appended printer",
      stories: [2],
      criteria: ["print works"],
      appended: true,
    });
    await db.pool.query(
      `INSERT INTO edges (from_ticket_id, to_ticket_id, kind)
       VALUES ($1, $2, 'blocks')`,
      [t1, t2],
    );
    const pullId = await addPull(specId, backendId, 7);
    const { revisionId, fileIds } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
      },
      {
        path: "src/b.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t2) }],
        hunks: [hunk(formatDisplayId("ticket", t2), { newStart: 4 })],
      },
      {
        path: "src/c.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t3) }],
        hunks: [hunk(formatDisplayId("ticket", t3), { newStart: 8 })],
      },
    ]);

    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.spec).toMatchObject({
      id: specId,
      displayId: formatDisplayId("spec", specId),
      title: "Export orders",
      type: "feature",
      userStories: [
        { number: 1, text: "As a merchant, I want to export orders." },
        { number: 2, text: "As a clerk, I want to print a packing slip." },
      ],
      sourceSpec: null,
    });
    expect(got.body.tickets.map((row: Json) => row.displayId)).toEqual([
      formatDisplayId("ticket", t1),
      formatDisplayId("ticket", t3),
      formatDisplayId("ticket", t2),
    ]);
    expect(got.body.tickets[1]).toMatchObject({
      title: "Appended printer",
      appended: true,
      stories: [
        { number: 2, text: "As a clerk, I want to print a packing slip." },
      ],
    });
    expect(got.body.tickets[0].hunks).toEqual([
      expect.objectContaining({
        fileId: fileIds[0],
        path: "src/a.ts",
        newStart: 1,
      }),
    ]);
    expect(got.body.changeRequests).toEqual([]);
    expect(got.body.acceptancePack).toBeUndefined();
  });

  it("lists summaries of successful code-changing runs, newest first, and omits failed or empty ones", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const pullId = await addPull(specId, backendId, 7);
    const { revisionId } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
      },
    ]);
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");
    const failedAt = new Date("2026-01-03T00:00:00.000Z");
    const emptyAt = new Date("2026-01-04T00:00:00.000Z");
    const implementId = await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "implement",
      result: "done",
      output: {
        summary: "added the export endpoint",
        decisions: [{ kind: "choice", text: "return JSON" }],
      },
      finishedAt: earlier,
    });
    const fixId = await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "gate-fix",
      result: "done",
      output: { summary: "fixed the gate" },
      finishedAt: later,
    });
    await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "review-fix",
      result: "failed",
      output: { summary: "should not appear" },
      finishedAt: failedAt,
    });
    await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "merge-fix",
      result: "done",
      output: {},
      finishedAt: emptyAt,
    });
    const reviewId = await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "review",
      result: "pass",
      axis: "spec",
      output: {
        rulings: [
          {
            id: `${formatDisplayId("run", implementId)}#0`,
            verdict: "accepted",
          },
        ],
      },
      finishedAt: later,
    });
    expect(reviewId).toBeGreaterThan(0);

    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.tickets[0].summaries).toEqual([
      {
        run: formatDisplayId("run", fixId),
        stage: "gate-fix",
        summary: "fixed the gate",
      },
      {
        run: formatDisplayId("run", implementId),
        stage: "implement",
        summary: "added the export endpoint",
      },
    ]);
    expect(got.body.tickets[0].decisions).toEqual([
      {
        id: `${formatDisplayId("run", implementId)}#0`,
        kind: "choice",
        text: "return JSON",
        run: formatDisplayId("run", implementId),
        stage: "implement",
      },
    ]);
    expect(got.body.tickets[0].rulings).toEqual([
      {
        id: `${formatDisplayId("run", implementId)}#0`,
        verdict: "accepted",
      },
    ]);
  });

  it("lists unattributed hunks last and says so at the top", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const pullId = await addPull(specId, backendId, 7);
    const wrapRun = await addRun({
      specId,
      repoId: backendId,
      ticketId: null,
      stage: "final-fix",
      result: "done",
      output: { summary: "fixed wrap-up nit" },
      finishedAt: new Date("2026-01-05T00:00:00.000Z"),
    });
    const { revisionId } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
      },
      {
        path: "src/orphan.ts",
        attributions: [{ kind: "unknown" }],
        hunks: [hunk(null, { kind: "unknown", newStart: 3 })],
      },
      {
        path: "src/no-blame.ts",
        attributions: [{ kind: "unknown" }],
        hunks: null,
      },
      {
        path: "gates.yaml",
        attributions: [{ kind: "setup" }],
        hunks: [hunk(null, { kind: "setup", newStart: 1 })],
      },
      {
        path: "GLOSSARY.md",
        attributions: [{ kind: "planning" }],
        hunks: [hunk(null, { kind: "planning", newStart: 1 })],
      },
      {
        path: "src/tidy.ts",
        attributions: [{ run: formatDisplayId("run", wrapRun) }],
        hunks: [
          hunk(null, {
            owners: [
              {
                run: formatDisplayId("run", wrapRun),
                stage: "final-fix",
                lines: 1,
              },
            ],
          }),
        ],
      },
    ]);

    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.unattributedCount).toBe(2);
    expect(got.body.unattributed.map((row: Json) => row.path)).toEqual([
      "src/no-blame.ts",
      "src/orphan.ts",
    ]);
    expect(got.body.setup).toEqual([
      expect.objectContaining({ path: "gates.yaml" }),
    ]);
    expect(got.body.planning).toEqual([
      expect.objectContaining({ path: "GLOSSARY.md" }),
    ]);
    expect(got.body.wrapUp).toEqual([
      expect.objectContaining({
        stage: "final-fix",
        summaries: [
          {
            run: formatDisplayId("run", wrapRun),
            stage: "final-fix",
            summary: "fixed wrap-up nit",
          },
        ],
      }),
    ]);
    expect(got.body.tickets).toHaveLength(1);
  });

  it("lists Rework in wrap-up when that run left a summary", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    await addTicket({ specId, repoId: backendId, title: "Export API" });
    const pullId = await addPull(specId, backendId, 7);
    const wrapRun = await addRun({
      specId,
      repoId: backendId,
      ticketId: null,
      stage: "rework",
      result: "done",
      output: { summary: "addressed empty-list comment" },
      finishedAt: new Date("2026-01-05T00:00:00.000Z"),
    });
    const { revisionId } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ run: formatDisplayId("run", wrapRun) }],
        hunks: [
          hunk(null, {
            owners: [
              {
                run: formatDisplayId("run", wrapRun),
                stage: "rework",
                lines: 1,
              },
            ],
          }),
        ],
      },
    ]);
    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.wrapUp).toEqual([
      expect.objectContaining({
        stage: "rework",
        summaries: [
          {
            run: formatDisplayId("run", wrapRun),
            stage: "rework",
            summary: "addressed empty-list comment",
          },
        ],
      }),
    ]);
  });

  it("lists only this repo's tickets and names the others", async () => {
    const { projectId, backendId, frontendId } = await shop();
    const specId = await specRow({ projectId });
    const backendTicket = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const frontendTicket = await addTicket({
      specId,
      repoId: frontendId,
      title: "Export UI",
    });
    const backendPull = await addPull(specId, backendId, 7);
    const frontendPull = await addPull(specId, frontendId, 8);
    const { revisionId } = await addReadyRevision(backendPull, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", backendTicket) }],
        hunks: [hunk(formatDisplayId("ticket", backendTicket))],
      },
    ]);

    const got = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(got.status).toBe(200);
    expect(got.body.tickets.map((row: Json) => row.displayId)).toEqual([
      formatDisplayId("ticket", backendTicket),
    ]);
    expect(got.body.otherRepoTickets).toEqual([
      {
        displayId: formatDisplayId("ticket", frontendTicket),
        title: "Export UI",
        repo: "frontend",
        pullRequestId: frontendPull,
      },
    ]);
  });

  it("caches the guide on the revision and assembles a later revision from that revision's hunks", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const t2 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export CSV",
    });
    const pullId = await addPull(specId, backendId, 7);
    await addRun({
      specId,
      repoId: backendId,
      ticketId: t1,
      stage: "implement",
      result: "done",
      output: { summary: "first summary" },
      finishedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const first = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
      },
    ]);
    const firstGuide = await call(
      "GET",
      `/review-revisions/${first.revisionId}/guide`,
    );
    expect(firstGuide.body.tickets[0].summaries[0].summary).toBe(
      "first summary",
    );
    await db.pool.query(
      `UPDATE runs SET output = '{"summary":"rewritten"}'::jsonb WHERE spec_id = $1`,
      [specId],
    );
    const cached = await call(
      "GET",
      `/review-revisions/${first.revisionId}/guide`,
    );
    expect(cached.body.tickets[0].summaries[0].summary).toBe("first summary");

    await db.pool.query(
      "UPDATE pull_requests SET head_sha = $2 WHERE id = $1",
      [pullId, sha("c")],
    );
    const second = await addReadyRevision(
      pullId,
      [
        {
          path: "src/b.ts",
          attributions: [{ ticket: formatDisplayId("ticket", t2) }],
          hunks: [hunk(formatDisplayId("ticket", t2))],
        },
      ],
      sha("c"),
    );
    const next = await call(
      "GET",
      `/review-revisions/${second.revisionId}/guide`,
    );
    expect(next.body.tickets.map((row: Json) => row.displayId)).toEqual([
      formatDisplayId("ticket", t2),
    ]);
    const stillFirst = await call(
      "GET",
      `/review-revisions/${first.revisionId}/guide`,
    );
    expect(stillFirst.body.tickets.map((row: Json) => row.displayId)).toEqual([
      formatDisplayId("ticket", t1),
    ]);
  });

  it("marks a ticket section viewed when every hunk file is viewed", async () => {
    const { projectId, backendId } = await shop();
    const specId = await specRow({ projectId });
    const t1 = await addTicket({
      specId,
      repoId: backendId,
      title: "Export API",
    });
    const pullId = await addPull(specId, backendId, 7);
    const { revisionId } = await addReadyRevision(pullId, [
      {
        path: "src/a.ts",
        attributions: [{ ticket: formatDisplayId("ticket", t1) }],
        hunks: [hunk(formatDisplayId("ticket", t1))],
        newBlob: sha("b"),
      },
    ]);
    const before = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(before.body.tickets[0].viewed).toBe(false);
    await call(
      "PUT",
      `/pull-requests/${pullId}/viewed-files/${encodeURIComponent("src/a.ts")}`,
      { newBlob: sha("b") },
    );
    const after = await call("GET", `/review-revisions/${revisionId}/guide`);
    expect(after.body.tickets[0].viewed).toBe(true);
  });
});
