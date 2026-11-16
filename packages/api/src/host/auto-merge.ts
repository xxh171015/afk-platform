import { type AutoMergePull, autoMerge } from "@afk/shared";
import type pg from "pg";
import { enqueueAutoMerge } from "./host-jobs.ts";

// After host-sync has written what the host said, queue at most one auto-merge job
// for each spec in the project that the shared forecast says is due (ADR 0011).

interface SpecRow {
  id: number;
  type: string;
  state: string;
}

interface PullRow {
  id: number;
  state: string;
  draft: boolean;
  ci: string;
  review: string;
  conflicts_with_default: boolean;
  human_comments: number | null;
  head_sha: string;
}

function asPull(row: PullRow): AutoMergePull {
  return {
    state: row.state as AutoMergePull["state"],
    draft: row.draft,
    ci: row.ci as AutoMergePull["ci"],
    review: row.review as AutoMergePull["review"],
    conflictsWithDefault: row.conflicts_with_default === true,
    humanComments: row.human_comments ?? 0,
    headSha: row.head_sha,
  };
}

export async function queueDueAutoMerges(
  client: pg.PoolClient,
  projectId: number,
  now: Date,
): Promise<void> {
  const project = await client.query<{ merge_policy: string | null }>(
    "SELECT merge_policy FROM projects WHERE id = $1",
    [projectId],
  );
  const mergePolicy = project.rows[0]?.merge_policy;
  const specs = await client.query<SpecRow>(
    `SELECT id, type, state FROM specs
     WHERE project_id = $1 AND state NOT IN ('merged', 'cancelled')
     ORDER BY id`,
    [projectId],
  );
  for (const spec of specs.rows) {
    const pulls = await client.query<PullRow>(
      `SELECT id, state, draft, ci, review, conflicts_with_default, human_comments, head_sha
       FROM pull_requests WHERE spec_id = $1 ORDER BY id`,
      [spec.id],
    );
    const pack = await client.query<{
      content: { needsDecision?: { kind?: string }[] } | null;
    }>("SELECT content FROM acceptance_packs WHERE spec_id = $1", [spec.id]);
    const opened = await client.query<{ at: Date | null }>(
      `SELECT min(e.at) AS at FROM events e
       WHERE e.spec_id = $1 AND e.type = 'spec' AND e.to_state = 'awaiting-review'`,
      [spec.id],
    );
    const existing = await client.query(
      `SELECT 1 FROM jobs WHERE type = 'auto-merge' AND (payload->>'specId')::int = $1 LIMIT 1`,
      [spec.id],
    );
    const forecast = autoMerge({
      mergePolicy,
      specType: spec.type,
      specState: spec.state,
      pullRequests: pulls.rows.map(asPull),
      needsDecision: pack.rows[0]?.content?.needsDecision ?? [],
      awaitingReviewAt: opened.rows[0]?.at ?? null,
      hadAutoMergeJob: (existing.rowCount ?? 0) > 0,
      now,
    });
    if (!forecast.willMerge || !forecast.due) continue;
    const [pull] = pulls.rows;
    if (!pull) continue;
    await enqueueAutoMerge(client, {
      specId: spec.id,
      pullId: pull.id,
      expectedHeadSha: pull.head_sha,
    });
  }
}
