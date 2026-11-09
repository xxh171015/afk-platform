import {
  type HostKind,
  hostKindOfUrl,
  mixedHostsProblem,
  repoHost,
} from "@afk/shared";
import type pg from "pg";

// The code hosts the platform can work on are the ones a worker has credentials for: each worker says which at start
// (GitHub App: github.com; each GitLab PAT: its host). A repo's host kind follows from its address's host.

export interface CodeHost {
  host: string;
  kind: HostKind;
}

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

export async function listHosts(pool: Queryable) {
  const { rows } = await pool.query<{
    host: string;
    kind: HostKind;
    worker_id: string;
    reported_at: Date;
  }>("SELECT host, kind, worker_id, reported_at FROM code_hosts ORDER BY host");
  return rows.map((row) => ({
    host: row.host,
    kind: row.kind,
    workerId: row.worker_id,
    reportedAt: row.reported_at.toISOString(),
  }));
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
