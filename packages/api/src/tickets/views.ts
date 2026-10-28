import { formatDisplayId, type SpecState, type TicketState } from "@afk/shared";
import type pg from "pg";

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
  brief: Brief | null;
}

async function summaries(
  pool: pg.Pool,
  where: string,
  params: unknown[],
): Promise<TicketSummary[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.spec_id, t.title, t.type, t.state, t.blocked_reason, r.role
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
      repo: row.role as string,
      // an upstream cancel is not the fault of any run, so there is no brief to show
      brief:
        row.state === "blocked" && row.blocked_reason !== "upstream-cancelled"
          ? await briefFor(pool, row.id)
          : null,
    })),
  );
}

export async function ticketView(pool: pg.Pool, ticketId: number) {
  const [summary] = await summaries(pool, "t.id = $1", [ticketId]);
  if (!summary) return undefined;
  const detail = await pool.query(
    `SELECT body, acceptance_criteria, modules, allowed_protected_paths, content_version, contract_sha, fix_counts, reviewed
     FROM tickets WHERE id = $1`,
    [ticketId],
  );
  const d = detail.rows[0];
  const edges = await pool.query(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind, u.state AS from_state, v.state AS to_state
     FROM edges e JOIN tickets u ON u.id = e.from_ticket_id JOIN tickets v ON v.id = e.to_ticket_id
     WHERE e.from_ticket_id = $1 OR e.to_ticket_id = $1 ORDER BY e.id`,
    [ticketId],
  );
  const runs = await pool.query(
    `SELECT id, stage, attempt, result, duration_ms, started_at, finished_at, head_sha FROM runs
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
      body: d.body as string,
      acceptanceCriteria: d.acceptance_criteria as string[],
      modules: d.modules as string[],
      allowedProtectedPaths: d.allowed_protected_paths as string[],
      contentVersion: d.content_version as number,
      contractSha: (d.contract_sha as string | null) ?? null,
      fixCounts: d.fix_counts as Record<string, number>,
      reviewed: d.reviewed as boolean,
    },
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
    edges: edges.rows.map((e) => ({
      from: formatDisplayId("ticket", e.from_ticket_id),
      to: formatDisplayId("ticket", e.to_ticket_id),
      kind: e.kind as string,
    })),
  };
}

// Everything waiting for a person: tickets that are blocked and specs that the platform paused.
export async function blockedQueue(pool: pg.Pool) {
  const tickets = await summaries(pool, "t.state = 'blocked'", []);
  const specs = await pool.query(
    "SELECT id, title, pause_reason FROM specs WHERE state = 'paused' ORDER BY id",
  );
  return {
    tickets,
    specs: specs.rows.map((s) => ({
      id: s.id as number,
      displayId: formatDisplayId("spec", s.id),
      title: s.title as string,
      reason: (s.pause_reason as string | null) ?? "paused",
    })),
  };
}
