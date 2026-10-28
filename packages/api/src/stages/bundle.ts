import { formatDisplayId, type TicketState } from "@afk/shared";
import type pg from "pg";
import { readStagePayload } from "../jobs/stage-jobs.ts";

// Everything a worker needs to render /context for a stage job (docs/design.md「Agent 与 skills 对接」).
// The contract travels as a pointer, a SHA and a path in the repo that holds it: the worker reads the file
// with `git show <sha>:<path>`, so the platform never stores contract text.

export interface Bundle {
  job: { id: number; stage: string; attempt: number };
  // The Run this job started when it was claimed: logs attach to it and commits are stamped with it.
  run: { id: number; displayId: string } | null;
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
    // A restart-retry: the implement run starts from the integration branch, not from the old ticket branch.
    restart: boolean;
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
  // The project's protected path globs, and the subset of changes to them this ticket may make.
  protectedPaths: string[];
  allowedProtectedPaths: string[];
  contract: { sha: string; path: string; repoId: number } | null;
  // For gate-fix and merge-fix: the tail of the gate that failed last. For review-fix: the review's result.
  failureLog: string | null;
  review: unknown;
}

export async function buildBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number; payload: Record<string, unknown> },
): Promise<Bundle | undefined> {
  const read = readStagePayload(job.payload);
  if (!read) return undefined;
  const { ticketId, stage } = read;

  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.title, t.body, t.acceptance_criteria, t.modules, t.state, t.content_version,
            t.fix_counts, t.reviewed, t.restart, t.allowed_protected_paths,
            s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches,
            r.id AS repo_id, r.role, r.url, r.default_branch,
            p.contract_path, p.protected_paths
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

  const run = await pool.query<{ id: number }>(
    "SELECT id FROM runs WHERE job_id = $1",
    [job.id],
  );
  // What the previous stages found, kept in the output of their Runs, so a worker needs no memory of its own.
  // Only the most recent gate or merge counts: an old failure that was fixed since is not news.
  const failed = await pool.query<{ log: string | null }>(
    `SELECT output->>'failureLog' AS log FROM runs
     WHERE id = (SELECT max(id) FROM runs WHERE ticket_id = $1 AND stage IN ('gate', 'merge') AND result IS NOT NULL)
       AND result IN ('failed', 'gate-failed', 'conflict')`,
    [ticketId],
  );
  const reviewed = await pool.query<{ output: unknown }>(
    "SELECT output FROM runs WHERE ticket_id = $1 AND stage = 'review' AND output IS NOT NULL ORDER BY id DESC LIMIT 1",
    [ticketId],
  );

  return {
    job: { id: job.id, stage, attempt: job.attempt },
    run: run.rows[0]
      ? {
          id: run.rows[0].id,
          displayId: formatDisplayId("run", run.rows[0].id),
        }
      : null,
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
      restart: row.restart,
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
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: row.allowed_protected_paths,
    contract:
      pointer && contractPath
        ? {
            sha: pointer.contract_sha,
            path: contractPath,
            repoId: pointer.repo_id,
          }
        : null,
    failureLog: failed.rows[0]?.log ?? null,
    review: reviewed.rows[0]?.output ?? null,
  };
}
