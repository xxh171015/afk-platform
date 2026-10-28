import { formatDisplayId, type TicketState } from "@afk/shared";
import type pg from "pg";

// Everything a worker needs to render /context for a stage job (docs/design.md「Agent 与 skills 对接」).
// The contract travels as a pointer, a SHA and a path in the repo that holds it: the worker reads the file
// with `git show <sha>:<path>`, so the platform never stores contract text.

export interface Bundle {
  job: { id: number; stage: string; attempt: number };
  ticket: {
    id: number;
    displayId: string;
    type: string;
    title: string;
    body: string;
    acceptanceCriteria: string[];
    modules: string[];
    state: TicketState;
    contentVersion: number;
    fixCounts: Record<string, number>;
    reviewed: boolean;
  };
  spec: {
    id: number;
    displayId: string;
    slug: string;
    title: string;
    body: string;
    type: string;
  };
  repo: { id: number; role: string; url: string; defaultBranch: string };
  integrationBranch: string | null;
  allowedProtectedPaths: string[];
  contract: { sha: string; path: string; repoId: number } | null;
}

export async function buildBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number; payload: Record<string, unknown> },
): Promise<Bundle | undefined> {
  const { ticketId, stage } = job.payload as {
    ticketId?: unknown;
    stage?: unknown;
  };
  if (typeof ticketId !== "number" || typeof stage !== "string")
    return undefined;

  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.title, t.body, t.acceptance_criteria, t.modules, t.state, t.content_version,
            t.fix_counts, t.reviewed, t.allowed_protected_paths,
            s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches,
            r.id AS repo_id, r.role, r.url, r.default_branch,
            p.contract_path
     FROM tickets t
     JOIN specs s ON s.id = t.spec_id
     JOIN repos r ON r.id = t.repo_id
     JOIN projects p ON p.id = s.project_id
     WHERE t.id = $1`,
    [ticketId],
  );
  const row = rows[0];
  if (!row) return undefined;

  const branches = row.integration_branches as {
    repoId: number;
    branch: string;
  }[];
  const integrationBranch =
    branches.find((b) => b.repoId === row.repo_id)?.branch ?? null;

  // The upstream of a contract edge, once it has recorded its SHA. contract_path is "<repo role>:<path>".
  const upstream = await pool.query<{ contract_sha: string; repo_id: number }>(
    `SELECT u.contract_sha, u.repo_id FROM edges e JOIN tickets u ON u.id = e.from_ticket_id
     WHERE e.to_ticket_id = $1 AND e.kind = 'contract' AND u.contract_sha IS NOT NULL LIMIT 1`,
    [ticketId],
  );
  const pointer = upstream.rows[0];
  const contractPath = row.contract_path as string | null;

  return {
    job: { id: job.id, stage, attempt: job.attempt },
    ticket: {
      id: row.id,
      displayId: formatDisplayId("ticket", row.id),
      type: row.type,
      title: row.title,
      body: row.body,
      acceptanceCriteria: row.acceptance_criteria,
      modules: row.modules,
      state: row.state,
      contentVersion: row.content_version,
      fixCounts: row.fix_counts,
      reviewed: row.reviewed,
    },
    spec: {
      id: row.spec_id,
      displayId: formatDisplayId("spec", row.spec_id),
      slug: row.slug,
      title: row.spec_title,
      body: row.spec_body,
      type: row.spec_type,
    },
    repo: {
      id: row.repo_id,
      role: row.role,
      url: row.url,
      defaultBranch: row.default_branch,
    },
    integrationBranch,
    allowedProtectedPaths: row.allowed_protected_paths,
    contract:
      pointer && contractPath
        ? {
            sha: pointer.contract_sha,
            path: contractPath,
            repoId: pointer.repo_id,
          }
        : null,
  };
}
