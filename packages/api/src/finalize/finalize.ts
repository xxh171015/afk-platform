import {
  AGENT_FAILURES,
  advanceFinalization,
  type BlockedReason,
  type FinalDecision,
  type FinalReport,
  type FinalStep,
  formatDisplayId,
  type SpecState,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { recordAction } from "../events/human-actions.ts";
import { enqueueOpenPr } from "../host/host-jobs.ts";
import { enqueueTrialMerge } from "../host/trial-merge.ts";
import { enqueueFinalJob, readFinalPayload } from "../jobs/stage-jobs.ts";
import { inTransaction, lockSpec } from "../scheduling/scheduler.ts";
import { recheckTriggerOf } from "../stages/recheck-hit.ts";
import { commonFields, type StageJob, writeFacts } from "../stages/results.ts";
import { reviewOutcomeWithRulings } from "../stages/review-rulings.ts";
import { type ActionResult, parkedRetryNote } from "../tickets/actions.ts";
import { retryFinalE2e, settleFinalization } from "./final-e2e.ts";

const refused = (message: string) => ({ status: "refused", message }) as const;

// The facts a worker hands back for a finalization step (the same Run, GateResult and Finding parts as for a
// ticket stage), with the step's own list of outcomes.
export const FinalResultSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("final-review"),
    outcome: z.enum(["pass", "fix", "invalid-output", "timeout"]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("final-fix"),
    outcome: z.enum(["done", ...AGENT_FAILURES]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("recheck"),
    outcome: z.enum(["pass", "fix", "invalid-output", "timeout"]),
    ...commonFields,
  }),
  z.object({
    stage: z.literal("final-merge"),
    outcome: z.enum(["merged", "conflict", "gate-failed", "tests-removed"]),
    headSha: z.string().min(1).optional(),
    ...commonFields,
  }),
]);

export type RecordFinalResult =
  | { status: "not-final" }
  | { status: "ignored"; reason: string }
  | { status: "applied"; decision: FinalDecision };

export async function recordFinalResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<RecordFinalResult> {
  const read = readFinalPayload(job.payload);
  if (!read) return { status: "not-final" };
  await lockSpec(client, read.specId);
  const specState = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  if (specState.rows[0]?.state !== "finalizing") {
    // cancelled or otherwise taken out of the flow while the step was out: its result changes nothing
    return {
      status: "ignored",
      reason: `${read.step} result for a spec that is ${specState.rows[0]?.state}`,
    };
  }
  const found = await client.query<{
    id: number;
    step: FinalStep;
    state: string;
  }>(
    "SELECT id, step, state FROM finalizations WHERE spec_id = $1 AND repo_id = $2",
    [read.specId, read.repoId],
  );
  const fin = found.rows[0];
  if (fin?.state !== "active" || fin.step !== read.step) {
    return {
      status: "ignored",
      reason: `${read.step} result while the finalization is ${fin?.state ?? "missing"} at ${fin?.step}`,
    };
  }

  const parsed = FinalResultSchema.safeParse(result);
  let valid =
    parsed.success && parsed.data.stage === read.step ? parsed.data : undefined;
  if (valid && valid.stage === "final-review") {
    const outcome = await reviewOutcomeWithRulings(client, {
      specId: read.specId,
      ticketId: null,
      jobId: job.id,
      stage: "final-review",
      outcome: valid.outcome,
      run: valid.run,
      extraRuns: valid.extraRuns,
    });
    if (outcome !== valid.outcome) {
      valid = {
        ...valid,
        outcome: outcome as "pass" | "fix" | "invalid-output" | "timeout",
      };
    }
  }
  await writeFacts(
    client,
    {
      spec_id: read.specId,
      repo_id: read.repoId,
      ticket_id: null,
      content_version: null,
    },
    job,
    read.step,
    valid,
    result,
  );
  let decision: FinalDecision = valid
    ? advanceFinalization({
        step: valid.stage,
        outcome: valid.outcome,
      } as FinalReport)
    : { type: "block", reason: "invalid-output" };
  const trigger = recheckTriggerOf(valid?.run);
  if (
    valid?.stage === "final-fix" &&
    valid.outcome === "done" &&
    trigger?.hit
  ) {
    const spec = await client.query<{ allowed: string[] }>(
      "SELECT allowed_recheck_shas AS allowed FROM specs WHERE id = $1",
      [read.specId],
    );
    if (!spec.rows[0]?.allowed.includes(trigger.toSha))
      decision = { type: "enqueue", step: "recheck" };
  }

  if (decision.type === "enqueue") {
    await client.query("UPDATE finalizations SET step = $2 WHERE id = $1", [
      fin.id,
      decision.step,
    ]);
    const extra =
      decision.step === "recheck" && trigger
        ? {
            fromSha: trigger.fromSha,
            toSha: trigger.toSha,
            paths: trigger.paths,
          }
        : {};
    await enqueueFinalJob(client, read, decision.step, extra);
  } else if (decision.type === "done") {
    await client.query(
      "UPDATE finalizations SET state = 'done' WHERE id = $1",
      [fin.id],
    );
    if (valid?.stage === "final-merge") {
      await enqueueTrialMerge(client, {
        specId: read.specId,
        repoId: read.repoId,
        headSha: valid.headSha,
      });
    }
    // the last repo to settle sends all of the spec's pull requests out, after the e2e that comes first when a
    // final fix changed a branch
    await settleFinalization(client, read.specId);
  } else {
    await client.query(
      "UPDATE finalizations SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
      [fin.id, decision.reason satisfies BlockedReason],
    );
  }
  return { status: "applied", decision };
}

// A worker claiming a final job starts its Run, as for a ticket stage.
export async function markFinalClaimed(
  pool: Pick<pg.Pool, "query">,
  job: StageJob,
): Promise<void> {
  const read = readFinalPayload(job.payload);
  if (!read) return;
  await pool.query(
    `INSERT INTO runs (spec_id, repo_id, job_id, stage, attempt, retry_note, started_at)
     SELECT $1, $2, $3, $4,
       (SELECT count(*) FROM runs r WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = $4) + 1,
       s.retry_note, now()
     FROM specs s WHERE s.id = $1
     ON CONFLICT (job_id) DO NOTHING`,
    [read.specId, read.repoId, job.id, read.step],
  );
  await pool.query("UPDATE specs SET retry_note = NULL WHERE id = $1", [
    read.specId,
  ]);
}

// Note that retrying a final-fix that failed runs the fix again: a person has decided to, so "once" holds for the
// automatic flow, not for a human's retry.
// A person has looked at a blocked finalization (resolved a conflict, fixed the gate's cause) and wants the step
// that failed to run again.
export async function retryFinalization(
  pool: pg.Pool,
  specId: number,
  note: string | null = null,
): Promise<ActionResult<{ retried: string[] }>> {
  return inTransaction(pool, async (client) => {
    const exists = await client.query("SELECT 1 FROM specs WHERE id = $1", [
      specId,
    ]);
    if (exists.rowCount === 0) return { status: "no-ticket" };
    await lockSpec(client, specId);
    const spec = await client.query<{ state: SpecState }>(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    if (spec.rows[0]?.state !== "finalizing") {
      return refused(
        `${formatDisplayId("spec", specId)} is ${spec.rows[0]?.state}, not finalizing`,
      );
    }
    const blocked = await client.query<{
      id: number;
      repo_id: number;
      step: FinalStep;
    }>(
      "SELECT id, repo_id, step FROM finalizations WHERE spec_id = $1 AND state = 'blocked' ORDER BY id",
      [specId],
    );
    const retried: string[] = [];
    // the e2e before the pull requests is a step of the spec's finalization too
    if (await retryFinalE2e(client, specId)) retried.push("final-e2e");
    if (blocked.rows.length === 0 && retried.length === 0) {
      return {
        status: "refused",
        message: `${formatDisplayId("spec", specId)} has no blocked finalization`,
      };
    }
    await client.query("UPDATE specs SET retry_note = $2 WHERE id = $1", [
      specId,
      parkedRetryNote(note),
    ]);
    for (const row of blocked.rows) {
      await client.query(
        "UPDATE finalizations SET state = 'active', blocked_reason = NULL,\n           job_floor = (SELECT COALESCE(max(id), 0) FROM jobs) WHERE id = $1",
        [row.id],
      );
      // A branch that was settled when the pull request could not be opened needs the pull request, not the
      // review or the merge again.
      const settled = await client.query(
        `SELECT 1 FROM runs WHERE spec_id = $1 AND repo_id = $2 AND ticket_id IS NULL
           AND ((stage = 'final-review' AND result = 'pass') OR (stage = 'final-merge' AND result = 'merged'))`,
        [specId, row.repo_id],
      );
      if (settled.rowCount) {
        await enqueueOpenPr(client, { specId, repoId: row.repo_id });
        retried.push("open-pr");
      } else {
        await enqueueFinalJob(
          client,
          { specId, repoId: row.repo_id },
          row.step,
        );
        retried.push(row.step);
      }
    }
    await recordAction(
      client,
      "retry-final",
      { specId },
      { retried, note: parkedRetryNote(note) },
    );
    return { status: "ok", retried };
  });
}
