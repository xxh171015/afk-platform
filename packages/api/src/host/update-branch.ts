import {
  AGENT_FAILURES,
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
// later advances onto that queued row, and on conflict or a failed candidate gate gives a merge agent one try
// before pausing the spec.

export const UpdateBranchResultSchema = z.object({
  stage: z.literal("update-branch"),
  outcome: z.enum(["merged", "conflict", "gate-failed"]),
  headSha: z.string().min(1).optional(),
  ...commonFields,
});

export const UpdateBranchFixResultSchema = z.object({
  stage: z.literal("update-branch"),
  outcome: z.enum(["done", ...AGENT_FAILURES]),
  ...commonFields,
});

export type UpdateBranchPayload = {
  specId: number;
  repoId: number;
  fix: boolean;
  afterFix: boolean;
  mainSha: string | undefined;
  pauseReason: PauseReason | undefined;
};

const PAUSE_FROM_MERGE: Record<"conflict" | "gate-failed", PauseReason> = {
  conflict: "update-branch-conflict",
  "gate-failed": "update-branch-gate-failed",
};

export function readUpdateBranchPayload(
  payload: Record<string, unknown>,
): UpdateBranchPayload | undefined {
  const { specId, repoId, stage, final, mainSha, pauseReason } = payload;
  if (stage !== "update-branch" || final === true) return undefined;
  if (typeof specId !== "number" || typeof repoId !== "number")
    return undefined;
  return {
    specId,
    repoId,
    fix: payload.fix === true,
    afterFix: payload.afterFix === true,
    mainSha: typeof mainSha === "string" ? mainSha : undefined,
    pauseReason:
      pauseReason === "update-branch-conflict" ||
      pauseReason === "update-branch-gate-failed"
        ? pauseReason
        : undefined,
  };
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

async function nextUpdateBranchKey(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<string> {
  const prefix = updateBranchKeyPrefix(specId, repoId);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return `${prefix}${Number(earlier.rows[0]?.n) + 1}`;
}

export async function enqueueUpdateBranch(
  client: pg.PoolClient,
  target: {
    specId: number;
    repoId: number;
    mainSha: string;
    afterFix?: boolean;
  },
): Promise<void> {
  const queued = await client.query<{
    id: number;
    after_fix: boolean;
  }>(
    `SELECT id, coalesce((payload->>'afterFix')::boolean, false) AS after_fix
     FROM jobs WHERE type = 'merge' AND state = 'queued'
       AND payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
     FOR UPDATE`,
    [target.specId, target.repoId],
  );
  if (queued.rows[0]) {
    // An after-fix merge applies the agent's temp branch, not a newer main SHA. Leave it; a later
    // success compares repos.default_sha and enqueues another first attempt if main moved again.
    if (!queued.rows[0].after_fix) {
      await client.query(
        `UPDATE jobs SET payload = payload || jsonb_build_object('mainSha', $2::text)
           || CASE WHEN $3::boolean THEN jsonb_build_object('afterFix', true) ELSE '{}'::jsonb END
         WHERE id = $1`,
        [queued.rows[0].id, target.mainSha, target.afterFix === true],
      );
    }
    return;
  }
  const agent = await client.query<{ id: number; state: string }>(
    `SELECT id, state FROM jobs WHERE type = 'agent-run' AND state IN ('queued', 'running')
       AND payload->>'stage' = 'update-branch' AND payload->>'fix' = 'true'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
     FOR UPDATE`,
    [target.specId, target.repoId],
  );
  if (agent.rows[0]) {
    if (agent.rows[0].state === "queued") {
      await client.query(
        `UPDATE jobs SET payload = payload || jsonb_build_object('mainSha', $2::text) WHERE id = $1`,
        [agent.rows[0].id, target.mainSha],
      );
    }
    return;
  }
  const spec = await client.query<{ slug: string }>(
    "SELECT slug FROM specs WHERE id = $1",
    [target.specId],
  );
  await enqueueJob(client, {
    type: "merge",
    payload: {
      stage: "update-branch",
      specId: target.specId,
      repoId: target.repoId,
      mainSha: target.mainSha,
      ...(target.afterFix ? { afterFix: true } : {}),
    },
    lockKey: `integration:${target.repoId}:spec/${spec.rows[0]?.slug}`,
    idempotencyKey: await nextUpdateBranchKey(
      client,
      target.specId,
      target.repoId,
    ),
  });
}

async function enqueueUpdateBranchFix(
  client: pg.PoolClient,
  target: {
    specId: number;
    repoId: number;
    mainSha: string;
    pauseReason: PauseReason;
  },
): Promise<void> {
  await enqueueJob(client, {
    type: "agent-run",
    payload: {
      stage: "update-branch",
      specId: target.specId,
      repoId: target.repoId,
      mainSha: target.mainSha,
      fix: true,
      pauseReason: target.pauseReason,
    },
    idempotencyKey: await nextUpdateBranchKey(
      client,
      target.specId,
      target.repoId,
    ),
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

async function failQueuedUpdateBranches(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  await client.query(
    `UPDATE jobs SET state = 'failed', error = 'the spec was paused', lease_owner = NULL, lease_expires_at = NULL
     WHERE state = 'queued' AND payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1`,
    [specId],
  );
}

async function pauseForUpdateBranch(
  client: pg.PoolClient,
  specId: number,
  reason: PauseReason,
): Promise<void> {
  const paused = specTransition("running", "pause");
  if (!paused.ok) throw new Error(paused.reason);
  await client.query(
    "UPDATE specs SET state = $2, pause_reason = $3 WHERE id = $1",
    [specId, paused.state, reason],
  );
  await failQueuedUpdateBranches(client, specId);
}

async function takeQueuedMergeSha(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<string | undefined> {
  const queued = await client.query<{ id: number; sha: string | null }>(
    `SELECT id, payload->>'mainSha' AS sha FROM jobs
     WHERE type = 'merge' AND state = 'queued'
       AND payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
     FOR UPDATE`,
    [specId, repoId],
  );
  if (!queued.rows[0]) return undefined;
  await client.query(
    `UPDATE jobs SET state = 'failed', error = 'superseded by a merge agent',
       lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ANY($1::int[])`,
    [queued.rows.map((row) => row.id)],
  );
  return queued.rows.at(-1)?.sha ?? undefined;
}

async function enqueueIfMainMoved(
  client: pg.PoolClient,
  read: UpdateBranchPayload,
): Promise<void> {
  const repo = await client.query<{ default_sha: string | null }>(
    "SELECT default_sha FROM repos WHERE id = $1",
    [read.repoId],
  );
  const latest = repo.rows[0]?.default_sha;
  if (latest && latest !== read.mainSha) {
    await enqueueUpdateBranch(client, {
      specId: read.specId,
      repoId: read.repoId,
      mainSha: latest,
    });
  }
}

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
  const parsed = read.fix
    ? UpdateBranchFixResultSchema.safeParse(result)
    : UpdateBranchResultSchema.safeParse(result);
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
  if (read.fix) {
    if (valid.outcome === "done") {
      await enqueueUpdateBranch(client, {
        specId: read.specId,
        repoId: read.repoId,
        mainSha: read.mainSha ?? "",
        afterFix: true,
      });
      return { status: "applied" };
    }
    await pauseForUpdateBranch(
      client,
      read.specId,
      read.pauseReason ?? "update-branch-conflict",
    );
    return { status: "applied" };
  }
  if (valid.outcome === "merged") {
    if (read.afterFix) await enqueueIfMainMoved(client, read);
    return { status: "applied" };
  }
  if (valid.outcome !== "conflict" && valid.outcome !== "gate-failed") {
    return { status: "ignored", reason: "update-branch result is not valid" };
  }
  const reason = PAUSE_FROM_MERGE[valid.outcome];
  if (read.afterFix) {
    await pauseForUpdateBranch(client, read.specId, reason);
    return { status: "applied" };
  }
  const laterSha = await takeQueuedMergeSha(client, read.specId, read.repoId);
  await enqueueUpdateBranchFix(client, {
    specId: read.specId,
    repoId: read.repoId,
    mainSha: laterSha ?? read.mainSha ?? "",
    pauseReason: reason,
  });
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
