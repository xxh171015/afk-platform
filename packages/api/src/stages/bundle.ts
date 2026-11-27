import {
  branchNames,
  CODE_CHANGING_STAGES,
  DEFAULT_TICKET_REVIEW,
  type DecisionLog,
  decisionLogFromRuns,
  formatDisplayId,
  parseStageModels,
  resolveLimits,
  type StageModels,
  type TicketReviewMode,
  type TicketState,
} from "@afk/shared";
import type pg from "pg";
import {
  readUpdateBranchPayload,
  type UpdateBranchPayload,
} from "../host/update-branch.ts";
import { readFinalPayload, readStagePayload } from "../jobs/stage-jobs.ts";
import {
  type LocatePayload,
  readLocatePayload,
} from "../planning/locate-bug.ts";
import { ticketFileOf } from "../tickets/ticket-file.ts";
import { contractsOf } from "./contracts.ts";
import { recallGateTestCases } from "./gate-records.ts";
import { environmentOf, refsOf, refsOfSpecRepo } from "./refs.ts";
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
  // Ticket stages get every ticket of the spec; finalization still lists done tickets of this repo.
  specTickets: {
    displayId: string;
    title: string;
    body: string;
    acceptanceCriteria: string[];
    modules: string[];
    status: "done" | "running" | "other";
    // True when this ticket is in the current ticket's blocked_by. Always false on finalization.
    upstream: boolean;
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
  // Still-failing JUnit cases of that gate, when the report named them. Null when there were none.
  failedCases: Array<{
    name: string;
    classname: string;
    file?: string;
    message?: string;
  }> | null;
  review: unknown;
  // What the last merge into the integration branch measured: a gate may not find fewer tests or more skipped ones
  // than this. Names are present when that merge's JUnit listed classname+name. Null before the spec has merged anything.
  gateBaseline: {
    tests: number;
    skipped: number;
    names?: { classname: string; name: string }[];
  } | null;
  // Every merge's measurement, newest first, with the commit it was taken at. A ticket's own gate is held only to
  // the newest one its branch already contains: merges that landed after it branched are not its to answer for.
  gateBaselines: {
    sha: string;
    tests: number;
    skipped: number;
    names?: { classname: string; name: string }[];
  }[];
  // Last passing ticket gate's names, for the merge three-way. Null when this job has no ticket or that gate listed none.
  ticketGateNames: { classname: string; name: string }[] | null;
  // Decision log for /context: earlier Decisions on this ticket, done siblings, wrap-up runs.
  decisionLog: DecisionLog;
  // Names a person has allowed this ticket (or this wrap-up / update-branch job) to drop.
  approvedRemovedTests: { classname: string; name: string }[] | null;
  // The project's say over how a run is carried out: how long an agent may be silent or run in all, and the model
  // it uses (null: the worker's own AFK_MODEL).
  limits: {
    runIdleSeconds: number;
    runWallclockSeconds: number;
    maxIntegrationEnvironments: number;
  };
  model: string | null;
  // Ticket-level review: spec (default) or both. final-review ignores this and always runs both axes.
  ticketReview: TicketReviewMode;
  // Per-role model overrides (standards, update-branch, merge-fix). Empty: the default model / AFK_MODEL.
  stageModels: StageModels;
  // Recheck: the commits and paths this Spec-axis look is about. Null on other stages.
  recheck: { fromSha: string; toSha: string; paths: string[] } | null;
  // Ticket-review uncertainties for wrap-up `/context/uncertainties.json`. Null on ticket stages.
  uncertainties:
    | {
        id: string;
        ticket: string;
        run: string;
        body: string;
      }[]
    | null;
  // rework: this repo's submitted Review comments for the active Change request. Null on other stages.
  reviewComments: {
    changeRequest: number;
    currentHead: string;
    comments: {
      id: string;
      writtenOn: string;
      path: string | null;
      side?: "old" | "new" | null;
      lines?: number[];
      excerpt?: string;
      body: string;
    }[];
  } | null;
  // After handback, the next implement job resolves the resume stage from the remote tip.
  handbackResolve?: boolean;
}

// Defaults where the project sets nothing; only the limits a worker acts on travel, the rest is the API's business.
const runSettings = (
  limits: unknown,
  defaultModel: unknown,
  ticketReview: unknown,
  stageModels: unknown,
) => {
  const { runIdleSeconds, runWallclockSeconds, maxIntegrationEnvironments } =
    resolveLimits(limits);
  return {
    limits: { runIdleSeconds, runWallclockSeconds, maxIntegrationEnvironments },
    model: (defaultModel as string | null) ?? null,
    ticketReview: ticketReview === "both" ? "both" : DEFAULT_TICKET_REVIEW,
    stageModels: parseStageModels(stageModels),
  };
};

function testNamesFrom(raw: unknown): { classname: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const names: { classname: string; name: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.classname !== "string")
      continue;
    names.push({ classname: rec.classname, name: rec.name });
  }
  return names;
}

function withNames<T extends { tests: number; skipped: number }>(
  row: T,
  cases: unknown,
): T & { names?: { classname: string; name: string }[] } {
  const names = testNamesFrom(cases);
  return names.length > 0 ? { ...row, names } : row;
}

function recheckOf(payload: Record<string, unknown>): Bundle["recheck"] {
  const fromSha = payload.fromSha;
  const toSha = payload.toSha;
  if (typeof fromSha !== "string" || typeof toSha !== "string") return null;
  if (!fromSha || !toSha) return null;
  const raw = payload.paths;
  const paths = Array.isArray(raw)
    ? raw.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
    : [];
  return { fromSha, toSha, paths };
}

function failedCasesFrom(raw: unknown): Bundle["failedCases"] {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cases: NonNullable<Bundle["failedCases"]> = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.classname !== "string")
      continue;
    cases.push({
      name: rec.name,
      classname: rec.classname,
      ...(typeof rec.file === "string" && rec.file ? { file: rec.file } : {}),
      ...(typeof rec.message === "string" && rec.message
        ? { message: rec.message }
        : {}),
    });
  }
  return cases.length > 0 ? cases : null;
}

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
    test_cases_hash: string | null;
  }>(
    `SELECT g.tests_total, g.tests_skipped, g.test_cases_hash FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.spec_id = $1 AND r.repo_id = $2 AND r.stage IN ('merge', 'final-merge', 'tidy-merge', 'update-branch') AND r.result = 'merged'
       AND g.tests_total IS NOT NULL
     ORDER BY r.id DESC LIMIT 1`,
    [specId, repoId],
  );
  const row = rows[0];
  if (!row) return null;
  return withNames(
    { tests: row.tests_total, skipped: row.tests_skipped ?? 0 },
    await recallGateTestCases(pool, row.test_cases_hash),
  );
}

async function gateBaselinesFor(pool: pg.Pool, specId: number, repoId: number) {
  const { rows } = await pool.query<{
    sha: string;
    tests_total: number;
    tests_skipped: number | null;
    test_cases_hash: string | null;
  }>(
    `SELECT r.head_sha AS sha, g.tests_total, g.tests_skipped, g.test_cases_hash FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.spec_id = $1 AND r.repo_id = $2 AND r.stage IN ('merge', 'final-merge', 'tidy-merge', 'update-branch') AND r.result = 'merged'
       AND g.tests_total IS NOT NULL
     ORDER BY r.id DESC LIMIT 50`,
    [specId, repoId],
  );
  const listed = await Promise.all(
    rows.map(async (r) =>
      withNames(
        { sha: r.sha, tests: r.tests_total, skipped: r.tests_skipped ?? 0 },
        await recallGateTestCases(pool, r.test_cases_hash),
      ),
    ),
  );
  const repo = await pool.query<{ default_sha: string | null }>(
    "SELECT default_sha FROM repos WHERE id = $1",
    [repoId],
  );
  const sha = repo.rows[0]?.default_sha;
  if (!sha || listed.some((b) => b.sha === sha)) return listed;
  const extra = await pool.query<{
    tests_total: number;
    tests_skipped: number | null;
    test_cases_hash: string | null;
  }>(
    `SELECT tests_total, tests_skipped, test_cases_hash FROM gate_results
     WHERE repo_id = $1 AND commit_sha = $2 AND kind = 'gate' AND tests_total IS NOT NULL`,
    [repoId, sha],
  );
  const row = extra.rows[0];
  if (!row) return listed;
  return [
    ...listed,
    withNames(
      { sha, tests: row.tests_total, skipped: row.tests_skipped ?? 0 },
      await recallGateTestCases(pool, row.test_cases_hash),
    ),
  ];
}

async function wrapUpAgentBranch(
  pool: pg.Pool,
  final: { specId: number; repoId: number; step: string },
  namespace: string | null,
): Promise<string> {
  const names = branchNames(namespace);
  const specDisplay = formatDisplayId("spec", final.specId);
  const throughRework =
    final.step === "rework" ||
    ((final.step === "recheck" || final.step === "final-merge") &&
      (
        await pool.query(
          `SELECT 1 FROM runs r
           JOIN finalizations f ON f.spec_id = r.spec_id AND f.repo_id = r.repo_id
           WHERE r.spec_id = $1 AND r.repo_id = $2 AND r.ticket_id IS NULL
             AND r.stage = 'rework' AND r.job_id > f.job_floor
           LIMIT 1`,
          [final.specId, final.repoId],
        )
      ).rowCount);
  if (throughRework) {
    const number = await pool.query<{ n: number | string | null }>(
      `SELECT COALESCE(
         (SELECT number FROM change_requests WHERE spec_id = $1 AND state = 'active' LIMIT 1),
         (SELECT max(number) FROM change_requests WHERE spec_id = $1)
       ) AS n`,
      [final.specId],
    );
    const k = Number(number.rows[0]?.n);
    if (Number.isInteger(k) && k >= 1) return names.rework(specDisplay, k);
  }
  return names.final(specDisplay);
}

async function reviewCommentsContextOf(
  pool: pg.Pool,
  specId: number,
  repoId: number,
): Promise<Bundle["reviewComments"]> {
  const found = await pool.query<{
    id: number;
    path: string | null;
    side: string | null;
    line_start: number | null;
    line_end: number | null;
    excerpt: string | null;
    body: string;
    written_on: string;
    current_head: string;
    number: number;
  }>(
    `SELECT c.id, c.path, c.side, c.line_start, c.line_end, c.excerpt, c.body,
            r.head_sha AS written_on, p.head_sha AS current_head, cr.number
     FROM review_comments c
     JOIN pull_requests p ON p.id = c.pull_request_id
     JOIN review_revisions r ON r.id = c.revision_id
     JOIN change_requests cr ON cr.id = c.change_request_id
     WHERE c.spec_id = $1 AND p.repo_id = $2 AND c.state = 'submitted'
       AND cr.state = 'active'
     ORDER BY c.id`,
    [specId, repoId],
  );
  if (found.rows.length === 0) return null;
  return {
    changeRequest: found.rows[0].number,
    currentHead: found.rows[0].current_head,
    comments: found.rows.map((row) => {
      const comment: NonNullable<Bundle["reviewComments"]>["comments"][number] =
        {
          id: formatDisplayId("comment", row.id),
          writtenOn: row.written_on,
          path: row.path,
          body: row.body,
        };
      if (row.side === "old" || row.side === "new") comment.side = row.side;
      if (row.line_start != null) {
        comment.lines =
          row.line_end != null && row.line_end !== row.line_start
            ? [row.line_start, row.line_end]
            : [row.line_start];
      }
      if (row.excerpt) comment.excerpt = row.excerpt;
      return comment;
    }),
  };
}

async function uncertaintiesOf(
  pool: pg.Pool,
  specId: number,
): Promise<NonNullable<Bundle["uncertainties"]>> {
  const { rows } = await pool.query<{
    id: number;
    ticket_id: number;
    run_id: number;
    body: string;
  }>(
    `SELECT f.id, r.ticket_id, r.id AS run_id, f.body
     FROM findings f
     JOIN runs r ON r.id = f.run_id
     JOIN tickets t ON t.id = r.ticket_id
     WHERE r.spec_id = $1
       AND f.kind = 'uncertainty'
       AND r.stage IN ('review', 'recheck')
       AND t.state <> 'cancelled'
     ORDER BY f.id`,
    [specId],
  );
  return rows.map((row) => ({
    id: `F-${row.id}`,
    ticket: formatDisplayId("ticket", row.ticket_id),
    run: formatDisplayId("run", row.run_id),
    body: row.body,
  }));
}

function specTicketStatus(state: string): "done" | "running" | "other" {
  if (state === "done" || state === "running") return state;
  return "other";
}

async function specTicketsOf(
  pool: pg.Pool,
  specId: number,
  opts: {
    currentTicketId?: number;
    repoId?: number;
    doneOnly?: boolean;
  } = {},
): Promise<Bundle["specTickets"]> {
  type SpecTicketRow = {
    id: number;
    title: string;
    body: string;
    acceptance_criteria: string[];
    modules: string[];
    state: string;
  };
  const select = `SELECT id, title, body, acceptance_criteria, modules, state
           FROM tickets WHERE spec_id = $1`;
  const tickets =
    opts.repoId !== undefined && opts.doneOnly
      ? await pool.query<SpecTicketRow>(
          `${select} AND repo_id = $2 AND state = 'done' ORDER BY id`,
          [specId, opts.repoId],
        )
      : await pool.query<SpecTicketRow>(`${select} ORDER BY id`, [specId]);
  const upstreamIds = new Set<number>();
  if (opts.currentTicketId !== undefined) {
    const upstream = await pool.query<{ from_ticket_id: number }>(
      "SELECT from_ticket_id FROM edges WHERE to_ticket_id = $1 AND kind = 'blocks'",
      [opts.currentTicketId],
    );
    for (const row of upstream.rows) upstreamIds.add(row.from_ticket_id);
  }
  return tickets.rows.map((t) => ({
    displayId: formatDisplayId("ticket", t.id),
    title: t.title,
    body: t.body,
    acceptanceCriteria: t.acceptance_criteria,
    modules: t.modules ?? [],
    status: specTicketStatus(t.state),
    upstream: upstreamIds.has(t.id),
  }));
}

async function ticketGateNamesFor(
  pool: pg.Pool,
  ticketId: number,
): Promise<Bundle["ticketGateNames"]> {
  const { rows } = await pool.query<{ test_cases_hash: string | null }>(
    `SELECT g.test_cases_hash FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.ticket_id = $1 AND r.stage = 'gate' AND r.result = 'passed'
     ORDER BY r.id DESC LIMIT 1`,
    [ticketId],
  );
  const names = testNamesFrom(
    await recallGateTestCases(pool, rows[0]?.test_cases_hash),
  );
  return names.length > 0 ? names : null;
}

async function decisionLogFor(
  pool: pg.Pool,
  specId: number,
  specDisplayId: string,
  ticketId: number | null,
  ticketDisplayId: string | null,
  currentRunId: number | null,
): Promise<DecisionLog> {
  const tickets = await pool.query<{ id: number; state: string }>(
    "SELECT id, state FROM tickets WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const runs = await pool.query<{
    id: number;
    stage: string;
    ticket_id: number | null;
    axis: string | null;
    output: unknown;
  }>(
    `SELECT id, stage, ticket_id, axis, output FROM runs
     WHERE spec_id = $1 AND output IS NOT NULL AND (
       (stage = ANY($2) AND result = 'done')
       OR (stage IN ('review', 'final-review') AND result IN ('pass', 'fix'))
     )
     ORDER BY id`,
    [specId, [...CODE_CHANGING_STAGES]],
  );
  return decisionLogFromRuns({
    specDisplayId,
    ticketId,
    ticketDisplayId,
    currentRunId,
    tickets: tickets.rows,
    runs: runs.rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      ticketId: row.ticket_id,
      axis: row.axis,
      output: row.output,
    })),
  });
}

export async function buildBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number; payload: Record<string, unknown> },
): Promise<Bundle | undefined> {
  const locate = readLocatePayload(job.payload);
  if (locate) return buildLocateBundle(pool, job, locate);
  const update = readUpdateBranchPayload(job.payload);
  if (update) return buildUpdateBranchBundle(pool, job, update);
  const final = readFinalPayload(job.payload);
  if (final) return buildFinalBundle(pool, job, final);
  const read = readStagePayload(job.payload);
  if (!read) return undefined;
  const { ticketId, stage } = read;

  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.title, t.body, t.acceptance_criteria, t.modules, t.state, t.content_version,
            t.fix_counts, t.reviewed, t.restart, t.allowed_protected_paths, t.allowed_removed_tests,
            s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths, p.limits, p.default_model, p.ticket_review, p.stage_models
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
  const failed = await pool.query<{ log: string | null; cases: unknown }>(
    `SELECT output->>'failureLog' AS log, output->'failedCases' AS cases FROM runs
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
    specTickets: await specTicketsOf(pool, row.spec_id, {
      currentTicketId: ticketId,
    }),
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
    failedCases: failedCasesFrom(failed.rows[0]?.cases),
    review: await reviewJsonOf(pool, "ticket_id = $1 AND stage = 'review'", [
      ticketId,
    ]),
    gateBaseline: await gateBaselineFor(pool, row.spec_id, row.repo_id),
    gateBaselines: await gateBaselinesFor(pool, row.spec_id, row.repo_id),
    ticketGateNames: await ticketGateNamesFor(pool, row.id),
    decisionLog: await decisionLogFor(
      pool,
      row.spec_id,
      formatDisplayId("spec", row.spec_id),
      row.id,
      formatDisplayId("ticket", row.id),
      run.rows[0]?.id ?? null,
    ),
    approvedRemovedTests: (() => {
      const names = testNamesFrom(row.allowed_removed_tests);
      return names.length > 0 ? names : null;
    })(),
    ...runSettings(
      row.limits,
      row.default_model,
      row.ticket_review,
      row.stage_models,
    ),
    recheck: recheckOf(job.payload),
    uncertainties: null,
    reviewComments: null,
    ...(job.payload.handbackResolve === true
      ? { handbackResolve: true as const }
      : {}),
  };
}

// The bundle of a finalization step: the spec and its repo, the list of what the tickets were for, and (for a fix
// or a merge after a failure) what went wrong before.
async function buildFinalBundle(
  pool: pg.Pool,
  job: {
    id: number;
    attempt: number;
    payload: Record<string, unknown>;
  },
  final: { specId: number; repoId: number; step: string },
): Promise<Bundle | undefined> {
  const found = await pool.query(
    `SELECT s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths,
            p.limits, p.default_model, p.ticket_review, p.stage_models
     FROM specs s JOIN repos r ON r.id = $2 JOIN projects p ON p.id = s.project_id
     LEFT JOIN repos pr ON pr.id = s.planning_repo_id
     WHERE s.id = $1`,
    [final.specId, final.repoId],
  );
  const row = found.rows[0];
  if (!row) return undefined;
  const specTickets = await specTicketsOf(pool, final.specId, {
    repoId: final.repoId,
    doneOnly: true,
  });
  const run = await pool.query<{ id: number; retry_note: string | null }>(
    "SELECT id, retry_note FROM runs WHERE job_id = $1",
    [job.id],
  );
  // the review that asked for the fix, and the log of the merge or gate that failed last
  const failed = await pool.query<{ log: string | null; cases: unknown }>(
    `SELECT output->>'failureLog' AS log, output->'failedCases' AS cases FROM runs
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
    specTickets,
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
    agentBranch: await wrapUpAgentBranch(pool, final, row.branch_namespace),
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: [],
    contracts: [],
    refs: await refsOfSpecRepo(pool, final.specId, final.repoId),
    environment: [],
    note: run.rows[0]?.retry_note ?? null,
    failureLog: failed.rows[0]?.log ?? null,
    failedCases: failedCasesFrom(failed.rows[0]?.cases),
    review: await reviewJsonOf(
      pool,
      "spec_id = $1 AND repo_id = $2 AND ticket_id IS NULL AND stage = 'final-review'",
      [final.specId, final.repoId],
    ),
    gateBaseline: await gateBaselineFor(pool, final.specId, final.repoId),
    gateBaselines: await gateBaselinesFor(pool, final.specId, final.repoId),
    ticketGateNames: null,
    decisionLog: await decisionLogFor(
      pool,
      final.specId,
      formatDisplayId("spec", final.specId),
      null,
      null,
      run.rows[0]?.id ?? null,
    ),
    approvedRemovedTests: (() => {
      const names = testNamesFrom(job.payload.approvedRemoved);
      return names.length > 0 ? names : null;
    })(),
    ...runSettings(
      row.limits,
      row.default_model,
      row.ticket_review,
      row.stage_models,
    ),
    recheck: recheckOf(job.payload),
    uncertainties: await uncertaintiesOf(pool, final.specId),
    reviewComments:
      final.step === "rework"
        ? await reviewCommentsContextOf(pool, final.specId, final.repoId)
        : null,
  };
}

// main into the integration branch: same shape as a ticket merge. The bundle's agent branch is always the
// spec's temp branch (a platform branch, so a worker can take a slot). The first locked merge still
// merge-trees the default branch when that temp does not exist yet. The Run belongs to the spec, not a ticket.
async function buildUpdateBranchBundle(
  pool: pg.Pool,
  job: {
    id: number;
    attempt: number;
    payload: Record<string, unknown>;
  },
  update: UpdateBranchPayload,
): Promise<Bundle | undefined> {
  const found = await pool.query(
    `SELECT s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.integration_branches, s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths,
            p.limits, p.default_model, p.ticket_review, p.stage_models
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
  const failed = await pool.query<{ log: string | null; cases: unknown }>(
    `SELECT output->>'failureLog' AS log, output->'failedCases' AS cases FROM runs
     WHERE spec_id = $1 AND ticket_id IS NULL AND stage = 'update-branch' AND result IN ('conflict', 'gate-failed')
     ORDER BY id DESC LIMIT 1`,
    [update.specId],
  );
  const branches = row.integration_branches as {
    repoId: number;
    branch: string;
  }[];
  return {
    job: {
      id: job.id,
      stage: update.recheck ? "recheck" : "update-branch",
      attempt: job.attempt,
    },
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
    failedCases: failedCasesFrom(failed.rows[0]?.cases),
    review: null,
    gateBaseline: await gateBaselineFor(pool, update.specId, update.repoId),
    gateBaselines: await gateBaselinesFor(pool, update.specId, update.repoId),
    ticketGateNames: null,
    decisionLog: await decisionLogFor(
      pool,
      update.specId,
      formatDisplayId("spec", update.specId),
      null,
      null,
      run.rows[0]?.id ?? null,
    ),
    approvedRemovedTests: (() => {
      const names = testNamesFrom(job.payload.approvedRemoved);
      return names.length > 0 ? names : null;
    })(),
    ...runSettings(
      row.limits,
      row.default_model,
      row.ticket_review,
      row.stage_models,
    ),
    recheck: recheckOf(job.payload),
    uncertainties: null,
    reviewComments: null,
  };
}

// Locate: the bug draft, the workspace repo (planning or first), and every other
// project repo as a default-branch ref. No ticket, no compose, no integration branch.
async function buildLocateBundle(
  pool: pg.Pool,
  job: { id: number; attempt: number },
  locate: LocatePayload,
): Promise<Bundle | undefined> {
  const found = await pool.query(
    `SELECT s.id AS spec_id, s.slug, s.title AS spec_title, s.body AS spec_body, s.type AS spec_type,
            s.branch_namespace, s.planning_sha, s.planning_repo_id,
            r.id AS repo_id, r.name, r.url, r.default_branch,
            pr.name AS planning_repo_name, pr.url AS planning_repo_url,
            pr.default_branch AS planning_default_branch,
            p.protected_paths, p.limits, p.default_model, p.ticket_review, p.stage_models
     FROM specs s JOIN repos r ON r.id = $2 JOIN projects p ON p.id = s.project_id
     LEFT JOIN repos pr ON pr.id = s.planning_repo_id
     WHERE s.id = $1`,
    [locate.specId, locate.repoId],
  );
  const row = found.rows[0];
  if (!row) return undefined;
  const others = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
  }>(
    `SELECT name, url, default_branch FROM repos
     WHERE project_id = $1 AND id <> $2 ORDER BY id`,
    [locate.projectId, locate.repoId],
  );
  const run = await pool.query<{ id: number; retry_note: string | null }>(
    "SELECT id, retry_note FROM runs WHERE job_id = $1",
    [job.id],
  );
  return {
    job: { id: job.id, stage: "locate-bug", attempt: job.attempt },
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
    integrationBranch: null,
    agentBranch: branchNames(row.branch_namespace).locate(
      formatDisplayId("spec", row.spec_id),
    ),
    protectedPaths: row.protected_paths,
    allowedProtectedPaths: [],
    contracts: [],
    refs: others.rows.map((repo) => ({
      name: repo.name,
      url: repo.url,
      defaultBranch: repo.default_branch,
      sha: null,
    })),
    environment: [],
    note: run.rows[0]?.retry_note ?? null,
    failureLog: null,
    failedCases: null,
    review: null,
    gateBaseline: null,
    gateBaselines: [],
    ticketGateNames: null,
    decisionLog: await decisionLogFor(
      pool,
      locate.specId,
      formatDisplayId("spec", locate.specId),
      null,
      null,
      run.rows[0]?.id ?? null,
    ),
    approvedRemovedTests: null,
    ...runSettings(
      row.limits,
      row.default_model,
      row.ticket_review,
      row.stage_models,
    ),
    recheck: null,
    uncertainties: null,
    reviewComments: null,
  };
}
