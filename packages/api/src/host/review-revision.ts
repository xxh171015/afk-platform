import {
  parseDisplayId,
  type ReviewAttribution,
  ReviewRevisionResultSchema,
} from "@afk/shared";
import type pg from "pg";
import {
  enqueueReviewRevisionJob,
  type ReviewRevisionPayload,
} from "./host-jobs.ts";

export type RecordReviewResult =
  | { status: "applied" }
  | { status: "ignored"; reason: string };

async function previousHeadShaOf(
  client: pg.PoolClient,
  pullId: number,
  headSha: string,
): Promise<string | null> {
  const viewed = await client.query(
    "SELECT 1 FROM review_file_views WHERE pull_request_id = $1 LIMIT 1",
    [pullId],
  );
  if (!viewed.rowCount) return null;
  const prev = await client.query<{ head_sha: string }>(
    `SELECT head_sha FROM review_revisions
     WHERE pull_request_id = $1 AND state = 'ready' AND head_sha <> $2
     ORDER BY ready_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [pullId, headSha],
  );
  return prev.rows[0]?.head_sha ?? null;
}

export async function enqueueReviewRevision(
  client: pg.PoolClient,
  pullId: number,
): Promise<void> {
  const pull = await client.query<{ head_sha: string }>(
    "SELECT head_sha FROM pull_requests WHERE id = $1",
    [pullId],
  );
  const headSha = pull.rows[0]?.head_sha;
  if (!headSha) return;
  const existing = await client.query<{
    id: number;
    state: string;
  }>(
    `SELECT id, state FROM review_revisions
     WHERE pull_request_id = $1 AND head_sha = $2
     FOR UPDATE`,
    [pullId, headSha],
  );
  const row = existing.rows[0];
  if (row?.state === "ready") return;
  if (row?.state === "pending") {
    const running = await client.query(
      `SELECT 1 FROM jobs
       WHERE type = 'review-revision'
         AND state IN ('queued', 'running')
         AND (payload->>'pullId')::int = $1
         AND payload->>'headSha' = $2`,
      [pullId, headSha],
    );
    if (running.rowCount) return;
  }
  if (!row) {
    await client.query(
      `INSERT INTO review_revisions (pull_request_id, head_sha, state)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (pull_request_id, head_sha) DO NOTHING`,
      [pullId, headSha],
    );
  } else if (row.state === "failed") {
    await client.query(
      `UPDATE review_revisions
       SET state = 'pending', error = NULL
       WHERE id = $1`,
      [row.id],
    );
  }
  const previousHeadSha = await previousHeadShaOf(client, pullId, headSha);
  await enqueueReviewRevisionJob(client, {
    pullId,
    headSha,
    previousHeadSha,
  });
}

export async function enqueueReviewRevisionsForSpec(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const pulls = await client.query<{ id: number }>(
    `SELECT id FROM pull_requests
     WHERE spec_id = $1 AND state = 'open'
     ORDER BY id`,
    [specId],
  );
  for (const pull of pulls.rows) await enqueueReviewRevision(client, pull.id);
}

async function stageOfRun(
  client: pg.PoolClient,
  runDisplay: string,
): Promise<string | undefined> {
  const parsed = parseDisplayId(runDisplay);
  if (parsed?.kind !== "run") return undefined;
  const row = await client.query<{ stage: string }>(
    "SELECT stage FROM runs WHERE id = $1",
    [parsed.id],
  );
  return row.rows[0]?.stage;
}

async function enrichAttributions(
  client: pg.PoolClient,
  items: ReviewAttribution[],
): Promise<ReviewAttribution[]> {
  const out: ReviewAttribution[] = [];
  for (const item of items) {
    if ("run" in item && item.stage === undefined) {
      const stage = await stageOfRun(client, item.run);
      out.push(stage ? { run: item.run, stage } : item);
    } else {
      out.push(item);
    }
  }
  return out;
}

export async function recordReviewRevision(
  client: pg.PoolClient,
  read: ReviewRevisionPayload,
  result: unknown,
  now: Date,
): Promise<RecordReviewResult> {
  const parsed = ReviewRevisionResultSchema.safeParse(result);
  if (!parsed.success)
    return { status: "ignored", reason: "review-revision result is not valid" };
  const data = parsed.data;
  const revision = await client.query<{ id: number }>(
    `SELECT id FROM review_revisions
     WHERE pull_request_id = $1 AND head_sha = $2
     FOR UPDATE`,
    [read.pullId, read.headSha],
  );
  const id = revision.rows[0]?.id;
  if (id === undefined)
    return { status: "ignored", reason: "no such review revision" };
  await client.query(
    `UPDATE review_revisions
     SET base_sha = $2, merge_base_sha = $3, complete = $4, omitted_reason = $5,
         files_count = $6, additions = $7, deletions = $8,
         previous_head_sha = $9
     WHERE id = $1`,
    [
      id,
      data.baseSha,
      data.mergeBaseSha,
      data.complete,
      data.omittedReason,
      data.filesCount,
      data.additions,
      data.deletions,
      read.previousHeadSha,
    ],
  );
  for (const blob of data.blobs) {
    await client.query(
      `INSERT INTO review_blobs (sha, content, bytes)
       VALUES ($1, $2, $3)
       ON CONFLICT (sha) DO NOTHING`,
      [blob.sha, blob.content, blob.bytes],
    );
  }
  for (const file of data.files) {
    const attributions = await enrichAttributions(client, file.attributions);
    await client.query(
      `INSERT INTO review_files (
         revision_id, path, old_path, status, old_blob, new_blob,
         additions, deletions, "binary", generated, test, lockfile,
         patch, patch_omitted, since_patch, attributions, hunks
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16::jsonb, $17::jsonb
       )
       ON CONFLICT (revision_id, path) DO UPDATE SET
         old_path = EXCLUDED.old_path,
         status = EXCLUDED.status,
         old_blob = EXCLUDED.old_blob,
         new_blob = EXCLUDED.new_blob,
         additions = EXCLUDED.additions,
         deletions = EXCLUDED.deletions,
         "binary" = EXCLUDED."binary",
         generated = EXCLUDED.generated,
         test = EXCLUDED.test,
         lockfile = EXCLUDED.lockfile,
         patch = EXCLUDED.patch,
         patch_omitted = EXCLUDED.patch_omitted,
         since_patch = EXCLUDED.since_patch,
         attributions = EXCLUDED.attributions,
         hunks = EXCLUDED.hunks`,
      [
        id,
        file.path,
        file.oldPath,
        file.status,
        file.oldBlob,
        file.newBlob,
        file.additions,
        file.deletions,
        file.binary,
        file.generated,
        file.test,
        file.lockfile,
        file.patch,
        file.patchOmitted,
        file.sincePatch,
        JSON.stringify(attributions),
        file.hunks === null ? null : JSON.stringify(file.hunks),
      ],
    );
  }
  if (data.done) {
    await client.query(
      `UPDATE review_revisions
       SET state = 'ready', error = NULL, ready_at = $2
       WHERE id = $1`,
      [id, now],
    );
  }
  return { status: "applied" };
}

export async function reviewRevisionFailed(
  client: pg.PoolClient,
  read: ReviewRevisionPayload,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE review_revisions
     SET state = 'failed', error = $3
     WHERE pull_request_id = $1 AND head_sha = $2`,
    [read.pullId, read.headSha, error],
  );
}

export async function markReviewFileViewed(
  client: pg.PoolClient,
  input: { pullId: number; path: string; newBlob: string; viewedAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO review_file_views (pull_request_id, path, new_blob, viewed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pull_request_id, path)
     DO UPDATE SET new_blob = EXCLUDED.new_blob, viewed_at = EXCLUDED.viewed_at`,
    [input.pullId, input.path, input.newBlob, input.viewedAt],
  );
}

export async function unmarkReviewFileViewed(
  client: pg.PoolClient,
  input: { pullId: number; path: string; newBlob: string },
): Promise<void> {
  await client.query(
    `DELETE FROM review_file_views
     WHERE pull_request_id = $1 AND path = $2 AND new_blob = $3`,
    [input.pullId, input.path, input.newBlob],
  );
}

export async function purgeExpiredReviewPayloads(
  pool: Pick<pg.Pool, "query">,
  now: Date,
  retentionDays: number,
): Promise<void> {
  await pool.query(
    `WITH ended AS (
       SELECT s.id,
         CASE
           WHEN s.state = 'merged' THEN COALESCE(
             (SELECT max(p.merged_at) FROM pull_requests p WHERE p.spec_id = s.id),
             (SELECT max(e.at) FROM events e
               WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'merged')
           )
           WHEN s.state = 'cancelled' THEN (
             SELECT max(e.at) FROM events e
              WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'cancelled'
           )
         END AS ended_at
       FROM specs s
       WHERE s.state IN ('merged', 'cancelled')
     ),
     expired AS (
       SELECT id FROM ended
        WHERE ended_at IS NOT NULL
          AND ended_at + make_interval(days => $2::int) <= $1::timestamptz
     )
     UPDATE review_files f
        SET patch = NULL, since_patch = NULL, hunks = NULL
       FROM review_revisions r
       JOIN pull_requests p ON p.id = r.pull_request_id
      WHERE f.revision_id = r.id
        AND p.spec_id IN (SELECT id FROM expired)
        AND (f.patch IS NOT NULL OR f.since_patch IS NOT NULL OR f.hunks IS NOT NULL)`,
    [now, retentionDays],
  );
  await pool.query(
    `WITH ended AS (
       SELECT s.id,
         CASE
           WHEN s.state = 'merged' THEN COALESCE(
             (SELECT max(p.merged_at) FROM pull_requests p WHERE p.spec_id = s.id),
             (SELECT max(e.at) FROM events e
               WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'merged')
           )
           WHEN s.state = 'cancelled' THEN (
             SELECT max(e.at) FROM events e
              WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'cancelled'
           )
         END AS ended_at
       FROM specs s
       WHERE s.state IN ('merged', 'cancelled')
     ),
     expired AS (
       SELECT id FROM ended
        WHERE ended_at IS NOT NULL
          AND ended_at + make_interval(days => $2::int) <= $1::timestamptz
     )
     DELETE FROM review_blobs b
      WHERE NOT EXISTS (
        SELECT 1
          FROM review_files f
          JOIN review_revisions r ON r.id = f.revision_id
          JOIN pull_requests p ON p.id = r.pull_request_id
         WHERE (f.old_blob = b.sha OR f.new_blob = b.sha)
           AND p.spec_id NOT IN (SELECT id FROM expired)
      )`,
    [now, retentionDays],
  );
}
