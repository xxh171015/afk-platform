import {
  formatDisplayId,
  type ReviewCommentSide,
  type ReviewCommentState,
  type SpecState,
} from "@afk/shared";
import type pg from "pg";
import { lockSpec } from "../scheduling/scheduler.ts";

export interface ReviewCommentView {
  id: number;
  displayId: string;
  specId: number;
  pullRequestId: number;
  revisionId: number;
  path: string | null;
  side: ReviewCommentSide | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerpt: string | null;
  body: string;
  state: ReviewCommentState;
  changeRequestId: number | null;
  reply: string | null;
  reworkRunId: number | null;
  writtenOn: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewCommentWrite = {
  revisionId: number;
  path?: string | null;
  side?: ReviewCommentSide | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  excerpt?: string | null;
  body: string;
};

export type ReviewCommentResult<T> =
  | ({ status: "ok" } & T)
  | { status: "not-found" }
  | { status: "refused"; message: string };

interface CommentRow {
  id: number;
  spec_id: number;
  pull_request_id: number;
  revision_id: number;
  path: string | null;
  side: ReviewCommentSide | null;
  line_start: number | null;
  line_end: number | null;
  excerpt: string | null;
  body: string;
  state: ReviewCommentState;
  change_request_id: number | null;
  reply: string | null;
  rework_run_id: number | null;
  created_at: Date;
  updated_at: Date;
  head_sha: string;
}

const SELECT_VIEW = `c.id, c.spec_id, c.pull_request_id, c.revision_id, c.path, c.side,
       c.line_start, c.line_end, c.excerpt, c.body, c.state, c.change_request_id,
       c.reply, c.rework_run_id, c.created_at, c.updated_at, r.head_sha`;

function viewOf(row: CommentRow): ReviewCommentView {
  return {
    id: row.id,
    displayId: formatDisplayId("comment", row.id),
    specId: row.spec_id,
    pullRequestId: row.pull_request_id,
    revisionId: row.revision_id,
    path: row.path,
    side: row.side,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    excerpt: row.excerpt,
    body: row.body,
    state: row.state,
    changeRequestId: row.change_request_id,
    reply: row.reply,
    reworkRunId: row.rework_run_id,
    writtenOn: row.head_sha,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const AWAITING =
  "the spec is not awaiting-review; only awaiting-review can write, edit, or delete a draft";
const NOT_DRAFT = "Only a draft Review comment can be edited or deleted";

async function lockedSpecOfPull(
  client: pg.PoolClient,
  pullId: number,
): Promise<{ specId: number; state: SpecState } | undefined> {
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM pull_requests WHERE id = $1",
    [pullId],
  );
  const specId = found.rows[0]?.spec_id;
  if (specId == null) return undefined;
  await lockSpec(client, specId);
  const spec = await client.query<{ id: number; state: SpecState }>(
    "SELECT id, state FROM specs WHERE id = $1",
    [specId],
  );
  const row = spec.rows[0];
  return row ? { specId: row.id, state: row.state } : undefined;
}

export async function reviewCommentsOf(
  pool: pg.Pool,
  pullId: number,
): Promise<ReviewCommentView[] | undefined> {
  const pull = await pool.query("SELECT 1 FROM pull_requests WHERE id = $1", [
    pullId,
  ]);
  if (!pull.rowCount) return undefined;
  const rows = await pool.query<CommentRow>(
    `SELECT ${SELECT_VIEW}
     FROM review_comments c
     JOIN review_revisions r ON r.id = c.revision_id
     WHERE c.pull_request_id = $1
     ORDER BY c.id`,
    [pullId],
  );
  return rows.rows.map(viewOf);
}

export async function createReviewComment(
  client: pg.PoolClient,
  pullId: number,
  input: ReviewCommentWrite,
): Promise<ReviewCommentResult<{ comment: ReviewCommentView }>> {
  const spec = await lockedSpecOfPull(client, pullId);
  if (!spec) return { status: "not-found" };
  if (spec.state !== "awaiting-review")
    return { status: "refused", message: AWAITING };
  const revision = await client.query<{ id: number }>(
    "SELECT id FROM review_revisions WHERE id = $1 AND pull_request_id = $2",
    [input.revisionId, pullId],
  );
  if (!revision.rows[0]) return { status: "not-found" };
  const inserted = await client.query<CommentRow>(
    `INSERT INTO review_comments (
       spec_id, pull_request_id, revision_id, path, side, line_start, line_end,
       excerpt, body, state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
     RETURNING id`,
    [
      spec.specId,
      pullId,
      input.revisionId,
      input.path ?? null,
      input.side ?? null,
      input.lineStart ?? null,
      input.lineEnd ?? null,
      input.excerpt ?? null,
      input.body,
    ],
  );
  const id = inserted.rows[0]?.id as number;
  const loaded = await client.query<CommentRow>(
    `SELECT ${SELECT_VIEW}
     FROM review_comments c
     JOIN review_revisions r ON r.id = c.revision_id
     WHERE c.id = $1`,
    [id],
  );
  const row = loaded.rows[0];
  if (!row) return { status: "not-found" };
  return { status: "ok", comment: viewOf(row) };
}

async function loadLockedComment(
  client: pg.PoolClient,
  id: number,
): Promise<
  | { specId: number; state: SpecState; commentState: ReviewCommentState }
  | undefined
> {
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM review_comments WHERE id = $1",
    [id],
  );
  const specId = found.rows[0]?.spec_id;
  if (specId == null) return undefined;
  await lockSpec(client, specId);
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  const specState = spec.rows[0]?.state;
  if (!specState) return undefined;
  const comment = await client.query<{ state: ReviewCommentState }>(
    "SELECT state FROM review_comments WHERE id = $1",
    [id],
  );
  const commentState = comment.rows[0]?.state;
  if (!commentState) return undefined;
  return { specId, state: specState, commentState };
}

export async function patchReviewComment(
  client: pg.PoolClient,
  id: number,
  body: string,
): Promise<ReviewCommentResult<{ comment: ReviewCommentView }>> {
  const locked = await loadLockedComment(client, id);
  if (!locked) return { status: "not-found" };
  if (locked.state !== "awaiting-review")
    return { status: "refused", message: AWAITING };
  if (locked.commentState !== "draft")
    return { status: "refused", message: NOT_DRAFT };
  await client.query(
    "UPDATE review_comments SET body = $2, updated_at = now() WHERE id = $1",
    [id, body],
  );
  const loaded = await client.query<CommentRow>(
    `SELECT ${SELECT_VIEW}
     FROM review_comments c
     JOIN review_revisions r ON r.id = c.revision_id
     WHERE c.id = $1`,
    [id],
  );
  const row = loaded.rows[0];
  if (!row) return { status: "not-found" };
  return { status: "ok", comment: viewOf(row) };
}

export async function deleteReviewComment(
  client: pg.PoolClient,
  id: number,
): Promise<ReviewCommentResult<{ id: number }>> {
  const locked = await loadLockedComment(client, id);
  if (!locked) return { status: "not-found" };
  if (locked.state !== "awaiting-review")
    return { status: "refused", message: AWAITING };
  if (locked.commentState !== "draft")
    return { status: "refused", message: NOT_DRAFT };
  await client.query("DELETE FROM review_comments WHERE id = $1", [id]);
  return { status: "ok", id };
}

export async function deleteDraftReviewComments(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  await client.query(
    "DELETE FROM review_comments WHERE spec_id = $1 AND state = 'draft'",
    [specId],
  );
}
