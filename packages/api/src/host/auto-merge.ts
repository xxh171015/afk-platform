import {
  type AutoMergePull,
  type AutoMergeResult,
  autoMergeForecast,
  type MergePolicy,
  parseMergePolicy,
} from "@afk/shared";
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
    humanComments: row.human_comments,
    headSha: row.head_sha,
  };
}

export type AutoMergeEventView = {
  type: "auto-merged" | "auto-merge-failed";
  reason: string | null;
};

export type AutoMergeView = {
  policy: MergePolicy;
  willMerge: boolean;
  mergeAt: string | null;
  reason: string | null;
  event: AutoMergeEventView | null;
};

// The one place that reads what the forecast needs, for the page and for the queue alike.
async function forecastFor(
  db: Pick<pg.Pool, "query">,
  spec: SpecRow,
  mergePolicy: string | null | undefined,
  now: Date,
): Promise<{ forecast: AutoMergeResult; pulls: PullRow[] }> {
  const pulls = await db.query<PullRow>(
    `SELECT id, state, draft, ci, review, conflicts_with_default, human_comments, head_sha
     FROM pull_requests WHERE spec_id = $1 ORDER BY id`,
    [spec.id],
  );
  const pack = await db.query<{
    content: { needsDecision?: { kind?: string }[] } | null;
  }>("SELECT content FROM acceptance_packs WHERE spec_id = $1", [spec.id]);
  const opened = await db.query<{ at: Date | null }>(
    `SELECT min(e.at) AS at FROM events e
     WHERE e.spec_id = $1 AND e.type = 'spec' AND e.to_state = 'awaiting-review'`,
    [spec.id],
  );
  const existing = await db.query(
    `SELECT 1 FROM jobs WHERE type = 'auto-merge' AND (payload->>'specId')::int = $1 LIMIT 1`,
    [spec.id],
  );
  const comments = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM review_comments
     WHERE spec_id = $1 AND state <> 'draft'`,
    [spec.id],
  );
  const forecast = autoMergeForecast({
    mergePolicy,
    specType: spec.type,
    specState: spec.state,
    pullRequests: pulls.rows.map(asPull),
    needsDecision: pack.rows[0]?.content?.needsDecision ?? [],
    awaitingReviewAt: opened.rows[0]?.at ?? null,
    hadAutoMergeJob: (existing.rowCount ?? 0) > 0,
    now,
    reviewComments: Number(comments.rows[0]?.n ?? 0),
  });
  return { forecast, pulls: pulls.rows };
}

export async function autoMergeViewOf(
  pool: Pick<pg.Pool, "query">,
  specId: number,
  now: Date,
): Promise<AutoMergeView> {
  const spec = await pool.query<{
    type: string;
    state: string;
    merge_policy: string | null;
  }>(
    `SELECT s.type, s.state, p.merge_policy
     FROM specs s JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
    [specId],
  );
  const row = spec.rows[0];
  const mergePolicy = row?.merge_policy;
  const { forecast } = await forecastFor(
    pool,
    { id: specId, type: row?.type ?? "", state: row?.state ?? "" },
    mergePolicy,
    now,
  );
  const event = await pool.query<AutoMergeEventView>(
    `SELECT type, reason FROM events
     WHERE spec_id = $1 AND type IN ('auto-merged', 'auto-merge-failed')
     ORDER BY id DESC LIMIT 1`,
    [specId],
  );
  return {
    policy: parseMergePolicy(mergePolicy),
    willMerge: forecast.willMerge,
    mergeAt: forecast.willMerge ? forecast.mergeAt.toISOString() : null,
    reason: forecast.willMerge ? null : forecast.reason,
    event: event.rows[0] ?? null,
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
    const { forecast, pulls } = await forecastFor(
      client,
      spec,
      mergePolicy,
      now,
    );
    if (!forecast.willMerge || !forecast.due) continue;
    const [pull] = pulls;
    if (!pull) continue;
    await enqueueAutoMerge(client, {
      specId: spec.id,
      pullId: pull.id,
      expectedHeadSha: pull.head_sha,
    });
  }
}
