import type pg from "pg";
import { enqueueJob } from "../jobs/queue.ts";

// `plat repo check` (operations manual 1.3): a worker runs a repo's gate on a pushed branch in the platform's
// sandbox. The job carries the answer in its result; nothing else in the platform reads it.

export const READINESS_GATE_JOB = "readiness-gate";

export interface ReadinessGatePayload {
  repoId: number;
  branch: string;
}

export function readReadinessGatePayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): ReadinessGatePayload | undefined {
  const { repoId, branch } = job.payload;
  return job.type === READINESS_GATE_JOB &&
    typeof repoId === "number" &&
    typeof branch === "string"
    ? { repoId, branch }
    : undefined;
}

export async function enqueueReadinessGate(
  pool: pg.Pool,
  payload: ReadinessGatePayload,
): Promise<number> {
  const earlier = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2",
    [READINESS_GATE_JOB, payload.repoId],
  );
  const { job } = await enqueueJob(pool, {
    type: READINESS_GATE_JOB,
    payload: { ...payload },
    idempotencyKey: `repo-${payload.repoId}:gate-check:${Number(earlier.rows[0]?.n) + 1}`,
  });
  return job.id;
}

export async function readinessGateTask(
  pool: pg.Pool,
  { repoId, branch }: ReadinessGatePayload,
) {
  const repo = (
    await pool.query<{ name: string; url: string; default_branch: string }>(
      "SELECT name, url, default_branch FROM repos WHERE id = $1",
      [repoId],
    )
  ).rows[0];
  return repo
    ? {
        repo: {
          name: repo.name,
          url: repo.url,
          defaultBranch: repo.default_branch,
        },
        branch,
      }
    : undefined;
}

// The check as the person sees it: the job's state, and the worker's answer once it is there.
export async function readReadinessGate(
  pool: pg.Pool,
  repoId: number,
  jobId: number,
) {
  const job = (
    await pool.query<{
      state: "queued" | "running" | "done" | "failed";
      result: Record<string, unknown> | null;
      error: string | null;
      payload: Record<string, unknown>;
      type: string;
    }>("SELECT state, result, error, payload, type FROM jobs WHERE id = $1", [
      jobId,
    ])
  ).rows[0];
  const payload = job && readReadinessGatePayload(job);
  if (!job || payload?.repoId !== repoId) return undefined;
  return {
    state: job.state,
    branch: payload.branch,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}
