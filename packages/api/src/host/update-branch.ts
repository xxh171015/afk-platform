import {
  formatDisplayId,
  type PauseReason,
  type SpecState,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { enqueueJob } from "../jobs/queue.ts";
import { lockSpec } from "../scheduling/scheduler.ts";
import { commonFields, type StageJob, writeFacts } from "../stages/results.ts";

// Merging the default branch into a running spec's integration branch (docs/specs/m3-platform.md「多需求并行」).
// Host-sync notices a new default SHA; this module queues at most one update-branch per spec × repo, coalesces
// later advances onto that queued row, and pauses the spec when the merge conflicts or the candidate gate fails.

export const UpdateBranchResultSchema = z.object({
  stage: z.literal("update-branch"),
  outcome: z.enum(["merged", "conflict", "gate-failed"]),
  headSha: z.string().min(1).optional(),
  ...commonFields,
});

export function readUpdateBranchPayload(
  payload: Record<string, unknown>,
): { specId: number; repoId: number } | undefined {
  const { specId, repoId, stage, final } = payload;
  if (stage !== "update-branch" || final === true) return undefined;
  if (typeof specId !== "number" || typeof repoId !== "number")
    return undefined;
  return { specId, repoId };
}

export async function markUpdateBranchClaimed(
  pool: Pick<pg.Pool, "query">,
  job: StageJob,
): Promise<void> {
  const read = readUpdateBranchPayload(job.payload);
  if (!read) return;
  await pool.query(
    `INSERT INTO runs (spec_id, repo_id, job_id, stage, attempt, retry_note, started_at)
     SELECT $1, $2, $3, 'update-branch',
       (SELECT count(*) FROM runs r WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = 'update-branch') + 1,
       s.retry_note, now()
     FROM specs s WHERE s.id = $1
     ON CONFLICT (job_id) DO NOTHING`,
    [read.specId, read.repoId, job.id],
  );
  await pool.query("UPDATE specs SET retry_note = NULL WHERE id = $1", [
    read.specId,
  ]);
}

const updateBranchKeyPrefix = (specId: number, repoId: number) =>
  `${formatDisplayId("spec", specId)}:repo-${repoId}:update-branch:`;

export async function enqueueUpdateBranch(
  client: pg.PoolClient,
  target: { specId: number; repoId: number; mainSha: string },
): Promise<void> {
  const queued = await client.query<{ id: number }>(
    `SELECT id FROM jobs WHERE type = 'merge' AND state = 'queued'
       AND payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
     FOR UPDATE`,
    [target.specId, target.repoId],
  );
  if (queued.rows[0]) {
    await client.query(
      `UPDATE jobs SET payload = payload || jsonb_build_object('mainSha', $2::text) WHERE id = $1`,
      [queued.rows[0].id, target.mainSha],
    );
    return;
  }
  const spec = await client.query<{ slug: string }>(
    "SELECT slug FROM specs WHERE id = $1",
    [target.specId],
  );
  const prefix = updateBranchKeyPrefix(target.specId, target.repoId);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  await enqueueJob(client, {
    type: "merge",
    payload: {
      stage: "update-branch",
      specId: target.specId,
      repoId: target.repoId,
      mainSha: target.mainSha,
    },
    lockKey: `integration:${target.repoId}:spec/${spec.rows[0]?.slug}`,
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
  });
}

export async function applyDefaultShas(
  client: pg.PoolClient,
  projectId: number,
  defaults: { repoUrl: string; sha: string }[],
): Promise<void> {
  const running = await client.query<{ id: number }>(
    "SELECT id FROM specs WHERE project_id = $1 AND state = 'running' ORDER BY id",
    [projectId],
  );
  for (const spec of running.rows) await lockSpec(client, spec.id);
  for (const { repoUrl, sha } of defaults) {
    const repo = await client.query<{ id: number; default_sha: string | null }>(
      "SELECT id, default_sha FROM repos WHERE project_id = $1 AND url = $2 FOR UPDATE",
      [projectId, repoUrl],
    );
    const row = repo.rows[0];
    if (!row || row.default_sha === sha) continue;
    const previous = row.default_sha;
    await client.query("UPDATE repos SET default_sha = $2 WHERE id = $1", [
      row.id,
      sha,
    ]);
    // First observation: the spec was already cut from this main; only a later change is "main 前进".
    if (previous === null) continue;
    const specs = await client.query<{ id: number }>(
      `SELECT s.id FROM specs s
       WHERE s.project_id = $1 AND s.state = 'running'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(s.integration_branches) b
           WHERE (b->>'repoId')::int = $2
         )
       ORDER BY s.id`,
      [projectId, row.id],
    );
    for (const spec of specs.rows) {
      await enqueueUpdateBranch(client, {
        specId: spec.id,
        repoId: row.id,
        mainSha: sha,
      });
    }
  }
}

export type RecordUpdateBranchResult =
  | { status: "not-update-branch" }
  | { status: "ignored"; reason: string }
  | { status: "applied" };

export async function recordUpdateBranchResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<RecordUpdateBranchResult> {
  const read = readUpdateBranchPayload(job.payload);
  if (!read) return { status: "not-update-branch" };
  await lockSpec(client, read.specId);
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  const parsed = UpdateBranchResultSchema.safeParse(result);
  const valid = parsed.success ? parsed.data : undefined;
  await writeFacts(
    client,
    {
      spec_id: read.specId,
      repo_id: read.repoId,
      ticket_id: null,
      content_version: null,
    },
    job,
    "update-branch",
    valid,
    result,
  );
  if (spec.rows[0]?.state !== "running") {
    return {
      status: "ignored",
      reason: `update-branch result for a spec that is ${spec.rows[0]?.state}`,
    };
  }
  if (!valid)
    return { status: "ignored", reason: "update-branch result is not valid" };
  if (valid.outcome === "merged") return { status: "applied" };
  const reason: PauseReason =
    valid.outcome === "conflict"
      ? "update-branch-conflict"
      : "update-branch-gate-failed";
  const paused = specTransition("running", "pause");
  if (!paused.ok) throw new Error(paused.reason);
  await client.query(
    "UPDATE specs SET state = $2, pause_reason = $3 WHERE id = $1",
    [read.specId, paused.state, reason],
  );
  await client.query(
    `UPDATE jobs SET state = 'failed', error = 'the spec was paused', lease_owner = NULL, lease_expires_at = NULL
     WHERE state = 'queued' AND type = 'merge' AND payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1`,
    [read.specId],
  );
  return { status: "applied" };
}

export async function defaultBranchesOfRunningSpecs(
  pool: Pick<pg.Pool, "query">,
  projectId: number,
): Promise<{ repoUrl: string; branch: string }[]> {
  const { rows } = await pool.query<{ url: string; default_branch: string }>(
    `SELECT DISTINCT r.url, r.default_branch
     FROM repos r
     JOIN specs s ON s.project_id = r.project_id
     WHERE r.project_id = $1 AND s.state = 'running'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.integration_branches) b
         WHERE (b->>'repoId')::int = r.id
       )
     ORDER BY r.url`,
    [projectId],
  );
  return rows.map((row) => ({ repoUrl: row.url, branch: row.default_branch }));
}

export async function projectHasRunningSpecs(
  pool: Pick<pg.Pool, "query">,
  projectId: number,
): Promise<boolean> {
  const found = await pool.query(
    "SELECT 1 FROM specs WHERE project_id = $1 AND state = 'running' LIMIT 1",
    [projectId],
  );
  return (found.rowCount ?? 0) > 0;
}
