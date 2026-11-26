import type pg from "pg";
import { enqueueReviewNote } from "./host-jobs.ts";

export async function enqueueReviewNoteForPull(
  client: pg.PoolClient,
  pullId: number,
): Promise<void> {
  const comments = await client.query(
    `SELECT 1 FROM review_comments
     WHERE pull_request_id = $1 AND state <> 'draft'
     LIMIT 1`,
    [pullId],
  );
  if (!comments.rowCount) return;
  await enqueueReviewNote(client, { pullId });
}

export async function enqueueReviewNotesForSpec(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const pulls = await client.query<{ id: number }>(
    `SELECT DISTINCT p.id
     FROM pull_requests p
     JOIN review_comments c ON c.pull_request_id = p.id
     WHERE p.spec_id = $1 AND p.state = 'open' AND c.state <> 'draft'
     ORDER BY p.id`,
    [specId],
  );
  for (const pull of pulls.rows)
    await enqueueReviewNote(client, { pullId: pull.id });
}

export async function reviewNoteErrorsOf(
  pool: Pick<pg.Pool, "query">,
  pullIds: number[],
): Promise<Map<number, string | null>> {
  const errors = new Map<number, string | null>();
  for (const pullId of pullIds) errors.set(pullId, null);
  if (pullIds.length === 0) return errors;
  const rows = await pool.query<{
    pull_id: number;
    state: string;
    error: string | null;
  }>(
    `SELECT DISTINCT ON ((payload->>'pullId')::int)
       (payload->>'pullId')::int AS pull_id, state, error
     FROM jobs
     WHERE type = 'review-note' AND (payload->>'pullId')::int = ANY($1::int[])
     ORDER BY (payload->>'pullId')::int, id DESC`,
    [pullIds],
  );
  for (const row of rows.rows) {
    errors.set(row.pull_id, row.state === "failed" ? row.error : null);
  }
  return errors;
}
