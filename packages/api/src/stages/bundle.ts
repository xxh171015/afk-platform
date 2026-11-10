import {
  branchNames,
  formatDisplayId,
  resolveLimits,
  type TicketState,
} from "@afk/shared";
import type pg from "pg";
import { readUpdateBranchPayload } from "../host/update-branch.ts";
import { readFinalPayload, readStagePayload } from "../jobs/stage-jobs.ts";
import { ticketFileOf } from "../tickets/ticket-file.ts";
import { contractsOf } from "./contracts.ts";
import { environmentOf, refsOf } from "./refs.ts";
import { reviewJsonOf } from "./review-json.ts";

// Everything a worker needs to render /context for a stage job (docs/design.md「Agent 与 skills 对接」).
// The contract travels as a pointer, a SHA and a path in the repo that holds it: the worker reads the file
// with `git show <sha>:<path>`, so the platform never stores contract text.

export interface BundleContract {
  repo: string;
  url: string;
  defaultBranch: string;
  sha: string;
  path: string;
}

// A repo the ticket reads (refs:). The worker snapshots it at `sha` and mounts that at /refs/<name>; null means the
// repo has no merged work in this spec, so the head of its default branch is what the snapshot is taken at.
export interface BundleRef {
  name: string;
  url: string;
  defaultBranch: string;
  sha: string | null;
}

export interface Bundle {
  job: { id: number; stage: string; attempt: number };
  // The Run this job started when it was claimed: logs attach to it and commits are stamped with it.
  run: { id: number; displayId: string } | null;
  // null for the spec-level steps of a finalization, which have no ticket of their own
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
    // The ticket as one markdown file (the same as GET /tickets/{id}'s file): /context/ticket.md.
    file: string;
    // A restart-retry: the implement run starts from the integration branch, not from the old ticket branch.
    restart: boolean;
  } | null;
  // What the spec's tickets set out to do: the yardstick of an overall review.
  specTickets: {
    displayId: string;
    title: string;
    acceptanceCriteria: string[];
  }[];
  spec: {
    id: number;
    displayId: string;
    slug: string;
    title: string;
    body: string;
    type: string;
  };
  repo: { id: number; name: string; url: string; defaultBranch: string };
  // Planning commit of the spec. The worker cuts the planning repo's integration branch from this SHA and
  // mounts GLOSSARY/ADR at /context/domain/ for every other repo's tickets. Null when confirm did not register one.
  domain: {
    repo: string;
    url: string;
    defaultBranch: string;
    sha: string;
  } | null;
  integrationBranch: string | null;
  // The branch the stage's work is made on: the ticket's own, or the one of the spec's overall fix.
  agentBranch: string;
  // The project's protected path globs, and the subset of changes to them this ticket may make.
  protectedPaths: string[];
  allowedProtectedPaths: string[];
  // One per repo that provides a contract this ticket builds against: the file at the newest contract ticket's SHA.
  contracts: BundleContract[];
  refs: BundleRef[];
  // For an integration ticket: the repos whose services make up its integration environment, in the order their
  // seed services run.
  environment: BundleRef[];
  // The Retry note of this Run, if the person wrote one; null when they did not.
  note: string | null;
  // For gate-fix and merge-fix: the tail of the gate that failed last. For review-fix: the review's result.
  failureLog: string | null;
  review: unknown;
  // What the last merge into the integration branch measured: a gate may not find fewer tests or more skipped ones
  // than this. Null before the spec has merged anything.
  gateBaseline: { tests: number; skipped: number } | null;
  // Every merge's measurement, newest first, with the commit it was taken at. A ticket's own gate is held only to
  // the newest one its branch already contains: merges that landed after it branched are not its to answer for.
  gateBaselines: { sha: string; tests: number; skipped: number }[];
  // The project's say over how a run is carried out: how long an agent may be silent or run in all, and the model
  // it uses (null: the worker's own AFK_MODEL).
  limits: {
    runIdleSeconds: number;
    runWallclockSeconds: number;
    maxIntegrationEnvironments: number;
  };
  model: string | null;
}

// Defaults where the project sets nothing; only the limits a worker acts on travel, the rest is the API's business.
const runSettings = (limits: unknown, defaultModel: unknown) => {
  const { runIdleSeconds, runWallclockSeconds, maxIntegrationEnvironments } =
    resolveLimits(limits);
  return {
    limits: { runIdleSeconds, runWallclockSeconds, maxIntegrationEnvironments },
    model: (defaultModel as string | null) ?? null,
  };
};

function domainOf(row: {
  planning_sha: string | null;
  planning_repo_name: string | null;
  planning_repo_url: string | null;
  planning_default_branch: string | null;
}): Bundle["domain"] {
  if (
    !row.planning_sha ||
    !row.planning_repo_name ||
    !row.planning_repo_url ||
    !row.planning_default_branch
  ) {
    return null;
  }
  return {
    repo: row.planning_repo_name,
    url: row.planning_repo_url,
    defaultBranch: row.planning_default_branch,
    sha: row.planning_sha,
  };
}

async function gateBaselineFor(pool: pg.Pool, specId: number, repoId: number) {
  const { rows } = await pool.query<{
    tests_total: number;
    tests_skipped: number | null;
  }>(
    `SELECT g.tests_total, g.tests_skipped FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.spec_id = $1 AND r.repo_id = $2 AND r.stage IN ('merge', 'final-merge', 'update-branch') AND r.result = 'merged'
       AND g.tests_total IS NOT NULL
     ORDER BY r.id DESC LIMIT 1`,
    [specId, repoId],
  );
  const row = rows[0];
  return row
    ? { tests: row.tests_total, skipped: row.tests_skipped ?? 0 }
    : null;
}

async function gateBaselinesFor(pool: pg.Pool, specId: number, repoId: number) {
  const { rows } = await pool.query<{
    sha: string;
    tests_total: number;
    tests_skipped: number | null;
  }>(
    `SELECT r.head_sha AS sha, g.tests_total, g.tests_skipped FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.spec_id = $1 AND r.repo_id = $2 AND r.stage IN ('merge', 'final-merge', 'update-branch') AND r.result = 'merged'
       AND g.tests_total IS NOT NULL
     ORDER BY r.id DESC LIMIT 50`,
    [specId, repoId],
  );
  return rows.map((r) => ({
    sha: r.sha,
    tests: r.tests_total,
    skipped: r.tests_skipped ?? 0,
  }));
}

export async function buildBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number; payload: Record<string, unknown> },
): Promise<Bundle | undefined> {
  const update = readUpdateBranchPayload(job.payload);
  if (update) return buildUpdateBranchBundle(pool, job, update);
  const final = readFinalPayload(job.payload);
  if (final) return buildFinalBundle(pool, job, final);
  const read = readStagePayload(job.payload);
  if (!read) return undefined;
  const { ticketId, stage } = read;

  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.title, t.body, t.acceptance_criteria, t.modules, t.state, t.content_version,
            t.fix_counts, t.reviewed, t.restart, t.allowed_protected_paths,
            s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths, p.limits, p.default_model
     FROM tickets t
     JOIN specs s ON s.id = t.spec_id
     JOIN repos r ON r.id = t.repo_id
     JOIN projects p ON p.id = s.project_id
     LEFT JOIN repos pr ON pr.id = s.planning_repo_id
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

  const contracts = await contractsOf(pool, ticketId);
  const refs = await refsOf(pool, ticketId);
  const environment = await environmentOf(pool, ticketId);

  const run = await pool.query<{ id: number; retry_note: string | null }>(
    "SELECT id, retry_note FROM runs WHERE job_id = $1",
    [job.id],
  );
  // What the previous stages found, kept in the output of their Runs, so a worker needs no memory of its own.
  // Only the most recent gate or merge counts: an old failure that was fixed since is not news.
  const failed = await pool.query<{ log: string | null }>(
    `SELECT output->>'failureLog' AS log FROM runs
     WHERE id = (SELECT max(id) FROM runs WHERE ticket_id = $1 AND stage IN ('gate', 'merge', 'e2e') AND result IS NOT NULL)
       AND result IN ('failed', 'gate-failed', 'conflict')`,
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
      file: (await ticketFileOf(pool, row.id)) as string,
    },
    specTickets: [],
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
      name: row.name,
      url: row.url,
      defaultBranch: row.default_branch,
    },
    domain: domainOf(row),
    integrationBranch,
    agentBranch: branchNames(row.branch_namespace).ticket(
      formatDisplayId("ticket", row.id),
    ),
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: row.allowed_protected_paths,
    contracts,
    refs,
    environment,
    note: run.rows[0]?.retry_note ?? null,
    failureLog: failed.rows[0]?.log ?? null,
    review: await reviewJsonOf(pool, "ticket_id = $1 AND stage = 'review'", [
      ticketId,
    ]),
    gateBaseline: await gateBaselineFor(pool, row.spec_id, row.repo_id),
    gateBaselines: await gateBaselinesFor(pool, row.spec_id, row.repo_id),
    ...runSettings(row.limits, row.default_model),
  };
}

// The bundle of a finalization step: the spec and its repo, the list of what the tickets were for, and (for a fix
// or a merge after a failure) what went wrong before.
async function buildFinalBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number },
  final: { specId: number; repoId: number; step: string },
): Promise<Bundle | undefined> {
  const found = await pool.query(
    `SELECT s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths,
            p.limits, p.default_model
     FROM specs s JOIN repos r ON r.id = $2 JOIN projects p ON p.id = s.project_id
     LEFT JOIN repos pr ON pr.id = s.planning_repo_id
     WHERE s.id = $1`,
    [final.specId, final.repoId],
  );
  const row = found.rows[0];
  if (!row) return undefined;
  const tickets = await pool.query(
    `SELECT id, title, acceptance_criteria FROM tickets WHERE spec_id = $1 AND repo_id = $2 AND state = 'done' ORDER BY id`,
    [final.specId, final.repoId],
  );
  const run = await pool.query<{ id: number; retry_note: string | null }>(
    "SELECT id, retry_note FROM runs WHERE job_id = $1",
    [job.id],
  );
  // the review that asked for the fix, and the log of the merge or gate that failed last
  const failed = await pool.query<{ log: string | null }>(
    `SELECT output->>'failureLog' AS log FROM runs
     WHERE spec_id = $1 AND ticket_id IS NULL AND stage = 'final-merge' AND result IN ('conflict', 'gate-failed')
     ORDER BY id DESC LIMIT 1`,
    [final.specId],
  );
  const branches = row.integration_branches as {
    repoId: number;
    branch: string;
  }[];
  return {
    job: { id: job.id, stage: final.step, attempt: job.attempt },
    run: run.rows[0]
      ? {
          id: run.rows[0].id,
          displayId: formatDisplayId("run", run.rows[0].id),
        }
      : null,
    ticket: null,
    specTickets: tickets.rows.map((t) => ({
      displayId: formatDisplayId("ticket", t.id),
      title: t.title as string,
      acceptanceCriteria: t.acceptance_criteria as string[],
    })),
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
      name: row.name,
      url: row.url,
      defaultBranch: row.default_branch,
    },
    domain: domainOf(row),
    integrationBranch:
      branches.find((b) => b.repoId === row.repo_id)?.branch ?? null,
    agentBranch: branchNames(row.branch_namespace).final(
      formatDisplayId("spec", row.spec_id),
    ),
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: [],
    contracts: [],
    refs: [],
    environment: [],
    note: run.rows[0]?.retry_note ?? null,
    failureLog: failed.rows[0]?.log ?? null,
    review: await reviewJsonOf(
      pool,
      "spec_id = $1 AND repo_id = $2 AND ticket_id IS NULL AND stage = 'final-review'",
      [final.specId, final.repoId],
    ),
    gateBaseline: await gateBaselineFor(pool, final.specId, final.repoId),
    gateBaselines: await gateBaselinesFor(pool, final.specId, final.repoId),
    ...runSettings(row.limits, row.default_model),
  };
}

// main into the integration branch: same shape as a ticket merge. The bundle's agent branch is always the
// spec's temp branch (a platform branch, so a worker can take a slot). The first locked merge still
// merge-trees the default branch when that temp does not exist yet. The Run belongs to the spec, not a ticket.
async function buildUpdateBranchBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number },
  update: { specId: number; repoId: number; fix: boolean; afterFix: boolean },
): Promise<Bundle | undefined> {
  const found = await pool.query(
    `SELECT s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths,
            p.limits, p.default_model
     FROM specs s JOIN repos r ON r.id = $2 JOIN projects p ON p.id = s.project_id
     LEFT JOIN repos pr ON pr.id = s.planning_repo_id
     WHERE s.id = $1`,
    [update.specId, update.repoId],
  );
  const row = found.rows[0];
  if (!row) return undefined;
  const run = await pool.query<{ id: number; retry_note: string | null }>(
    "SELECT id, retry_note FROM runs WHERE job_id = $1",
    [job.id],
  );
  const failed = await pool.query<{ log: string | null }>(
    `SELECT output->>'failureLog' AS log FROM runs
     WHERE spec_id = $1 AND ticket_id IS NULL AND stage = 'update-branch' AND result IN ('conflict', 'gate-failed')
     ORDER BY id DESC LIMIT 1`,
    [update.specId],
  );
  const branches = row.integration_branches as {
    repoId: number;
    branch: string;
  }[];
  return {
    job: { id: job.id, stage: "update-branch", attempt: job.attempt },
    run: run.rows[0]
      ? {
          id: run.rows[0].id,
          displayId: formatDisplayId("run", run.rows[0].id),
        }
      : null,
    ticket: null,
    specTickets: [],
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
      name: row.name,
      url: row.url,
      defaultBranch: row.default_branch,
    },
    domain: domainOf(row),
    integrationBranch:
      branches.find((b) => b.repoId === row.repo_id)?.branch ?? null,
    agentBranch: branchNames(row.branch_namespace).update(
      formatDisplayId("spec", row.spec_id),
    ),
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: [],
    contracts: [],
    refs: [],
    environment: [],
    note: run.rows[0]?.retry_note ?? null,
    failureLog: failed.rows[0]?.log ?? null,
    review: null,
    gateBaseline: await gateBaselineFor(pool, update.specId, update.repoId),
    gateBaselines: await gateBaselinesFor(pool, update.specId, update.repoId),
    ...runSettings(row.limits, row.default_model),
  };
}
