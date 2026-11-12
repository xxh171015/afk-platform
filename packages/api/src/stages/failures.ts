import {
  type BlockedReason,
  classifyPushError,
  formatPushFailure,
  isSandboxOomError,
  type TicketState,
  ticketTransition,
  unrecoverableJobError,
} from "@afk/shared";
import type pg from "pg";
import {
  finalE2eJobFailed,
  readFinalE2ePayload,
} from "../finalize/final-e2e.ts";
import {
  CLEANUP_RETRY_SECONDS,
  enqueueOpenPr,
  enqueuePrReady,
  enqueueSpecCleanup,
  inSeconds,
  openPrKeyPrefix,
  type PrReadyPayload,
  prReadyKeyPrefix,
  readOpenPrPayload,
  readPrReadyPayload,
  readSpecCleanupPayload,
  type SpecCleanupPayload,
  specCleanupKeyPrefix,
} from "../host/host-jobs.ts";
import { updateBranchJobFailed } from "../host/update-branch.ts";
import { finalJobKeyPrefix, ticketJobKeyPrefix } from "../jobs/idempotency.ts";
import {
  enqueueFinalJob,
  enqueueStageJob,
  readFinalPayload,
  readStagePayload,
} from "../jobs/stage-jobs.ts";
import { recordLocateJobFailure } from "../planning/locate-bug.ts";
import {
  planningCommitFailed,
  readPlanningPayload,
} from "../planning/planning-commit.ts";
import { lockSpec, schedulePass } from "../scheduling/scheduler.ts";
import { EXPECTED_STATE, type StageJob, startsQueued } from "./results.ts";

// A worker that cannot carry out a stage reports the job as failed (its sandbox would not start, a push was
// refused, ...). A network blip is retried; a non-fast-forward stops at once as branch-moved, and a host
// permission refusal as job-failed. Other infrastructure errors are queued again and block after three.
// Cursor auth, a bad model, a spent quota, and a failed integration image build still skip the requeue.
export const MAX_JOB_FAILURES = 3;

const JOB_FAILED: BlockedReason = "job-failed";

// The error of a job whose lease ran out. It counts against MAX_JOB_FAILURES like any failure the worker reports:
// a worker that keeps dying or hanging on the same stage would otherwise be handed the job for ever. The events
// trigger reads the prefix to record the reason as lease-expired (drizzle/0069_lease_expired_failures.sql).
export const LEASE_EXPIRED_ERROR =
  "lease-expired: the worker stopped renewing its lease (it stopped, hung, or could not reach the API)";

// The e2e stage only fails as a job when its environment cannot be brought up (an e2e that runs and fails is a
// result, not a failed job), and the diagnosis runs in a fresh environment too: three failures of either name it.
// So does the implement of an integration ticket, whose agent works in the environment: the error in its brief
// says what failed.
const reasonOfFailed = (stage: string, type: string): BlockedReason =>
  stage === "e2e" ||
  stage === "diagnose" ||
  (stage === "implement" && type === "integration")
    ? "integration-environment-failed"
    : JOB_FAILED;

function storedJobError(error: string): string {
  return unrecoverableJobError(error) ?? formatPushFailure(error);
}

function immediateBlockReason(error: string): BlockedReason | undefined {
  if (isSandboxOomError(error)) return "sandbox-oom";
  if (unrecoverableJobError(error)) return JOB_FAILED;
  const push = classifyPushError(error);
  if (push === "branch-moved") return "branch-moved";
  if (push === "host-permission") return JOB_FAILED;
  return undefined;
}

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
  now: Date,
): Promise<FailureOutcome> {
  await finishRun(client, job.id, storedJobError(error));

  const planning = readPlanningPayload(job);
  if (planning) {
    const outcome = await planningCommitFailed(
      client,
      planning,
      MAX_JOB_FAILURES,
    );
    return outcome === "ignored"
      ? { status: "ignored" }
      : { status: outcome, failures: MAX_JOB_FAILURES };
  }
  const finalE2e = readFinalE2ePayload(job.payload);
  if (finalE2e) return finalE2eJobFailed(client, finalE2e, error);
  const stage = readStagePayload(job.payload);
  if (stage) return ticketStageFailed(client, stage, error);
  const final = readFinalPayload(job.payload);
  if (final) return finalStepFailed(client, final, error);
  const update = await updateBranchJobFailed(client, job, error);
  if (update !== "not-update-branch") {
    return update === "paused"
      ? { status: "blocked", failures: 1 }
      : { status: "ignored" };
  }
  const openPr = readOpenPrPayload(job);
  if (openPr) return openPrFailed(client, openPr);
  const cleanup = readSpecCleanupPayload(job);
  if (cleanup) return specCleanupFailed(client, cleanup, now);
  const ready = readPrReadyPayload(job);
  if (ready) return prReadyFailed(client, ready, now);
  const locate = await recordLocateJobFailure(client, job, error);
  if (locate.status !== "not-locate") {
    return locate.status === "ignored"
      ? { status: "ignored" }
      : { status: "blocked", failures: 1 };
  }
  return { status: "not-a-stage" };
}

async function ticketStageFailed(
  client: pg.PoolClient,
  read: NonNullable<ReturnType<typeof readStagePayload>>,
  error: string,
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
      type: string;
      state: TicketState;
      content_version: number;
      job_floor: number;
    }>(
      "SELECT spec_id, repo_id, type, state, content_version, job_floor FROM tickets WHERE id = $1",
      [read.ticketId],
    )
  ).rows[0];
  const stateFits =
    row?.state === EXPECTED_STATE[read.stage] ||
    (startsQueued(read.stage) && row?.state === "queued");
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
  const immediate = immediateBlockReason(error);
  if (!immediate && failures < MAX_JOB_FAILURES) {
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
  const reason: BlockedReason =
    immediate ?? reasonOfFailed(read.stage, row.type);
  const blocked = ticketTransition(from, { type: "block", reason });
  if (!blocked.ok) throw new Error(blocked.reason);
  await client.query(
    "UPDATE tickets SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [read.ticketId, reason],
  );
  // it no longer holds an agent run
  await schedulePass(client, row.spec_id);
  return { status: "blocked", failures };
}

async function finalStepFailed(
  client: pg.PoolClient,
  read: NonNullable<ReturnType<typeof readFinalPayload>>,
  error: string,
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
  const immediate = immediateBlockReason(error);
  if (!immediate && failures < MAX_JOB_FAILURES) {
    await enqueueFinalJob(client, read, read.step);
    return { status: "requeued", failures };
  }
  await client.query(
    "UPDATE finalizations SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [fin.id, immediate ?? JOB_FAILED],
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

// The cleanup of a cancelled or merged spec could not be done: tried again, three times in all. Nothing waits for
// it, so after that it is left (the job stays failed, with its error).
async function specCleanupFailed(
  client: pg.PoolClient,
  read: SpecCleanupPayload,
  now: Date,
): Promise<FailureOutcome> {
  const failures = await failuresOf(client, specCleanupKeyPrefix(read), 0);
  if (failures >= MAX_JOB_FAILURES) return { status: "blocked", failures };
  await enqueueSpecCleanup(client, read, inSeconds(now, CLEANUP_RETRY_SECONDS));
  return { status: "requeued", failures };
}

// A draft could not be turned ready: tried again a minute later, three times in all. After that the job stays failed,
// and plat blocked lists the pull request for a person (who can turn it ready on the host, which a look at the
// host will then see).
async function prReadyFailed(
  client: pg.PoolClient,
  read: PrReadyPayload,
  now: Date,
): Promise<FailureOutcome> {
  const failures = await failuresOf(client, prReadyKeyPrefix(read), 0);
  if (failures >= MAX_JOB_FAILURES) return { status: "blocked", failures };
  await enqueuePrReady(client, read, inSeconds(now, CLEANUP_RETRY_SECONDS));
  return { status: "requeued", failures };
}
