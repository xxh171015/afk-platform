import {
  AGENT_FAILURES,
  AGENT_STAGES,
  advanceStage,
  type BlockedReason,
  FINDING_RESOLUTIONS,
  type Progress,
  type Stage,
  type StageDecision,
  type StageReport,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { enqueueStageJob } from "../jobs/stage-jobs.ts";
import {
  finishTicket,
  lockSpec,
  schedulePass,
} from "../scheduling/scheduler.ts";

// What a worker hands back when it completes a stage job, and what the API does with it: write the Run,
// GateResult and Findings, ask the shared state machine for the next step, then apply it.

const RunFacts = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  skillsSha: z.string().optional(),
  cursorCliVersion: z.string().optional(),
  branch: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  commits: z.array(z.string()).max(1000).default([]),
  durationMs: z.number().int().min(0).optional(),
  durationApiMs: z.number().int().min(0).optional(),
  tokenUsage: z.unknown().optional(),
  output: z.unknown().optional(),
  logUrl: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});

const GateFacts = z.object({
  commitSha: z.string().min(1),
  configSha: z.string().min(1),
  commandResults: z.array(z.unknown()).default([]),
  testsTotal: z.number().int().min(0).optional(),
  testsSkipped: z.number().int().min(0).optional(),
  logUrl: z.string().optional(),
});

const FindingFacts = z.object({
  kind: z.string().min(1).max(100),
  body: z.string().min(1),
  resolution: z.enum(FINDING_RESOLUTIONS).optional(),
});

const common = {
  run: RunFacts.optional(),
  gate: GateFacts.optional(),
  findings: z.array(FindingFacts).max(200).default([]),
};

export const StageResultSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.enum(AGENT_STAGES),
    outcome: z.enum(["done", ...AGENT_FAILURES]),
    ...common,
  }),
  z.object({
    stage: z.literal("gate"),
    outcome: z.enum(["passed", "failed", "protected-path-changed"]),
    ...common,
  }),
  z.object({
    stage: z.literal("review"),
    outcome: z.enum(["pass", "fix", "invalid-output", "timeout"]),
    ...common,
  }),
  z.object({
    stage: z.literal("merge"),
    outcome: z.enum(["merged", "conflict", "gate-failed"]),
    // the integration branch head after the advance; a contract ticket's contract SHA
    headSha: z.string().min(1).optional(),
    ...common,
  }),
]);
export type StageResult = z.infer<typeof StageResultSchema>;

export interface StageJob {
  id: number;
  payload: Record<string, unknown>;
}

export type RecordResult =
  | { status: "no-ticket" } // a job that is not a ticket stage (finalize, open-pr, ...)
  | { status: "ignored"; reason: string }
  | {
      status: "applied";
      decision: StageDecision | { type: "block"; reason: BlockedReason };
    };

interface TicketRow {
  id: number;
  spec_id: number;
  repo_id: number;
  state: TicketState;
  type: string;
  content_version: number;
  fix_counts: Progress["fixCounts"];
  reviewed: boolean;
}

// The state a ticket is in while each stage's job is out.
const EXPECTED_STATE: Record<Stage, TicketState> = {
  implement: "running",
  gate: "running",
  review: "running",
  "gate-fix": "running",
  "review-fix": "running",
  "merge-fix": "running",
  merge: "merging",
};

const STAGE_VALUES = new Set<string>(Object.keys(EXPECTED_STATE));

export async function recordStageResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<RecordResult> {
  const { ticketId, stage } = job.payload as {
    ticketId?: unknown;
    stage?: unknown;
  };
  if (
    typeof ticketId !== "number" ||
    typeof stage !== "string" ||
    !STAGE_VALUES.has(stage)
  ) {
    return { status: "no-ticket" };
  }
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  if (!found.rows[0]) return { status: "no-ticket" };
  await lockSpec(client, found.rows[0].spec_id);

  const ticket = (
    await client.query<TicketRow>(
      `SELECT id, spec_id, repo_id, state, type, content_version, fix_counts, reviewed
       FROM tickets WHERE id = $1`,
      [ticketId],
    )
  ).rows[0] as TicketRow;
  const expected = EXPECTED_STATE[stage as Stage];
  const contentVersion = (job.payload as { contentVersion?: unknown })
    .contentVersion;
  if (ticket.state !== expected || contentVersion !== ticket.content_version) {
    return {
      status: "ignored",
      reason: `${stage} result for a ticket that is ${ticket.state} at version ${ticket.content_version}`,
    };
  }

  const parsed = StageResultSchema.safeParse(result);
  const valid =
    parsed.success && parsed.data.stage === stage ? parsed.data : undefined;
  await writeFacts(client, ticket, job, stage as Stage, valid, result);

  const progress: Progress = {
    fixCounts: ticket.fix_counts,
    reviewed: ticket.reviewed,
  };
  const decision: StageDecision = valid
    ? advanceStage(valid as StageReport, progress)
    : { type: "block", reason: "invalid-output" };

  await apply(client, ticket, decision, valid);
  return { status: "applied", decision };
}

async function writeFacts(
  client: pg.PoolClient,
  ticket: TicketRow,
  job: StageJob,
  stage: Stage,
  result: StageResult | undefined,
  raw: unknown,
): Promise<void> {
  const run = result?.run;
  const tries = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM runs WHERE ticket_id = $1 AND stage = $2",
    [ticket.id, stage],
  );
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO runs (spec_id, repo_id, ticket_id, ticket_version, job_id, stage, attempt, agent, model, skills_sha,
       cursor_cli_version, branch, base_sha, head_sha, commits, duration_ms, duration_api_ms, token_usage, result,
       output, log_url, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING id`,
    [
      ticket.spec_id,
      ticket.repo_id,
      ticket.id,
      ticket.content_version,
      job.id,
      stage,
      Number(tries.rows[0]?.n) + 1,
      run?.agent ?? null,
      run?.model ?? null,
      run?.skillsSha ?? null,
      run?.cursorCliVersion ?? null,
      run?.branch ?? null,
      run?.baseSha ?? null,
      run?.headSha ?? null,
      run?.commits ?? [],
      run?.durationMs ?? null,
      run?.durationApiMs ?? null,
      run?.tokenUsage === undefined ? null : JSON.stringify(run.tokenUsage),
      result?.outcome ?? "invalid-output",
      // what the agent said; for an unusable result, the raw payload so the problem can be seen
      JSON.stringify(result ? (run?.output ?? null) : (raw ?? null)),
      run?.logUrl ?? null,
      run?.startedAt ?? null,
      run?.finishedAt ?? null,
    ],
  );
  const runId = inserted.rows[0]?.id as number;

  if (result?.gate) {
    const gate = result.gate;
    // The same commit can be gated again (a rerun after a restart): the latest facts win.
    await client.query(
      `INSERT INTO gate_results (repo_id, commit_sha, config_sha, command_results, tests_total, tests_skipped, log_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (repo_id, commit_sha) DO UPDATE SET config_sha = EXCLUDED.config_sha,
         command_results = EXCLUDED.command_results, tests_total = EXCLUDED.tests_total,
         tests_skipped = EXCLUDED.tests_skipped, log_url = EXCLUDED.log_url`,
      [
        ticket.repo_id,
        gate.commitSha,
        gate.configSha,
        JSON.stringify(gate.commandResults),
        gate.testsTotal ?? null,
        gate.testsSkipped ?? null,
        gate.logUrl ?? null,
      ],
    );
  }
  for (const finding of result?.findings ?? []) {
    // A review's suggestions do not trigger a fix; they travel to the acceptance pack.
    const resolution =
      finding.resolution ??
      (finding.kind === "suggestion" ? "acceptance-pack" : "unhandled");
    await client.query(
      "INSERT INTO findings (run_id, kind, body, resolution) VALUES ($1, $2, $3, $4)",
      [runId, finding.kind, finding.body, resolution],
    );
  }
}

async function apply(
  client: pg.PoolClient,
  ticket: TicketRow,
  decision: StageDecision,
  result: StageResult | undefined,
): Promise<void> {
  if (decision.type === "done") {
    const sha = result?.stage === "merge" ? result.headSha : undefined;
    const finished = await finishTicket(client, ticket.id, sha);
    if (finished.status === "missing-contract-sha") {
      // A contract ticket merged without saying where the integration branch is now: nothing downstream
      // could use it, so the result counts as unusable.
      await block(client, ticket, "invalid-output");
    } else if (finished.status !== "ok") {
      throw new Error(`cannot finish ticket ${ticket.id}: ${finished.status}`);
    }
    return;
  }
  if (decision.type === "block") {
    await block(client, ticket, decision.reason);
    return;
  }
  let state = ticket.state;
  if (decision.event) {
    const next = ticketTransition(state, decision.event);
    if (!next.ok || next.state === "blocked")
      throw new Error(next.ok ? "unexpected block" : next.reason);
    state = next.state;
  }
  await client.query(
    "UPDATE tickets SET state = $2, fix_counts = $3, reviewed = $4 WHERE id = $1",
    [
      ticket.id,
      state,
      JSON.stringify(decision.progress.fixCounts),
      decision.progress.reviewed,
    ],
  );
  await enqueueStageJob(
    client,
    {
      id: ticket.id,
      specId: ticket.spec_id,
      repoId: ticket.repo_id,
      contentVersion: ticket.content_version,
    },
    decision.stage,
  );
}

async function block(
  client: pg.PoolClient,
  ticket: TicketRow,
  reason: BlockedReason,
): Promise<void> {
  const next = ticketTransition(ticket.state, { type: "block", reason });
  if (!next.ok || next.state !== "blocked") {
    throw new Error(next.ok ? "unexpected state" : next.reason);
  }
  await client.query(
    "UPDATE tickets SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [ticket.id, reason],
  );
  // A blocked ticket no longer holds an agent run, so another one may start.
  await schedulePass(client, ticket.spec_id);
}

// A worker claiming a ticket's implement job moves the ticket from queued to running.
export async function markClaimed(pool: pg.Pool, job: StageJob): Promise<void> {
  const { ticketId, stage } = job.payload as {
    ticketId?: unknown;
    stage?: unknown;
  };
  if (typeof ticketId !== "number" || stage !== "implement") return;
  const next = ticketTransition("queued", { type: "claim" });
  if (!next.ok || next.state === "blocked") return;
  await pool.query(
    "UPDATE tickets SET state = $2 WHERE id = $1 AND state = 'queued'",
    [ticketId, next.state],
  );
}
