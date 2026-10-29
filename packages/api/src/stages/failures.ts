import {
  type BlockedReason,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import {
  enqueueOpenPr,
  openPrKeyPrefix,
  readOpenPrPayload,
} from "../host/host-jobs.ts";
import { finalJobKeyPrefix, ticketJobKeyPrefix } from "../jobs/idempotency.ts";
import {
  enqueueFinalJob,
  enqueueStageJob,
  readFinalPayload,
  readStagePayload,
} from "../jobs/stage-jobs.ts";
import { lockSpec, schedulePass } from "../scheduling/scheduler.ts";
import { EXPECTED_STATE, type StageJob } from "./results.ts";

// A worker that cannot carry out a stage reports the job as failed (its sandbox would not start, a push was
// refused again and again, ...). That is not the ticket's fault, so the stage is queued again; if it keeps
// failing the ticket is blocked with job-failed and the error in its brief, for a person to look at.
export const MAX_JOB_FAILURES = 3;

const JOB_FAILED: BlockedReason = "job-failed";

export type FailureOutcome =
  | { status: "not-a-stage" } // a job that is neither a ticket stage nor a finalization step
  | { status: "ignored" } // the ticket or the finalization has moved on
  | { status: "requeued"; failures: number }
  | { status: "blocked"; failures: number };

// The Run the job started is over, whatever else happens.
async function finishRun(client: pg.PoolClient, jobId: number, error: string) {
  await client.query(
    `UPDATE runs SET finished_at = COALESCE(finished_at, now()), result = 'job-failed',
       duration_ms = COALESCE(duration_ms, LEAST(extract(epoch FROM (now() - started_at)) * 1000, 2147483647)::int),
       output = jsonb_build_object('error', $2::text) WHERE job_id = $1`,
    [jobId, error],
  );
}

// Failures since the last time a person retried: those before it were answered by that retry.
const failuresOf = async (
  client: pg.PoolClient,
  prefix: string,
  floor: number,
) =>
  Number(
    (
      await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1 AND state = 'failed' AND id > $2",
        [`${prefix}%`, floor],
      )
    ).rows[0]?.n,
  );

export async function recordJobFailure(
  client: pg.PoolClient,
  job: StageJob,
  error: string,
): Promise<FailureOutcome> {
  await finishRun(client, job.id, error);

  const stage = readStagePayload(job.payload);
  if (stage) return ticketStageFailed(client, stage);
  const final = readFinalPayload(job.payload);
  if (final) return finalStepFailed(client, final);
  const openPr = readOpenPrPayload(job);
  if (openPr) return openPrFailed(client, openPr);
  return { status: "not-a-stage" };
}

async function ticketStageFailed(
  client: pg.PoolClient,
  read: NonNullable<ReturnType<typeof readStagePayload>>,
): Promise<FailureOutcome> {
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [read.ticketId],
  );
  if (!found.rows[0]) return { status: "ignored" };
  await lockSpec(client, found.rows[0].spec_id);
  const row = (
    await client.query<{
      spec_id: number;
      repo_id: number;
      state: TicketState;
      content_version: number;
      job_floor: number;
    }>(
      "SELECT spec_id, repo_id, state, content_version, job_floor FROM tickets WHERE id = $1",
      [read.ticketId],
    )
  ).rows[0];
  const stateFits =
    row?.state === EXPECTED_STATE[read.stage] ||
    (read.stage === "implement" && row?.state === "queued");
  if (!row || !stateFits || read.contentVersion !== row.content_version)
    return { status: "ignored" };

  const failures = await failuresOf(
    client,
    ticketJobKeyPrefix({
      ticketId: read.ticketId,
      contentVersion: row.content_version,
      stage: read.stage,
    }),
    row.job_floor,
  );
  if (failures < MAX_JOB_FAILURES) {
    await enqueueStageJob(
      client,
      {
        id: read.ticketId,
        specId: row.spec_id,
        repoId: row.repo_id,
        contentVersion: row.content_version,
      },
      read.stage,
    );
    return { status: "requeued", failures };
  }
  // A ticket that never got to start counts as running now, so that the state machine can block it.
  const from: TicketState = row.state === "queued" ? "running" : row.state;
  const blocked = ticketTransition(from, { type: "block", reason: JOB_FAILED });
  if (!blocked.ok) throw new Error(blocked.reason);
  await client.query(
    "UPDATE tickets SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [read.ticketId, JOB_FAILED],
  );
  // it no longer holds an agent run
  await schedulePass(client, row.spec_id);
  return { status: "blocked", failures };
}

async function finalStepFailed(
  client: pg.PoolClient,
  read: NonNullable<ReturnType<typeof readFinalPayload>>,
): Promise<FailureOutcome> {
  await lockSpec(client, read.specId);
  const fin = (
    await client.query<{
      id: number;
      step: string;
      state: string;
      job_floor: number;
    }>(
      "SELECT id, step, state, job_floor FROM finalizations WHERE spec_id = $1 AND repo_id = $2",
      [read.specId, read.repoId],
    )
  ).rows[0];
  if (fin?.state !== "active" || fin.step !== read.step)
    return { status: "ignored" };

  const failures = await failuresOf(
    client,
    finalJobKeyPrefix({
      specId: read.specId,
      repoId: read.repoId,
      step: read.step,
    }),
    fin.job_floor,
  );
  if (failures < MAX_JOB_FAILURES) {
    await enqueueFinalJob(client, read, read.step);
    return { status: "requeued", failures };
  }
  await client.query(
    "UPDATE finalizations SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [fin.id, JOB_FAILED],
  );
  return { status: "blocked", failures };
}

// The pull request could not be opened. Tried again; after three failures the repo's finalization is blocked, and
// a person's retry opens it again (retryFinalization sees that the branch itself was settled).
async function openPrFailed(
  client: pg.PoolClient,
  read: { specId: number; repoId: number },
): Promise<FailureOutcome> {
  await lockSpec(client, read.specId);
  const fin = (
    await client.query<{ id: number; state: string; job_floor: number }>(
      "SELECT id, state, job_floor FROM finalizations WHERE spec_id = $1 AND repo_id = $2",
      [read.specId, read.repoId],
    )
  ).rows[0];
  const spec = await client.query<{ state: string }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  if (!fin || spec.rows[0]?.state !== "finalizing")
    return { status: "ignored" };
  const failures = await failuresOf(
    client,
    openPrKeyPrefix(read),
    fin.job_floor,
  );
  if (failures < MAX_JOB_FAILURES) {
    await enqueueOpenPr(client, read);
    return { status: "requeued", failures };
  }
  await client.query(
    "UPDATE finalizations SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [fin.id, JOB_FAILED],
  );
  return { status: "blocked", failures };
}
