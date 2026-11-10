import {
  AGENT_FAILURES,
  AGENT_STAGES,
  advanceStage,
  type BlockedReason,
  FINDING_RESOLUTIONS,
  type Progress,
  REVIEW_AXES,
  type Stage,
  type StageDecision,
  type StageReport,
  type TicketEvent,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { enqueueTrialMerge } from "../host/trial-merge.ts";
import { enqueueStageJob, readStagePayload } from "../jobs/stage-jobs.ts";
import {
  finishTicket,
  lockSpec,
  schedulePass,
} from "../scheduling/scheduler.ts";
import { contractsOf } from "./contracts.ts";
import { createFixTicket } from "./integration.ts";

// What a worker hands back when it completes a stage job, and what the API does with it: write the Run,
// GateResult and Findings, ask the shared state machine for the next step, then apply it.

const RunFacts = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  skillsSha: z.string().optional(),
  // which axis of a review this Run is (standards | spec)
  axis: z.enum(REVIEW_AXES).optional(),
  // the whole prompt the agent was given
  prompt: z.string().optional(),
  // what this Run itself came to, when that is not the stage's outcome (one axis of a review)
  result: z.string().optional(),
  cursorCliVersion: z.string().optional(),
  branch: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  commits: z.array(z.string()).max(1000).default([]),
  durationMs: z.number().int().min(0).optional(),
  durationApiMs: z.number().int().min(0).optional(),
  tokenUsage: z.unknown().optional(),
  output: z.unknown().optional(),
  refShas: z.record(z.string(), z.string()).optional(),
  // an e2e's JUnit counts and how long the environment took to come up
  testsTotal: z.number().int().min(0).optional(),
  testsFailed: z.number().int().min(0).optional(),
  envUpMs: z.number().int().min(0).optional(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});

const GateFacts = z.object({
  // an e2e is kept apart from the unit gate of the same commit
  kind: z.enum(["gate", "e2e"]).default("gate"),
  commitSha: z.string().min(1),
  configSha: z.string().min(1),
  commandResults: z.array(z.unknown()).default([]),
  testsTotal: z.number().int().min(0).optional(),
  testsSkipped: z.number().int().min(0).optional(),
  testCases: z
    .array(
      z.object({
        name: z.string(),
        classname: z.string(),
        status: z.enum(["passed", "failed", "skipped"]),
      }),
    )
    .max(20_000)
    .optional(),
});

const FindingFacts = z.object({
  kind: z.string().min(1).max(100),
  body: z.string().min(1),
  resolution: z.enum(FINDING_RESOLUTIONS).optional(),
});

export const commonFields = {
  run: RunFacts.optional(),
  gate: GateFacts.optional(),
  findings: z.array(FindingFacts).max(200).default([]),
  // A review is one Run per axis. `run` is the job's own; the others are recorded beside it, each with its findings.
  extraRuns: z
    .array(
      z.object({
        run: RunFacts,
        findings: z.array(FindingFacts).max(200).default([]),
      }),
    )
    .max(8)
    .default([]),
};

export const StageResultSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.enum(AGENT_STAGES),
    outcome: z.enum(["done", ...AGENT_FAILURES]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("gate"),
    outcome: z.enum([
      "passed",
      "failed",
      "protected-path-changed",
      "contract-copy-mismatch",
    ]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("review"),
    outcome: z.enum(["pass", "fix", "invalid-output", "timeout"]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("merge"),
    outcome: z.enum(["merged", "conflict", "gate-failed"]),
    // the integration branch head after the advance; a contract ticket's contract SHA
    headSha: z.string().min(1).optional(),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("e2e"),
    outcome: z.enum(["passed", "failed"]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("diagnose"),
    outcome: z.enum(["diagnosed", "unknown-side", "invalid-output", "timeout"]),
    // what a "diagnosed" outcome is made of: the repo at fault, with the evidence and the failing tests
    diagnosis: z
      .object({
        failingRepo: z.string().min(1),
        evidence: z.string(),
        failingTests: z.array(z.string()).max(1000).default([]),
      })
      .optional(),
    ...commonFields,
  }),
]);
export type StageResult = z.infer<typeof StageResultSchema>;

export interface StageJob {
  id: number;
  type?: string;
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
  integration_rounds: number;
  title: string;
  acceptance_criteria: string[];
  repo_name: string;
  environment: string[];
}

// The state a ticket is in while each stage's job is out.
export const EXPECTED_STATE: Record<Stage, TicketState> = {
  implement: "running",
  gate: "running",
  review: "running",
  "gate-fix": "running",
  "review-fix": "running",
  "merge-fix": "running",
  merge: "merging",
  e2e: "merging", // the ticket is merged and stays merging until its e2e has passed
  diagnose: "merging",
};

// The event that takes a queued ticket into its stage: an e2e is the run of a ticket that is merged already.
const claimEventOf = (stage: Stage): TicketEvent =>
  stage === "e2e" ? { type: "resume-e2e" } : { type: "claim" };

// A diagnosis that names a repo must say which, and it must be the ticket's own repo or one of its environment:
// anything else is not usable, like any other output that does not fit.
function checkedDiagnosis(result: StageResult, ticket: TicketRow): StageReport {
  if (result.stage !== "diagnose" || result.outcome !== "diagnosed")
    return result as StageReport;
  const repo = result.diagnosis?.failingRepo;
  const known =
    repo === ticket.repo_name || ticket.environment.includes(repo ?? "");
  return known ? result : { stage: "diagnose", outcome: "invalid-output" };
}

export async function recordStageResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<RecordResult> {
  const read = readStagePayload(job.payload);
  if (!read) return { status: "no-ticket" };
  const { ticketId, stage } = read;
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  if (!found.rows[0]) return { status: "no-ticket" };
  await lockSpec(client, found.rows[0].spec_id);

  const ticket = (
    await client.query<TicketRow>(
      `SELECT t.id, t.spec_id, t.repo_id, t.state, t.type, t.content_version, t.fix_counts, t.reviewed,
              t.integration_rounds, t.title, t.acceptance_criteria, t.environment, r.name AS repo_name
       FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE t.id = $1`,
      [ticketId],
    )
  ).rows[0] as TicketRow;
  // A worker that claimed the implement job may reach us before the claim marked the ticket running.
  const expected = EXPECTED_STATE[stage];
  const stateFits =
    ticket.state === expected ||
    ((stage === "implement" || stage === "e2e") && ticket.state === "queued");
  if (!stateFits || read.contentVersion !== ticket.content_version) {
    return {
      status: "ignored",
      reason: `${stage} result for a ticket that is ${ticket.state} at version ${ticket.content_version}`,
    };
  }

  const parsed = StageResultSchema.safeParse(result);
  const valid =
    parsed.success && parsed.data.stage === stage ? parsed.data : undefined;
  await writeFacts(
    client,
    {
      spec_id: ticket.spec_id,
      repo_id: ticket.repo_id,
      ticket_id: ticket.id,
      content_version: ticket.content_version,
    },
    job,
    stage,
    valid,
    result,
  );
  // The restart (if one was asked for) has been carried out by this implement run, whatever came of it.
  if (stage === "implement")
    await client.query("UPDATE tickets SET restart = false WHERE id = $1", [
      ticket.id,
    ]);

  if (ticket.state === "queued") {
    // a ticket that is queued for its e2e is merged already
    const claimed = ticketTransition("queued", claimEventOf(stage));
    if (!claimed.ok || claimed.state === "blocked")
      throw new Error("unexpected claim");
    await client.query("UPDATE tickets SET state = $2 WHERE id = $1", [
      ticket.id,
      claimed.state,
    ]);
    ticket.state = claimed.state;
  }

  const progress: Progress = {
    fixCounts: ticket.fix_counts,
    reviewed: ticket.reviewed,
    integrationRounds: ticket.integration_rounds,
  };
  const decision: StageDecision = valid
    ? advanceStage(checkedDiagnosis(valid, ticket), progress, ticket.type)
    : { type: "block", reason: "invalid-output" };

  await applyDecision(client, ticket, decision, valid);
  return { status: "applied", decision };
}

// Who a Run belongs to: a ticket's stage, or (ticket_id null) a stage of the spec's finalization.
export interface RunOwner {
  spec_id: number;
  repo_id: number;
  ticket_id: number | null;
  content_version: number | null;
}

export type ResultFacts = Pick<
  StageResult,
  "outcome" | "run" | "gate" | "findings" | "extraRuns"
>;

export async function writeFacts(
  client: pg.PoolClient,
  owner: RunOwner,
  job: StageJob,
  stage: string,
  result: ResultFacts | undefined,
  raw: unknown,
): Promise<void> {
  const run = result?.run;
  const tries = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM runs WHERE spec_id = $1 AND ticket_id IS NOT DISTINCT FROM $2 AND stage = $3 AND axis IS NOT DISTINCT FROM $4",
    [owner.spec_id, owner.ticket_id, stage, run?.axis ?? null],
  );
  const facts = [
    run?.agent ?? null,
    run?.model ?? null,
    run?.skillsSha ?? null,
    run?.axis ?? null,
    run?.prompt ?? null,
    run?.cursorCliVersion ?? null,
    run?.branch ?? null,
    run?.baseSha ?? null,
    run?.headSha ?? null,
    run?.commits ?? [],
    run?.durationMs ?? null,
    run?.durationApiMs ?? null,
    run?.tokenUsage === undefined ? null : JSON.stringify(run.tokenUsage),
    run?.result ?? result?.outcome ?? "invalid-output",
    // what the agent said; for an unusable result, the raw payload so the problem can be seen
    JSON.stringify(result ? (run?.output ?? null) : (raw ?? null)),
    run?.startedAt ?? null,
    run?.finishedAt ?? null,
  ];
  // The Run was started when the job was claimed: fill it in. (An UPDATE first, because an INSERT that runs
  // into the unique job id still uses up a serial number, and display ids should not have holes.)
  let inserted = await client.query<{ id: number }>(
    `UPDATE runs SET agent = $2, model = $3, skills_sha = $4, axis = $5, prompt = $6, cursor_cli_version = $7,
       branch = $8, base_sha = $9, head_sha = $10, commits = $11, duration_ms = $12, duration_api_ms = $13,
       token_usage = $14, result = $15, output = $16, started_at = COALESCE($17, started_at),
       finished_at = COALESCE($18, now())
     WHERE job_id = $1 RETURNING id`,
    [job.id, ...facts],
  );
  if (!inserted.rows[0]) {
    inserted = await client.query<{ id: number }>(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, ticket_version, job_id, stage, attempt, agent, model, skills_sha,
         axis, prompt, cursor_cli_version, branch, base_sha, head_sha, commits, duration_ms, duration_api_ms,
         token_usage, result, output, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, COALESCE($24, now()))
       RETURNING id`,
      [
        owner.spec_id,
        owner.repo_id,
        owner.ticket_id,
        owner.content_version,
        job.id,
        stage,
        Number(tries.rows[0]?.n) + 1,
        ...facts,
      ],
    );
  }
  const runId = inserted.rows[0]?.id as number;
  if (run?.testsTotal !== undefined || run?.envUpMs !== undefined) {
    await client.query(
      "UPDATE runs SET tests_total = $2, tests_failed = $3, env_up_ms = $4 WHERE id = $1",
      [
        runId,
        run.testsTotal ?? null,
        run.testsFailed ?? null,
        run.envUpMs ?? null,
      ],
    );
  }
  if (run?.refShas) {
    await client.query("UPDATE runs SET ref_shas = $2 WHERE id = $1", [
      runId,
      JSON.stringify(run.refShas),
    ]);
  }

  if (result?.gate) {
    const gate = result.gate;
    // The same commit can be gated again (a rerun after a restart): the latest facts win.
    await client.query(
      `INSERT INTO gate_results (repo_id, commit_sha, config_sha, command_results, tests_total, tests_skipped, test_cases, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (repo_id, commit_sha, kind) DO UPDATE SET config_sha = EXCLUDED.config_sha,
         command_results = EXCLUDED.command_results, tests_total = EXCLUDED.tests_total,
         tests_skipped = EXCLUDED.tests_skipped, test_cases = EXCLUDED.test_cases`,
      [
        owner.repo_id,
        gate.commitSha,
        gate.configSha,
        JSON.stringify(gate.commandResults),
        gate.testsTotal ?? null,
        gate.testsSkipped ?? null,
        gate.testCases === undefined ? null : JSON.stringify(gate.testCases),
        gate.kind,
      ],
    );
  }
  if (
    owner.ticket_id !== null &&
    stage === "review-fix" &&
    result?.outcome === "done"
  ) {
    // The review's must-fix findings were handled by this fix; suggestions keep going to the acceptance pack.
    await client.query(
      `UPDATE findings SET resolution = 'fixed' WHERE resolution = 'unhandled'
       AND run_id IN (SELECT id FROM runs WHERE ticket_id = $1 AND stage = 'review')`,
      [owner.ticket_id],
    );
  }
  if (stage === "final-fix" && result?.outcome === "done") {
    // Same meaning of `fixed` as ticket-level review-fix: the wrap-up's must-fix were handed to
    // this fix, which reported done. Suggestions stay on the acceptance pack.
    await client.query(
      `UPDATE findings SET resolution = 'fixed' WHERE resolution = 'unhandled' AND kind = 'must-fix'
       AND run_id IN (
         SELECT id FROM runs
         WHERE spec_id = $1 AND repo_id = $2 AND ticket_id IS NULL AND stage = 'final-review'
       )`,
      [owner.spec_id, owner.repo_id],
    );
  }
  await insertFindings(client, runId, result?.findings ?? []);
  // the other axes of a review: a Run each, which belongs to no job of its own
  for (const extra of result?.extraRuns ?? []) {
    const extraTries = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM runs WHERE spec_id = $1 AND ticket_id IS NOT DISTINCT FROM $2 AND stage = $3 AND axis IS NOT DISTINCT FROM $4",
      [owner.spec_id, owner.ticket_id, stage, extra.run.axis ?? null],
    );
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, ticket_version, stage, attempt, agent, model, skills_sha, axis,
         prompt, branch, base_sha, head_sha, commits, duration_ms, result, output, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         COALESCE($19, (SELECT started_at FROM runs WHERE id = $21)), COALESCE($20, now()))
       RETURNING id`,
      [
        owner.spec_id,
        owner.repo_id,
        owner.ticket_id,
        owner.content_version,
        stage,
        Number(extraTries.rows[0]?.n) + 1,
        extra.run.agent ?? null,
        extra.run.model ?? null,
        extra.run.skillsSha ?? null,
        extra.run.axis ?? null,
        extra.run.prompt ?? null,
        extra.run.branch ?? null,
        extra.run.baseSha ?? null,
        extra.run.headSha ?? null,
        extra.run.commits ?? [],
        extra.run.durationMs ?? null,
        extra.run.result ?? result?.outcome ?? "invalid-output",
        JSON.stringify(extra.run.output ?? null),
        extra.run.startedAt ?? null,
        extra.run.finishedAt ?? null,
        // the axes run side by side, so one sent without a start time started with the job's own Run
        runId,
      ],
    );
    if (extra.run.refShas) {
      await client.query("UPDATE runs SET ref_shas = $2 WHERE id = $1", [
        inserted.rows[0]?.id,
        JSON.stringify(extra.run.refShas),
      ]);
    }
    await insertFindings(
      client,
      inserted.rows[0]?.id as number,
      extra.findings,
    );
  }
}

async function insertFindings(
  client: pg.PoolClient,
  runId: number,
  found: { kind: string; body: string; resolution?: string }[],
): Promise<void> {
  for (const finding of found) {
    // A review's suggestions and scope creep do not trigger a fix; they travel to the acceptance pack.
    const resolution =
      finding.resolution ??
      (finding.kind === "suggestion" || finding.kind === "scope-creep"
        ? "acceptance-pack"
        : "unhandled");
    await client.query(
      "INSERT INTO findings (run_id, kind, body, resolution) VALUES ($1, $2, $3, $4)",
      [runId, finding.kind, finding.body, resolution],
    );
  }
}

async function applyDecision(
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
      await blockTicket(client, ticket, "invalid-output");
    } else if (finished.status !== "ok") {
      throw new Error(`cannot finish ticket ${ticket.id}: ${finished.status}`);
    } else if (result?.stage === "merge") {
      await enqueueTrialMerge(client, {
        specId: ticket.spec_id,
        repoId: ticket.repo_id,
        headSha: result.headSha,
      });
    }
    return;
  }
  if (decision.type === "block") {
    await blockTicket(client, ticket, decision.reason);
    return;
  }
  if (decision.type === "await-fix") {
    const diagnosis =
      result?.stage === "diagnose" ? result.diagnosis : undefined;
    if (!diagnosis) throw new Error("a fix is awaited without a diagnosis");
    const rounds = decision.progress.integrationRounds ?? 0;
    const fixId = await createFixTicket(client, ticket, diagnosis);
    if (fixId === undefined) {
      await blockTicket(client, ticket, "invalid-output");
      return;
    }
    const waiting = ticketTransition(ticket.state, { type: "await-fix" });
    if (!waiting.ok || waiting.state === "blocked")
      throw new Error(waiting.ok ? "unexpected block" : waiting.reason);
    // merged already: when the fix is done it starts again from its e2e
    await client.query(
      "UPDATE tickets SET state = $2, integration_rounds = $3, resume_stage = 'e2e' WHERE id = $1",
      [ticket.id, waiting.state, rounds],
    );
    await schedulePass(client, ticket.spec_id);
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
    `UPDATE tickets SET state = $2, fix_counts = $3, reviewed = $4,
       resume_stage = CASE WHEN $5 = 'e2e' THEN 'e2e' ELSE resume_stage END WHERE id = $1`,
    [
      ticket.id,
      state,
      JSON.stringify(decision.progress.fixCounts),
      decision.progress.reviewed,
      decision.stage,
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

async function blockTicket(
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

// A worker claiming a ticket stage job starts its Run (so there is something to attach logs to while the stage
// is still going), and for the first stage moves the ticket from queued to running.
export async function markClaimed(
  pool: Pick<pg.Pool, "query">,
  job: StageJob,
): Promise<void> {
  const read = readStagePayload(job.payload);
  if (!read) return;
  const { ticketId, stage } = read;
  if (stage === "implement" || stage === "e2e") {
    // an e2e that is queued is the ticket's run again after a fix: it is merged already
    const next = ticketTransition("queued", claimEventOf(stage));
    if (next.ok && next.state !== "blocked") {
      await pool.query(
        "UPDATE tickets SET state = $2 WHERE id = $1 AND state = 'queued'",
        [ticketId, next.state],
      );
    }
  }
  // A spec Retry note is only for retry-final. Ordinary ticket claims must not take it. The spec's
  // final e2e jobs are ticket-stage jobs, so they copy the spec note here.
  await startRun(pool, ticketId, job.id, stage, job.payload.finalE2e === true);
}

// A re-claim after a lease ran out finds the Run already there and leaves it be.
async function startRun(
  pool: Pick<pg.Pool, "query">,
  ticketId: number,
  jobId: number,
  stage: Stage,
  fromSpecNote: boolean,
): Promise<void> {
  const contracts = await contractsOf(pool, ticketId);
  await pool.query(
    `INSERT INTO runs (spec_id, repo_id, ticket_id, ticket_version, job_id, stage, attempt, contract_shas, retry_note, started_at)
     SELECT t.spec_id, t.repo_id, t.id, t.content_version, $2, $3,
       (SELECT count(*) FROM runs r WHERE r.ticket_id = t.id AND r.stage = $3) + 1, $4::jsonb,
       ${fromSpecNote ? "COALESCE(t.retry_note, s.retry_note)" : "t.retry_note"}, now()
     FROM tickets t JOIN specs s ON s.id = t.spec_id WHERE t.id = $1
     ON CONFLICT (job_id) DO NOTHING`,
    [
      ticketId,
      jobId,
      stage,
      contracts.length
        ? JSON.stringify(
            Object.fromEntries(contracts.map((c) => [c.repo, c.sha])),
          )
        : null,
    ],
  );
  await pool.query("UPDATE tickets SET retry_note = NULL WHERE id = $1", [
    ticketId,
  ]);
  if (fromSpecNote) {
    await pool.query(
      "UPDATE specs SET retry_note = NULL WHERE id = (SELECT spec_id FROM tickets WHERE id = $1)",
      [ticketId],
    );
  }
}
