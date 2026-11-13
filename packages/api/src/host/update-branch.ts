import {
  AGENT_FAILURES,
  blockedReasonForReportedPush,
  formatDisplayId,
  type PauseReason,
  resolveLimits,
  type SpecState,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { enqueueJob } from "../jobs/queue.ts";
import { enqueueFinalJob } from "../jobs/stage-jobs.ts";
import { lockSpec } from "../scheduling/scheduler.ts";
import { commonFields, type StageJob, writeFacts } from "../stages/results.ts";
import { enqueueTrialMerge } from "./trial-merge.ts";

// Merging the default branch into a spec's integration branch (docs/specs/m3-platform.md「多需求并行」).
// Host-sync notices a new default SHA; this module queues at most one update-branch per spec × repo, coalesces
// later advances onto that queued row, and on conflict or a failed candidate gate gives a merge agent one try
// before pausing the spec. Running specs update when a merge-tree check finds a text conflict, when they lag
// past the project's commit/hour thresholds, or at the start of 收尾 if they are behind; awaiting-review /
// partially-merged only when the host says the pull request conflicts with the default.

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

const SPECS_THAT_WATCH_MAIN: SpecState[] = [
  "running",
  "finalizing",
  "awaiting-review",
  "partially-merged",
];

type IntegrationBranch = {
  repoId: number;
  branch: string;
  mainSha?: string;
  behindCommits?: number;
  caughtUpAt?: string;
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

async function stampIntegrationMainSha(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
  mainSha: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE specs SET integration_branches = COALESCE((
       SELECT jsonb_agg(
         CASE WHEN (elem->>'repoId')::int = $2
           THEN elem || jsonb_build_object(
             'mainSha', $3::text,
             'behindCommits', 0,
             'caughtUpAt', $4::text
           )
           ELSE elem
         END
         ORDER BY ordinality
       )
       FROM jsonb_array_elements(integration_branches) WITH ORDINALITY AS t(elem, ordinality)
     ), '[]'::jsonb)
     WHERE id = $1`,
    [specId, repoId, mainSha, now.toISOString()],
  );
}

async function stampMissingMainSha(
  client: pg.PoolClient,
  projectId: number,
  repoId: number,
  mainSha: string,
  now: Date,
): Promise<void> {
  const specs = await client.query<{ id: number }>(
    `SELECT s.id FROM specs s
     WHERE s.project_id = $1 AND s.state = ANY($3::text[])
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.integration_branches) b
         WHERE (b->>'repoId')::int = $2 AND b->>'mainSha' IS NULL
       )
     ORDER BY s.id`,
    [projectId, repoId, SPECS_THAT_WATCH_MAIN],
  );
  for (const spec of specs.rows)
    await stampIntegrationMainSha(client, spec.id, repoId, mainSha, now);
}

async function updateBranchInFlight(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<boolean> {
  const found = await client.query(
    `SELECT 1 FROM jobs
     WHERE payload->>'stage' = 'update-branch'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
       AND state IN ('queued', 'running')
     LIMIT 1`,
    [specId, repoId],
  );
  return (found.rowCount ?? 0) > 0;
}

async function repoIsBehindMain(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<boolean> {
  const repo = await client.query<{ default_sha: string | null }>(
    "SELECT default_sha FROM repos WHERE id = $1",
    [repoId],
  );
  const sha = repo.rows[0]?.default_sha;
  if (sha == null) return false;
  const spec = await client.query<{
    integration_branches: IntegrationBranch[];
  }>("SELECT integration_branches FROM specs WHERE id = $1", [specId]);
  const branch = spec.rows[0]?.integration_branches.find(
    (entry) => entry.repoId === repoId,
  );
  return branch?.mainSha !== sha;
}

// 收尾 waits on update-branch when the spec is behind main or one is already in flight.
export async function holdFinalReviewForUpdate(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<boolean> {
  const inFlight = await updateBranchInFlight(client, specId, repoId);
  const behind = await repoIsBehindMain(client, specId, repoId);
  if (!inFlight && behind) {
    const repo = await client.query<{ default_sha: string }>(
      "SELECT default_sha FROM repos WHERE id = $1",
      [repoId],
    );
    const sha = repo.rows[0]?.default_sha;
    if (sha)
      await enqueueUpdateBranch(client, { specId, repoId, mainSha: sha });
  }
  return inFlight || behind;
}

export async function enqueueFinalReviewIfWaiting(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<void> {
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  if (spec.rows[0]?.state !== "finalizing") return;
  if (await updateBranchInFlight(client, specId, repoId)) return;
  const fin = await client.query<{ step: string; state: string }>(
    "SELECT step, state FROM finalizations WHERE spec_id = $1 AND repo_id = $2",
    [specId, repoId],
  );
  if (fin.rows[0]?.state !== "active" || fin.rows[0]?.step !== "final-review")
    return;
  const existing = await client.query(
    `SELECT 1 FROM jobs
     WHERE payload->>'stage' = 'final-review'
       AND (payload->>'specId')::int = $1 AND (payload->>'repoId')::int = $2
       AND state IN ('queued', 'running')
     LIMIT 1`,
    [specId, repoId],
  );
  if (existing.rowCount) return;
  const done = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM tickets WHERE spec_id = $1 AND repo_id = $2 AND state = 'done'",
    [specId, repoId],
  );
  if (Number(done.rows[0]?.n) === 0) {
    await client.query(
      "UPDATE finalizations SET state = 'done' WHERE spec_id = $1 AND repo_id = $2 AND state = 'active'",
      [specId, repoId],
    );
    const { startOpeningPullRequests } = await import("./pull-requests.ts");
    await startOpeningPullRequests(client, specId);
    return;
  }
  await enqueueFinalJob(client, { specId, repoId }, "final-review");
}

export async function enqueueIfConflictsWithDefault(
  client: pg.PoolClient,
  pull: {
    id: number;
    state: string;
    conflictsWithDefault?: boolean;
  },
  alreadyConflicted: boolean,
): Promise<void> {
  if (
    alreadyConflicted ||
    pull.state !== "open" ||
    pull.conflictsWithDefault !== true
  )
    return;
  const row = await client.query<{
    spec_id: number;
    repo_id: number;
    state: SpecState;
    default_sha: string | null;
  }>(
    `SELECT p.spec_id, p.repo_id, s.state, r.default_sha
     FROM pull_requests p
     JOIN specs s ON s.id = p.spec_id
     JOIN repos r ON r.id = p.repo_id
     WHERE p.id = $1`,
    [pull.id],
  );
  const found = row.rows[0];
  if (
    !found ||
    found.default_sha == null ||
    (found.state !== "awaiting-review" && found.state !== "partially-merged")
  )
    return;
  await enqueueUpdateBranch(client, {
    specId: found.spec_id,
    repoId: found.repo_id,
    mainSha: found.default_sha,
  });
}

function exceedsLag(
  branch: IntegrationBranch,
  sha: string,
  commitLimit: number,
  hourLimit: number,
  now: Date,
): boolean {
  if (branch.mainSha === sha) return false;
  if ((branch.behindCommits ?? 0) >= commitLimit) return true;
  if (!branch.caughtUpAt) return false;
  const caught = Date.parse(branch.caughtUpAt);
  if (Number.isNaN(caught)) return false;
  return now.getTime() - caught >= hourLimit * 3600 * 1000;
}

async function considerRunningSpec(
  client: pg.PoolClient,
  spec: {
    id: number;
    integration_branches: IntegrationBranch[];
  },
  repoId: number,
  sha: string,
  moved: boolean,
  commitLimit: number,
  hourLimit: number,
  now: Date,
): Promise<void> {
  if (await updateBranchInFlight(client, spec.id, repoId)) {
    if (moved)
      await enqueueUpdateBranch(client, {
        specId: spec.id,
        repoId,
        mainSha: sha,
      });
    return;
  }
  const branches = spec.integration_branches.map((entry) => ({ ...entry }));
  const branch = branches.find((entry) => entry.repoId === repoId);
  if (!branch) return;
  if (moved) {
    branch.behindCommits = (branch.behindCommits ?? 0) + 1;
    if (!branch.caughtUpAt) branch.caughtUpAt = now.toISOString();
    await client.query(
      "UPDATE specs SET integration_branches = $2 WHERE id = $1",
      [spec.id, JSON.stringify(branches)],
    );
  }
  if (exceedsLag(branch, sha, commitLimit, hourLimit, now)) {
    await enqueueUpdateBranch(client, {
      specId: spec.id,
      repoId,
      mainSha: sha,
    });
    return;
  }
  if (!moved) return;
  await enqueueTrialMerge(client, {
    specId: spec.id,
    repoId,
    checkDefault: true,
    mainSha: sha,
  });
}

export async function applyDefaultShas(
  client: pg.PoolClient,
  projectId: number,
  defaults: { repoUrl: string; sha: string }[],
  now: Date,
): Promise<void> {
  const live = await client.query<{ id: number }>(
    "SELECT id FROM specs WHERE project_id = $1 AND state = ANY($2::text[]) ORDER BY id",
    [projectId, SPECS_THAT_WATCH_MAIN],
  );
  for (const spec of live.rows) await lockSpec(client, spec.id);
  const project = await client.query<{ limits: unknown }>(
    "SELECT limits FROM projects WHERE id = $1",
    [projectId],
  );
  const limits = resolveLimits(project.rows[0]?.limits);
  const commitLimit = limits.updateBranchBehindCommits;
  const hourLimit = limits.updateBranchBehindHours;
  for (const { repoUrl, sha } of defaults) {
    const repo = await client.query<{ id: number; default_sha: string | null }>(
      "SELECT id, default_sha FROM repos WHERE project_id = $1 AND url = $2 FOR UPDATE",
      [projectId, repoUrl],
    );
    const row = repo.rows[0];
    if (!row) continue;
    const previous = row.default_sha;
    if (previous !== sha) {
      await client.query("UPDATE repos SET default_sha = $2 WHERE id = $1", [
        row.id,
        sha,
      ]);
    }
    const moved = previous !== null && previous !== sha;
    // First observation, or a spec that never recorded a baseline: catch up without enqueueing.
    if (previous === null || previous === sha) {
      await stampMissingMainSha(client, projectId, row.id, sha, now);
    }
    if (previous === null) continue;
    const specs = await client.query<{
      id: number;
      state: SpecState;
      integration_branches: IntegrationBranch[];
    }>(
      `SELECT s.id, s.state, s.integration_branches FROM specs s
       WHERE s.project_id = $1 AND s.state IN ('running', 'finalizing')
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(s.integration_branches) b
           WHERE (b->>'repoId')::int = $2
         )
       ORDER BY s.id`,
      [projectId, row.id],
    );
    for (const spec of specs.rows) {
      if (spec.state === "finalizing") {
        if (moved && (await updateBranchInFlight(client, spec.id, row.id))) {
          await enqueueUpdateBranch(client, {
            specId: spec.id,
            repoId: row.id,
            mainSha: sha,
          });
        }
        continue;
      }
      await considerRunningSpec(
        client,
        spec,
        row.id,
        sha,
        moved,
        commitLimit,
        hourLimit,
        now,
      );
    }
  }
}

export type RecordUpdateBranchResult =
  | { status: "not-update-branch" }
  | { status: "ignored"; reason: string }
  | { status: "applied" };

export async function updateBranchJobFailed(
  client: pg.PoolClient,
  job: StageJob,
  error: string,
): Promise<"not-update-branch" | "paused" | "ignored"> {
  const read = readUpdateBranchPayload(job.payload);
  if (!read) return "not-update-branch";
  await lockSpec(client, read.specId);
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  const specState = spec.rows[0]?.state;
  if (!specState || !SPECS_THAT_WATCH_MAIN.includes(specState))
    return "ignored";
  const reason = blockedReasonForReportedPush(error) as PauseReason | undefined;
  if (!reason) return "ignored";
  await pauseForUpdateBranch(client, read.specId, reason);
  return "paused";
}

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
  const current = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  const from = current.rows[0]?.state;
  if (!from) return;
  const paused = specTransition(from, "pause");
  if (!paused.ok) return;
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
  now: Date,
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
  const specState = spec.rows[0]?.state;
  if (!specState || !SPECS_THAT_WATCH_MAIN.includes(specState)) {
    return {
      status: "ignored",
      reason: `update-branch result for a spec that is ${specState}`,
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
    if (valid.headSha)
      await client.query(
        `UPDATE pull_requests SET platform_head_sha = $3
         WHERE spec_id = $1 AND repo_id = $2`,
        [read.specId, read.repoId, valid.headSha],
      );
    if (read.mainSha)
      await stampIntegrationMainSha(
        client,
        read.specId,
        read.repoId,
        read.mainSha,
        now,
      );
    if (read.afterFix) await enqueueIfMainMoved(client, read);
    await enqueueTrialMerge(client, {
      specId: read.specId,
      repoId: read.repoId,
      headSha: valid.headSha,
    });
    await enqueueFinalReviewIfWaiting(client, read.specId, read.repoId);
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

export async function defaultBranchesToWatch(
  pool: Pick<pg.Pool, "query">,
  projectId: number,
): Promise<{ repoUrl: string; branch: string }[]> {
  const { rows } = await pool.query<{ url: string; default_branch: string }>(
    `SELECT DISTINCT r.url, r.default_branch
     FROM repos r
     JOIN specs s ON s.project_id = r.project_id
     WHERE r.project_id = $1 AND s.state = ANY($2::text[])
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.integration_branches) b
         WHERE (b->>'repoId')::int = r.id
       )
     ORDER BY r.url`,
    [projectId, SPECS_THAT_WATCH_MAIN],
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
