import {
  CHANGE_REQUEST_NO_DRAFTS,
  CHANGE_REQUEST_PR_NOT_OPEN,
  type ChangeRequestState,
  changeRequestBlockedMessage,
  formatDisplayId,
  type SpecState,
  type StaleReviewDraft,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import { enqueueFinalJob } from "../jobs/stage-jobs.ts";
import { inTransaction, lockSpec } from "../scheduling/scheduler.ts";
import { enqueuePrDraft, stopAutoMergeJobs } from "./host-jobs.ts";
import { enqueueReviewNoteForPull } from "./review-note.ts";

export type SubmitChangeRequestResult =
  | {
      status: "ok";
      id: number;
      number: number;
      state: ChangeRequestState;
      comments: string[];
    }
  | { status: "no-ticket" }
  | {
      status: "refused";
      message: string;
      stale?: StaleReviewDraft[];
    };

const refused = (
  message: string,
  stale?: StaleReviewDraft[],
): SubmitChangeRequestResult =>
  stale
    ? { status: "refused", message, stale }
    : { status: "refused", message };

interface DraftRow {
  id: number;
  repo_id: number;
  pull_id: number;
  pull_state: string;
  written_on: string;
  current_head: string;
}

export async function submitChangeRequest(
  pool: pg.Pool,
  specId: number,
  acknowledgeStale = false,
): Promise<SubmitChangeRequestResult> {
  return inTransaction(pool, async (client) => {
    const exists = await client.query("SELECT 1 FROM specs WHERE id = $1", [
      specId,
    ]);
    if (!exists.rowCount) return { status: "no-ticket" };
    await lockSpec(client, specId);
    const spec = await client.query<{ state: SpecState }>(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    const state = spec.rows[0]?.state;
    if (!state) return { status: "no-ticket" };
    const displayId = formatDisplayId("spec", specId);
    const blocked = changeRequestBlockedMessage(state, displayId);
    if (blocked) return refused(blocked);

    const drafts = await client.query<DraftRow>(
      `SELECT c.id, p.repo_id, p.id AS pull_id, p.state AS pull_state,
              r.head_sha AS written_on, p.head_sha AS current_head
       FROM review_comments c
       JOIN pull_requests p ON p.id = c.pull_request_id
       JOIN review_revisions r ON r.id = c.revision_id
       WHERE c.spec_id = $1 AND c.state = 'draft'
       ORDER BY c.id
       FOR UPDATE OF c`,
      [specId],
    );
    if (drafts.rows.length === 0) return refused(CHANGE_REQUEST_NO_DRAFTS);
    if (drafts.rows.some((row) => row.pull_state !== "open"))
      return refused(CHANGE_REQUEST_PR_NOT_OPEN);

    const stale: StaleReviewDraft[] = drafts.rows
      .filter((row) => row.written_on !== row.current_head)
      .map((row) => ({
        displayId: formatDisplayId("comment", row.id),
        writtenOn: row.written_on,
        currentHead: row.current_head,
      }));
    if (stale.length > 0 && !acknowledgeStale) {
      return refused("有意见写在旧的审查版本上", stale);
    }

    const nextNumber = await client.query<{ n: string }>(
      "SELECT COALESCE(max(number), 0) + 1 AS n FROM change_requests WHERE spec_id = $1",
      [specId],
    );
    const number = Number(nextNumber.rows[0]?.n ?? 1);
    const created = await client.query<{ id: number }>(
      `INSERT INTO change_requests (spec_id, number, state)
       VALUES ($1, $2, 'active') RETURNING id`,
      [specId, number],
    );
    const changeRequestId = created.rows[0]?.id as number;
    const commentIds = drafts.rows.map((row) => row.id);
    const comments = commentIds.map((id) => formatDisplayId("comment", id));
    await client.query(
      `UPDATE review_comments
       SET state = 'submitted', change_request_id = $2, updated_at = now()
       WHERE id = ANY($1)`,
      [commentIds, changeRequestId],
    );

    const next = specTransition("awaiting-review", "request-changes");
    if (!next.ok) throw new Error(next.reason);
    const reason = `提交修改要求 ${comments.join("、")}`;
    await client.query("SELECT set_config('afk.reason', $1, true)", [reason]);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      specId,
      next.state,
    ]);
    await recordAction(
      client,
      "request-changes",
      { specId },
      { comments, changeRequest: number },
    );

    const repoIds = [...new Set(drafts.rows.map((row) => row.repo_id))];
    await client.query(
      `UPDATE finalizations SET step = 'rework', state = 'active',
         blocked_reason = NULL, auto_retried = false, retry_note = NULL,
         job_floor = (SELECT COALESCE(max(id), 0) FROM jobs)
       WHERE spec_id = $1 AND repo_id = ANY($2::int[])`,
      [specId, repoIds],
    );
    for (const repoId of repoIds)
      await enqueueFinalJob(client, { specId, repoId }, "rework");

    await client.query("DELETE FROM final_e2e WHERE spec_id = $1", [specId]);
    await stopAutoMergeJobs(client, specId, "提交了修改要求");
    const pulls = await client.query<{ id: number }>(
      "SELECT id FROM pull_requests WHERE spec_id = $1 AND state = 'open' ORDER BY id",
      [specId],
    );
    for (const pull of pulls.rows)
      await enqueuePrDraft(client, { pullId: pull.id });
    const noted = [...new Set(drafts.rows.map((row) => row.pull_id))];
    for (const pullId of noted) await enqueueReviewNoteForPull(client, pullId);

    return {
      status: "ok",
      id: changeRequestId,
      number,
      state: "active",
      comments,
    };
  });
}

export async function markActiveChangeRequestsDone(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  await client.query(
    "UPDATE change_requests SET state = 'done' WHERE spec_id = $1 AND state = 'active'",
    [specId],
  );
}

export async function supersedeActiveChangeRequests(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  await client.query(
    "UPDATE change_requests SET state = 'superseded' WHERE spec_id = $1 AND state = 'active'",
    [specId],
  );
}
