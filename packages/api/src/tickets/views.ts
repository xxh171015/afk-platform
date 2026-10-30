import { formatDisplayId, type SpecState, type TicketState } from "@afk/shared";
import type pg from "pg";
import { pullRequestRows, readAcceptancePack } from "../acceptance/pack.ts";
import { mergeOrderOf } from "../host/merge-order.ts";
import { FOLLOWED_PULL_REQUESTS } from "../host/pull-requests.ts";

// What a person looks at: one ticket, one spec, and the queue of things waiting for a decision. The "brief" of
// a blocked ticket is the Run that went wrong: which stage, how it ended, and what the agent or the gate said
// (docs/design.md「blocked 处理」: 失败步骤、相关日志指针、agent 的结构化输出).

export interface Brief {
  run: { id: number; displayId: string };
  stage: string;
  result: string | null;
  output: unknown; // the structured output of the agent, or the gate's failure log and reasons
  logPath: string; // GET this to read the run's log
}

const GOOD_RESULTS = ["done", "passed", "pass", "merged"];

async function briefFor(
  pool: pg.Pool,
  ticketId: number,
): Promise<Brief | null> {
  const { rows } = await pool.query(
    `SELECT id, stage, result, output FROM runs
     WHERE ticket_id = $1 AND result IS NOT NULL AND NOT (result = ANY($2))
     ORDER BY id DESC LIMIT 1`,
    [ticketId, GOOD_RESULTS],
  );
  const run = rows[0];
  if (!run) return null;
  return {
    run: { id: run.id, displayId: formatDisplayId("run", run.id) },
    stage: run.stage,
    result: run.result,
    output: run.output,
    logPath: `/runs/${run.id}/logs`,
  };
}

// The Run of a finalization step that went wrong, as a brief.
async function finalBrief(
  pool: pg.Pool,
  specId: number,
): Promise<Brief | null> {
  const { rows } = await pool.query(
    `SELECT id, stage, result, output FROM runs
     WHERE spec_id = $1 AND ticket_id IS NULL AND result IS NOT NULL AND NOT (result = ANY($2))
     ORDER BY id DESC LIMIT 1`,
    [specId, GOOD_RESULTS],
  );
  const run = rows[0];
  if (!run) return null;
  return {
    run: { id: run.id, displayId: formatDisplayId("run", run.id) },
    stage: run.stage,
    result: run.result,
    output: run.output,
    logPath: `/runs/${run.id}/logs`,
  };
}

export interface FinalizationSummary {
  specId: number;
  specDisplayId: string;
  repo: string;
  step: string;
  state: string;
  blockedReason: string | null;
  brief: Brief | null;
}

async function finalizations(
  pool: pg.Pool,
  where: string,
  params: unknown[],
): Promise<FinalizationSummary[]> {
  const { rows } = await pool.query(
    // A review that was not finished when its spec was cancelled is cancelled with it, whatever it was waiting for.
    `SELECT f.spec_id, f.step, r.name AS repo,
            CASE WHEN f.state <> 'done' AND s.state = 'cancelled' THEN 'cancelled' ELSE f.state END AS state,
            CASE WHEN s.state = 'cancelled' THEN NULL ELSE f.blocked_reason END AS blocked_reason
     FROM finalizations f JOIN repos r ON r.id = f.repo_id JOIN specs s ON s.id = f.spec_id
     WHERE ${where} ORDER BY f.id`,
    params,
  );
  return Promise.all(
    rows.map(async (row) => ({
      specId: row.spec_id as number,
      specDisplayId: formatDisplayId("spec", row.spec_id),
      repo: row.repo as string,
      step: row.step as string,
      state: row.state as string,
      blockedReason: (row.blocked_reason as string | null) ?? null,
      brief:
        row.state === "blocked" ? await finalBrief(pool, row.spec_id) : null,
    })),
  );
}

export interface TicketSummary {
  id: number;
  displayId: string;
  specId: number;
  specDisplayId: string;
  title: string;
  type: string;
  state: TicketState;
  blockedReason: string | null;
  repo: string;
  refs: string[];
  environment: string[];
  appended: boolean;
  brief: Brief | null;
}

async function summaries(
  pool: pg.Pool,
  where: string,
  params: unknown[],
): Promise<TicketSummary[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.spec_id, t.title, t.type, t.state, t.blocked_reason, t.refs, t.environment, t.appended, r.name AS repo
     FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE ${where} ORDER BY t.id`,
    params,
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id as number,
      displayId: formatDisplayId("ticket", row.id),
      specId: row.spec_id as number,
      specDisplayId: formatDisplayId("spec", row.spec_id),
      title: row.title as string,
      type: row.type as string,
      state: row.state as TicketState,
      blockedReason: (row.blocked_reason as string | null) ?? null,
      repo: row.repo as string,
      refs: row.refs as string[],
      environment: row.environment as string[],
      appended: row.appended as boolean,
      // an upstream cancel is not the fault of any run, so there is no brief to show
      brief:
        row.state === "blocked" && row.blocked_reason !== "upstream-cancelled"
          ? await briefFor(pool, row.id)
          : null,
    })),
  );
}

// With `version`, the content (title, body, acceptance criteria, modules, approved protected paths) is the one the
// ticket had at that version; without it, the current one. Undefined when there is no such ticket or version.
export async function ticketView(
  pool: pg.Pool,
  ticketId: number,
  version?: number,
) {
  const [summary] = await summaries(pool, "t.id = $1", [ticketId]);
  if (!summary) return undefined;
  const detail = await pool.query(
    `SELECT body, acceptance_criteria, modules, allowed_protected_paths, content_version, contract_sha, fix_counts, reviewed
     FROM tickets WHERE id = $1`,
    [ticketId],
  );
  const d = detail.rows[0];
  const versions = await pool.query<{ version: number; created_at: Date }>(
    "SELECT version, created_at FROM ticket_versions WHERE ticket_id = $1 ORDER BY version",
    [ticketId],
  );
  let content = {
    title: summary.title,
    body: d.body as string,
    acceptanceCriteria: d.acceptance_criteria as string[],
    modules: d.modules as string[],
    allowedProtectedPaths: d.allowed_protected_paths as string[],
    contentVersion: d.content_version as number,
  };
  if (version !== undefined && version !== content.contentVersion) {
    const old = await pool.query(
      `SELECT title, body, acceptance_criteria, modules, allowed_protected_paths
       FROM ticket_versions WHERE ticket_id = $1 AND version = $2`,
      [ticketId, version],
    );
    const found = old.rows[0];
    if (!found) return undefined;
    content = {
      title: found.title,
      body: found.body,
      acceptanceCriteria: found.acceptance_criteria,
      modules: found.modules,
      allowedProtectedPaths: found.allowed_protected_paths,
      contentVersion: version,
    };
  }
  const edges = await pool.query(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind, u.state AS from_state, v.state AS to_state
     FROM edges e JOIN tickets u ON u.id = e.from_ticket_id JOIN tickets v ON v.id = e.to_ticket_id
     WHERE e.from_ticket_id = $1 OR e.to_ticket_id = $1 ORDER BY e.id`,
    [ticketId],
  );
  const runs = await pool.query(
    `SELECT id, stage, attempt, result, duration_ms, started_at, finished_at, head_sha, agent, model, skills_sha, cursor_cli_version, contract_shas, ref_shas FROM runs
     WHERE ticket_id = $1 ORDER BY id`,
    [ticketId],
  );
  const findings = await pool.query(
    `SELECT f.id, f.run_id, f.kind, f.body, f.resolution FROM findings f JOIN runs r ON r.id = f.run_id
     WHERE r.ticket_id = $1 ORDER BY f.id`,
    [ticketId],
  );
  const shas = runs.rows.map((r) => r.head_sha).filter(Boolean);
  const gates = shas.length
    ? await pool.query(
        `SELECT commit_sha, config_sha, command_results, tests_total, tests_skipped FROM gate_results
         WHERE repo_id = (SELECT repo_id FROM tickets WHERE id = $1) AND commit_sha = ANY($2) ORDER BY id`,
        [ticketId, shas],
      )
    : { rows: [] };
  return {
    ticket: {
      ...summary,
      ...content,
      contractSha: (d.contract_sha as string | null) ?? null,
      fixCounts: d.fix_counts as Record<string, number>,
      reviewed: d.reviewed as boolean,
    },
    versions: versions.rows.map((v) => ({
      version: v.version,
      createdAt: v.created_at.toISOString(),
    })),
    upstream: edges.rows
      .filter((e) => e.to_ticket_id === ticketId)
      .map((e) => ({
        id: e.from_ticket_id as number,
        displayId: formatDisplayId("ticket", e.from_ticket_id),
        kind: e.kind as string,
        state: e.from_state as TicketState,
      })),
    downstream: edges.rows
      .filter((e) => e.from_ticket_id === ticketId)
      .map((e) => ({
        id: e.to_ticket_id as number,
        displayId: formatDisplayId("ticket", e.to_ticket_id),
        kind: e.kind as string,
        state: e.to_state as TicketState,
      })),
    runs: runs.rows.map((r) => ({
      id: r.id as number,
      displayId: formatDisplayId("run", r.id),
      stage: r.stage as string,
      attempt: r.attempt as number,
      result: (r.result as string | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      skillsSha: (r.skills_sha as string | null) ?? null,
      cursorCliVersion: (r.cursor_cli_version as string | null) ?? null,
      contractShas: (r.contract_shas as Record<string, string> | null) ?? null,
      refShas: (r.ref_shas as Record<string, string> | null) ?? null,
      startedAt: r.started_at ? (r.started_at as Date).toISOString() : null,
      finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    })),
    findings: findings.rows.map((f) => ({
      id: f.id as number,
      runId: f.run_id as number,
      kind: f.kind as string,
      body: f.body as string,
      resolution: f.resolution as string,
    })),
    gateResults: gates.rows.map((g) => ({
      commitSha: g.commit_sha as string,
      configSha: g.config_sha as string,
      commandResults: g.command_results as unknown[],
      testsTotal: (g.tests_total as number | null) ?? null,
      testsSkipped: (g.tests_skipped as number | null) ?? null,
    })),
  };
}

export async function specView(pool: pg.Pool, specId: number) {
  const spec = await pool.query(
    `SELECT id, slug, title, type, state, pause_reason, integration_branches, import_warnings, body FROM specs WHERE id = $1`,
    [specId],
  );
  const row = spec.rows[0];
  if (!row) return undefined;
  const tickets = await summaries(pool, "t.spec_id = $1", [specId]);
  const edges = await pool.query(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind FROM edges e JOIN tickets t ON t.id = e.to_ticket_id
     WHERE t.spec_id = $1 ORDER BY e.id`,
    [specId],
  );
  return {
    spec: {
      id: row.id as number,
      displayId: formatDisplayId("spec", row.id),
      slug: row.slug as string,
      title: row.title as string,
      type: row.type as string,
      body: row.body as string,
      state: row.state as SpecState,
      pauseReason: (row.pause_reason as string | null) ?? null,
      integrationBranches: row.integration_branches as {
        repoId: number;
        branch: string;
      }[],
      warnings: row.import_warnings as unknown[],
    },
    tickets,
    finalizations: await finalizations(pool, "f.spec_id = $1", [specId]),
    mergeOrder: await mergeOrderOf(pool, specId),
    pullRequests: await pullRequestRows(pool, specId),
    acceptancePack: await readAcceptancePack(pool, specId),
    edges: edges.rows.map((e) => ({
      from: formatDisplayId("ticket", e.from_ticket_id),
      to: formatDisplayId("ticket", e.to_ticket_id),
      kind: e.kind as string,
    })),
  };
}

export interface Progress {
  total: number;
  done: number;
  active: number; // queued, running or merging
  blocked: number;
  pending: number;
  cancelled: number;
}

// Every spec with how far its tickets have got, newest first: the front page.
export async function specList(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.title, s.type, s.state, s.pause_reason, p.name AS project,
            count(t.id) AS total,
            count(t.id) FILTER (WHERE t.state = 'done') AS done,
            count(t.id) FILTER (WHERE t.state IN ('queued', 'running', 'merging')) AS active,
            count(t.id) FILTER (WHERE t.state = 'blocked') AS blocked,
            count(t.id) FILTER (WHERE t.state = 'pending') AS pending,
            count(t.id) FILTER (WHERE t.state = 'cancelled') AS cancelled
     FROM specs s JOIN projects p ON p.id = s.project_id LEFT JOIN tickets t ON t.spec_id = s.id
     GROUP BY s.id, p.name ORDER BY s.id DESC`,
  );
  return rows.map((row) => ({
    id: row.id as number,
    displayId: formatDisplayId("spec", row.id),
    slug: row.slug as string,
    title: row.title as string,
    type: row.type as string,
    state: row.state as SpecState,
    pauseReason: (row.pause_reason as string | null) ?? null,
    project: row.project as string,
    progress: {
      total: Number(row.total),
      done: Number(row.done),
      active: Number(row.active),
      blocked: Number(row.blocked),
      pending: Number(row.pending),
      cancelled: Number(row.cancelled),
    } satisfies Progress,
  }));
}

const SEARCH_LIMIT = 50;

// `%` and `_` in what a person typed are text to look for, not wildcards.
const escapeLike = (text: string) =>
  text.replace(/[\\%_]/g, (char) => `\\${char}`);

export type MatchedIn = "id" | "title" | "body";

// Case-insensitive substring search over spec and ticket numbers (S-12, T-5), titles and bodies: ILIKE, no search
// engine. Results are grouped by kind, newest first, and say where the text was found.
export async function search(pool: pg.Pool, text: string) {
  const pattern = `%${escapeLike(text)}%`;
  const specs = await pool.query(
    `SELECT id, title, state,
            ('S-' || id) ILIKE $1 AS in_id, title ILIKE $1 AS in_title, body ILIKE $1 AS in_body
     FROM specs WHERE ('S-' || id) ILIKE $1 OR title ILIKE $1 OR body ILIKE $1
     ORDER BY id DESC LIMIT $2`,
    [pattern, SEARCH_LIMIT],
  );
  const tickets = await pool.query(
    `SELECT t.id, t.title, t.state, t.spec_id,
            ('T-' || t.id) ILIKE $1 AS in_id, t.title ILIKE $1 AS in_title, t.body ILIKE $1 AS in_body
     FROM tickets t WHERE ('T-' || t.id) ILIKE $1 OR t.title ILIKE $1 OR t.body ILIKE $1
     ORDER BY t.id DESC LIMIT $2`,
    [pattern, SEARCH_LIMIT],
  );
  const where = (row: {
    in_id: boolean;
    in_title: boolean;
    in_body: boolean;
  }): MatchedIn[] => [
    ...(row.in_id ? (["id"] as const) : []),
    ...(row.in_title ? (["title"] as const) : []),
    ...(row.in_body ? (["body"] as const) : []),
  ];
  return {
    specs: specs.rows.map((row) => ({
      id: row.id as number,
      displayId: formatDisplayId("spec", row.id),
      title: row.title as string,
      state: row.state as SpecState,
      matched: where(row),
    })),
    tickets: tickets.rows.map((row) => ({
      id: row.id as number,
      displayId: formatDisplayId("ticket", row.id),
      title: row.title as string,
      state: row.state as TicketState,
      specId: row.spec_id as number,
      specDisplayId: formatDisplayId("spec", row.spec_id),
      matched: where(row),
    })),
  };
}

export interface PullRequestProblem {
  specId: number;
  specDisplayId: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  syncError: string | null;
}

// A pull request the platform cannot move on from by itself: closed without merge, or one the host keeps
// refusing to answer for. Nothing is done about it; a person decides (reopen it, rework, cancel the spec).
async function pullRequestProblems(
  pool: pg.Pool,
): Promise<PullRequestProblem[]> {
  const { rows } = await pool.query(
    `SELECT p.spec_id, r.name AS repo, p.number, p.url, p.state, p.sync_error
     FROM pull_requests p JOIN repos r ON r.id = p.repo_id JOIN specs s ON s.id = p.spec_id
     WHERE ${FOLLOWED_PULL_REQUESTS} AND (p.state = 'closed' OR p.sync_error IS NOT NULL)
     ORDER BY p.id`,
  );
  return rows.map((row) => ({
    specId: row.spec_id as number,
    specDisplayId: formatDisplayId("spec", row.spec_id),
    repo: row.repo as string,
    number: row.number as number,
    url: row.url as string,
    state: row.state as string,
    syncError: (row.sync_error as string | null) ?? null,
  }));
}

// A cancelled or merged spec whose cleanup failed every time it was tried: branches or pull requests may be left on
// the code host. A failure only counts when no cleanup of that spec that is queued, running or done came after it.
async function cleanupProblems(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (spec_id) spec_id, error FROM (
       SELECT (payload->>'specId')::int AS spec_id, error, state, id FROM jobs WHERE type = 'spec-cleanup'
     ) j
     WHERE state = 'failed' AND NOT EXISTS (
       SELECT 1 FROM jobs k WHERE k.type = 'spec-cleanup' AND (k.payload->>'specId')::int = j.spec_id
         AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))
     ORDER BY spec_id, id DESC`,
  );
  return rows.map((row) => ({
    specId: row.spec_id as number,
    specDisplayId: formatDisplayId("spec", row.spec_id),
    error: (row.error as string | null) ?? "",
  }));
}

// A draft pull request that could not be turned ready, three times over: it stays a draft until a person turns it
// ready on the host (a look at the host sees that). A failure only counts while the pull request is still a draft
// and no later pr-ready of it is queued, running or done.
async function readyFailures(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (p.id) p.spec_id, r.name AS repo, p.number, p.url, j.error
     FROM jobs j
     JOIN pull_requests p ON p.id = (j.payload->>'pullId')::int
     JOIN repos r ON r.id = p.repo_id JOIN specs s ON s.id = p.spec_id
     WHERE j.type = 'pr-ready' AND j.state = 'failed' AND p.draft AND ${FOLLOWED_PULL_REQUESTS}
       AND NOT EXISTS (
         SELECT 1 FROM jobs k WHERE k.type = 'pr-ready' AND (k.payload->>'pullId')::int = p.id
           AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))
     ORDER BY p.id, j.id DESC`,
  );
  return rows.map((row) => ({
    specId: row.spec_id as number,
    specDisplayId: formatDisplayId("spec", row.spec_id),
    repo: row.repo as string,
    number: row.number as number,
    url: row.url as string,
    error: (row.error as string | null) ?? "",
  }));
}

// Everything waiting for a person: tickets that are blocked, blocked steps of an overall review, pull requests that
// were closed or cannot be read, and specs that the platform paused. A cancelled spec waits for no one.
export async function blockedQueue(pool: pg.Pool) {
  const tickets = await summaries(pool, "t.state = 'blocked'", []);
  const specs = await pool.query(
    "SELECT id, title, pause_reason FROM specs WHERE state = 'paused' ORDER BY id",
  );
  return {
    tickets,
    finalizations: await finalizations(
      pool,
      "f.state = 'blocked' AND f.spec_id NOT IN (SELECT id FROM specs WHERE state = 'cancelled')",
      [],
    ),
    pullRequests: await pullRequestProblems(pool),
    cleanups: await cleanupProblems(pool),
    readyFailures: await readyFailures(pool),
    specs: specs.rows.map((s) => ({
      id: s.id as number,
      displayId: formatDisplayId("spec", s.id),
      title: s.title as string,
      reason: (s.pause_reason as string | null) ?? "paused",
    })),
  };
}
