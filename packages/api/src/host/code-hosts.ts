import {
  type HostKind,
  hostKindOfUrl,
  mixedHostsProblem,
  repoHost,
} from "@afk/shared";
import type pg from "pg";
import type { Notice } from "../notify/notices.ts";
import { pageUrl } from "../page-url.ts";

// The code hosts the platform can work on are the ones a worker has credentials for: each worker says which at start
// (GitHub App: github.com; each GitLab PAT: its host). A repo's host kind follows from its address's host.

export interface CodeHost {
  host: string;
  kind: HostKind;
}

export const TOKEN_EXPIRY_NOTICE_DAYS = 30;

type Queryable = Pick<pg.Pool, "query">;

export async function reportHosts(
  pool: Queryable,
  workerId: string,
  hosts: readonly CodeHost[],
): Promise<void> {
  for (const { host, kind } of hosts) {
    await pool.query(
      `INSERT INTO code_hosts (host, kind, worker_id, reported_at) VALUES (lower($1), $2, $3, now())
       ON CONFLICT (host) DO UPDATE SET kind = $2, worker_id = $3, reported_at = now()`,
      [host, kind, workerId],
    );
  }
}

export function daysUntil(expiresAt: string, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAt);
  if (!match) return undefined;
  const exp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((exp - today) / 86_400_000);
}

export async function listHosts(pool: Queryable, now: Date = new Date()) {
  const { rows } = await pool.query<{
    host: string;
    kind: HostKind;
    worker_id: string;
    reported_at: Date;
    token_expires_at: string | null;
  }>(
    "SELECT host, kind, worker_id, reported_at, token_expires_at FROM code_hosts ORDER BY host",
  );
  return rows.map((row) => {
    const daysLeft =
      row.token_expires_at === null
        ? undefined
        : daysUntil(row.token_expires_at, now);
    return {
      host: row.host,
      kind: row.kind,
      workerId: row.worker_id,
      reportedAt: row.reported_at.toISOString(),
      ...(row.token_expires_at && daysLeft !== undefined
        ? { tokenExpiresAt: row.token_expires_at, daysLeft }
        : {}),
    };
  });
}

// A GitLab PAT's expiry, as the worker last read it. Remaining 30 days (or already expired) fires one macOS
// notice per expiry date; replacing the token (a later date) can fire again.
export async function recordTokenExpiry(
  db: Queryable,
  host: string,
  expiresAt: string | null,
  now: Date,
): Promise<Notice | undefined> {
  const date =
    expiresAt !== null && daysUntil(expiresAt, now) !== undefined
      ? expiresAt
      : null;
  await db.query(
    `UPDATE code_hosts SET
       token_expires_at = $2,
       token_expiry_noticed_at = CASE
         WHEN $2::text IS NULL THEN NULL
         WHEN token_expires_at IS NOT DISTINCT FROM $2 THEN token_expiry_noticed_at
         ELSE NULL
       END
     WHERE host = $1`,
    [host, date],
  );
  if (date === null) return undefined;
  const daysLeft = daysUntil(date, now);
  if (daysLeft === undefined || daysLeft > TOKEN_EXPIRY_NOTICE_DAYS)
    return undefined;
  const marked = await db.query<{ host: string }>(
    `UPDATE code_hosts SET token_expiry_noticed_at = $2
     WHERE host = $1 AND token_expires_at = $3 AND token_expiry_noticed_at IS NULL
     RETURNING host`,
    [host, now, date],
  );
  if (!marked.rowCount) return undefined;
  const remain =
    daysLeft < 0
      ? `${host} 的个人令牌已于 ${date} 过期`
      : `${host} 的个人令牌将在 ${date} 到期（还剩 ${daysLeft} 天）`;
  return {
    title: "GitLab 令牌即将到期",
    body: `${remain}：换令牌后放到 ~/.afk/secrets/gitlab/${host}，不用重启 worker\n${pageUrl("/")}`,
  };
}

// The kind of host a repo is on: what a worker reported for its host; for a host none reported (tests, or a repo
// registered before the workers said), what its address suggests.
export async function hostKindOf(
  pool: Queryable,
  url: string,
): Promise<HostKind> {
  const host = repoHost(url);
  if (host) {
    const { rows } = await pool.query<{ kind: HostKind }>(
      "SELECT kind FROM code_hosts WHERE host = $1",
      [host],
    );
    if (rows[0]) return rows[0].kind;
  }
  return hostKindOfUrl(url);
}

// Null when a repo of this kind may join the project; otherwise what to tell the person.
export async function mixedHostsWith(
  pool: Queryable,
  projectId: number,
  repo: { name: string; hostKind: HostKind },
): Promise<string | null> {
  const { rows } = await pool.query<{ name: string; host_kind: HostKind }>(
    "SELECT name, host_kind FROM repos WHERE project_id = $1 ORDER BY id",
    [projectId],
  );
  return mixedHostsProblem([
    ...rows.map((row) => ({ name: row.name, hostKind: row.host_kind })),
    repo,
  ]);
}
