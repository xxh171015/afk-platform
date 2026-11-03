import { HOST_CAPABILITY } from "@afk/shared";
import type pg from "pg";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";

// Whether the GitHub App can work on a repo (docs/operations-manual.md 1.3). The App's credentials live on the
// worker only, so the API queues a `repo-access` job and keeps what the worker found on the repo, in `repos.access`.
// GitLab repos are not checked.

export const REPO_ACCESS_JOB = "repo-access";

export const ACCESS_RESULTS = [
  "ok",
  "not-installed",
  "missing-permissions",
] as const;

export interface RepoAccessPayload {
  repoId: number;
}

// What GET /projects/{id}/repos/{name}/access says.
export type RepoAccess =
  | { state: "unchecked" } // GitLab, or never asked
  | { state: "pending"; requestedAt: string } // asked; no worker has answered
  | {
      state: (typeof ACCESS_RESULTS)[number];
      missing?: string[];
      fixUrl?: string;
      checkedAt: string;
      checking?: boolean;
    }
  | { state: "error"; message: string; checkedAt: string; checking?: boolean };

export function readRepoAccessPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): RepoAccessPayload | undefined {
  const { repoId } = job.payload;
  return job.type === REPO_ACCESS_JOB && typeof repoId === "number"
    ? { repoId }
    : undefined;
}

// Queues a check, unless one is already waiting or running for the repo. The last answer is kept until a new one
// comes.
export async function requestRepoAccess(
  db: Queryable,
  repoId: number,
  now: Date,
): Promise<void> {
  const repo = (
    await db.query<{ host_kind: string }>(
      "SELECT host_kind FROM repos WHERE id = $1",
      [repoId],
    )
  ).rows[0];
  if (repo?.host_kind !== "github") return;
  const waiting = await db.query(
    `SELECT 1 FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2 AND state IN ('queued', 'running')`,
    [REPO_ACCESS_JOB, repoId],
  );
  if (waiting.rowCount) return;
  const earlier = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2",
    [REPO_ACCESS_JOB, repoId],
  );
  await enqueueJob(db, {
    type: REPO_ACCESS_JOB,
    payload: { repoId },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `repo-${repoId}:access:${Number(earlier.rows[0]?.n) + 1}`,
  });
  await db.query(
    `UPDATE repos SET access = jsonb_set(COALESCE(access, '{}'::jsonb), '{requestedAt}', to_jsonb($2::text)) WHERE id = $1`,
    [repoId, now.toISOString()],
  );
}

export async function repoAccessTask(
  pool: pg.Pool,
  { repoId }: RepoAccessPayload,
): Promise<{ kind: "repo-access"; repoUrl: string } | undefined> {
  const repo = (
    await pool.query<{ url: string }>("SELECT url FROM repos WHERE id = $1", [
      repoId,
    ])
  ).rows[0];
  return repo ? { kind: "repo-access", repoUrl: repo.url } : undefined;
}

const keep = (db: Queryable, repoId: number, last: Record<string, unknown>) =>
  db.query(
    `UPDATE repos SET access = jsonb_set(COALESCE(access, '{}'::jsonb), '{last}', $2::jsonb) WHERE id = $1`,
    [repoId, JSON.stringify(last)],
  );

export async function recordRepoAccess(
  db: Queryable,
  { repoId }: RepoAccessPayload,
  result: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const state = result.state;
  if (
    result.stage !== REPO_ACCESS_JOB ||
    !(ACCESS_RESULTS as readonly unknown[]).includes(state)
  ) {
    await keep(db, repoId, {
      state: "error",
      message: "the worker's answer was not understood",
      checkedAt: now.toISOString(),
    });
    return;
  }
  const missing = Array.isArray(result.missing)
    ? result.missing.filter((m): m is string => typeof m === "string")
    : undefined;
  await keep(db, repoId, {
    state,
    ...(missing?.length ? { missing } : {}),
    ...(typeof result.fixUrl === "string" ? { fixUrl: result.fixUrl } : {}),
    checkedAt: now.toISOString(),
  });
}

// A check that failed is not tried again by itself: the next plat init asks again.
export async function repoAccessFailed(
  db: Queryable,
  { repoId }: RepoAccessPayload,
  error: string,
  now: Date,
): Promise<void> {
  await keep(db, repoId, {
    state: "error",
    message: error.slice(0, 400),
    checkedAt: now.toISOString(),
  });
}

export async function readRepoAccess(
  pool: pg.Pool,
  projectId: number,
  name: string,
): Promise<RepoAccess | "no-repo"> {
  const repo = (
    await pool.query<{
      access: {
        requestedAt?: string;
        last?: Extract<RepoAccess, { checkedAt: string }>;
      } | null;
    }>("SELECT access FROM repos WHERE project_id = $1 AND name = $2", [
      projectId,
      name,
    ])
  ).rows[0];
  if (!repo) return "no-repo";
  const { last, requestedAt } = repo.access ?? {};
  // the last answer; `checking` while a newer question waits for a worker
  if (last)
    return requestedAt && requestedAt > last.checkedAt
      ? { ...last, checking: true }
      : last;
  if (requestedAt) return { state: "pending", requestedAt };
  return { state: "unchecked" };
}

export async function repoIdByName(
  pool: pg.Pool,
  projectId: number,
  name: string,
): Promise<number | undefined> {
  return (
    await pool.query<{ id: number }>(
      "SELECT id FROM repos WHERE project_id = $1 AND name = $2",
      [projectId, name],
    )
  ).rows[0]?.id;
}
