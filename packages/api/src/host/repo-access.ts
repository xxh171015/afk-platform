import { HOST_CAPABILITY, type HostKind, repoHost } from "@afk/shared";
import type pg from "pg";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";
import type { Notice } from "../notify/notices.ts";
import { recordTokenExpiry } from "./code-hosts.ts";

// Whether the bot (GitHub App or GitLab PAT) can work on a repo (docs/operations-manual.md 1.3). Credentials live
// on the worker only, so the API queues a `repo-access` job and keeps what the worker found on the repo, in
// `repos.access`. Asked when a repo is registered and on every plat init; after each answer, again in a day.

export const REPO_ACCESS_JOB = "repo-access";
export const ACCESS_INTERVAL_SECONDS = 24 * 60 * 60;

export const ACCESS_RESULTS = [
  "ok",
  "not-installed",
  "missing-permissions",
  "not-member",
] as const;

export const ACCESS_HINTS = ["personal-token", "developers-can-merge"] as const;

export interface RepoAccessPayload {
  repoId: number;
}

// What GET /projects/{id}/repos/{name}/access says.
export type RepoAccess =
  | { state: "unchecked"; hostKind: HostKind }
  | { state: "pending"; requestedAt: string; hostKind: HostKind }
  | {
      state: (typeof ACCESS_RESULTS)[number];
      missing?: string[];
      fixUrl?: string;
      username?: string;
      fix?: string;
      hints?: (typeof ACCESS_HINTS)[number][];
      files?: { gates: boolean; integrationCompose: boolean };
      checkedAt: string;
      checking?: boolean;
      hostKind: HostKind;
    }
  | {
      state: "error";
      message: string;
      checkedAt: string;
      checking?: boolean;
      hostKind: HostKind;
    };

export function readRepoAccessPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): RepoAccessPayload | undefined {
  const { repoId } = job.payload;
  return job.type === REPO_ACCESS_JOB && typeof repoId === "number"
    ? { repoId }
    : undefined;
}

async function enqueueAccess(
  db: Queryable,
  repoId: number,
  notBefore?: Date,
): Promise<void> {
  const earlier = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2",
    [REPO_ACCESS_JOB, repoId],
  );
  await enqueueJob(db, {
    type: REPO_ACCESS_JOB,
    payload: { repoId },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `repo-${repoId}:access:${Number(earlier.rows[0]?.n) + 1}`,
    ...(notBefore ? { notBefore } : {}),
  });
}

// Queues a check now, unless one is already waiting or running for the repo. A daily check sitting in the
// future is brought forward. The last answer is kept until a new one comes.
export async function requestRepoAccess(
  db: Queryable,
  repoId: number,
  now: Date,
): Promise<void> {
  const waiting = await db.query<{ id: number; state: string }>(
    `SELECT id, state FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2 AND state IN ('queued', 'running')`,
    [REPO_ACCESS_JOB, repoId],
  );
  if (waiting.rowCount) {
    if (waiting.rows[0]?.state === "queued")
      await db.query(
        `UPDATE jobs SET not_before = $2 WHERE id = $1 AND state = 'queued'`,
        [waiting.rows[0].id, now],
      );
  } else await enqueueAccess(db, repoId);
  await db.query(
    `UPDATE repos SET access = jsonb_set(COALESCE(access, '{}'::jsonb), '{requestedAt}', to_jsonb($2::text)) WHERE id = $1`,
    [repoId, now.toISOString()],
  );
}

async function scheduleNextRepoAccess(
  db: Queryable,
  repoId: number,
  now: Date,
): Promise<void> {
  const waiting = await db.query(
    `SELECT 1 FROM jobs WHERE type = $1 AND (payload->>'repoId')::int = $2 AND state IN ('queued', 'running')`,
    [REPO_ACCESS_JOB, repoId],
  );
  if (waiting.rowCount) return;
  await enqueueAccess(
    db,
    repoId,
    new Date(now.getTime() + ACCESS_INTERVAL_SECONDS * 1000),
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

export function redAccessProblem(
  name: string,
  access:
    | {
        state?: string;
        fix?: string;
        username?: string;
        message?: string;
        hostKind?: string;
      }
    | undefined,
): string | undefined {
  if (access?.state === "not-member")
    return `${name}: ${access.fix ?? `请项目 Maintainer 把${access.username ? `〈${access.username}〉` : "令牌用户"}加为 Developer`}`;
  if (access?.state === "error") {
    const detail = access.message ?? "unknown error";
    return access.hostKind === "gitlab"
      ? `${name}: 托管无法检查：${detail}`
      : `${name}: the GitHub App could not be checked: ${detail}`;
  }
  return undefined;
}

export async function recordRepoAccess(
  db: Queryable,
  { repoId }: RepoAccessPayload,
  result: Record<string, unknown>,
  now: Date,
  notify?: (notice: Notice) => Promise<void>,
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
    await scheduleNextRepoAccess(db, repoId, now);
    return;
  }
  const missing = Array.isArray(result.missing)
    ? result.missing.filter((m): m is string => typeof m === "string")
    : undefined;
  const files =
    typeof result.files === "object" && result.files !== null
      ? (result.files as Record<string, unknown>)
      : undefined;
  const hints = Array.isArray(result.hints)
    ? result.hints.filter((h): h is (typeof ACCESS_HINTS)[number] =>
        (ACCESS_HINTS as readonly unknown[]).includes(h),
      )
    : undefined;
  await keep(db, repoId, {
    state,
    ...(missing?.length ? { missing } : {}),
    ...(files
      ? {
          files: {
            gates: files.gates === true,
            integrationCompose: files.integrationCompose === true,
          },
        }
      : {}),
    ...(typeof result.fixUrl === "string" ? { fixUrl: result.fixUrl } : {}),
    ...(typeof result.username === "string"
      ? { username: result.username }
      : {}),
    ...(typeof result.fix === "string" ? { fix: result.fix } : {}),
    ...(hints?.length ? { hints } : {}),
    checkedAt: now.toISOString(),
  });
  const repo = (
    await db.query<{ url: string }>("SELECT url FROM repos WHERE id = $1", [
      repoId,
    ])
  ).rows[0];
  const host = repo ? repoHost(repo.url) : undefined;
  if (host && Object.hasOwn(result, "tokenExpiresAt")) {
    const expires =
      typeof result.tokenExpiresAt === "string" ? result.tokenExpiresAt : null;
    const notice = await recordTokenExpiry(db, host, expires, now);
    if (notice) await notify?.(notice);
  }
  await scheduleNextRepoAccess(db, repoId, now);
}

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
  await scheduleNextRepoAccess(db, repoId, now);
}

export async function readRepoAccess(
  pool: pg.Pool,
  projectId: number,
  name: string,
): Promise<RepoAccess | "no-repo"> {
  const repo = (
    await pool.query<{
      host_kind: HostKind;
      access: {
        requestedAt?: string;
        last?: Extract<RepoAccess, { checkedAt: string }>;
      } | null;
    }>(
      "SELECT host_kind, access FROM repos WHERE project_id = $1 AND name = $2",
      [projectId, name],
    )
  ).rows[0];
  if (!repo) return "no-repo";
  const hostKind = repo.host_kind;
  const { last, requestedAt } = repo.access ?? {};
  if (last)
    return requestedAt && requestedAt > last.checkedAt
      ? { ...last, checking: true, hostKind }
      : { ...last, hostKind };
  if (requestedAt) return { state: "pending", requestedAt, hostKind };
  return { state: "unchecked", hostKind };
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
