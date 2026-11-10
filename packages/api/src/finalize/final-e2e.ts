import {
  FINAL_E2E_FAILED,
  formatDisplayId,
  type SpecState,
  unrecoverableJobError,
} from "@afk/shared";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import { startOpeningPullRequests } from "../host/pull-requests.ts";
import { ticketJobKeyPrefix } from "../jobs/idempotency.ts";
import { enqueueStageJob } from "../jobs/stage-jobs.ts";
import { inTransaction, lockSpec } from "../scheduling/scheduler.ts";
import {
  type StageJob,
  StageResultSchema,
  writeFacts,
} from "../stages/results.ts";
import type { ActionResult } from "../tickets/actions.ts";

// The e2e of every integration ticket, once more, before the pull requests are opened: when a repo's final fix
// changed its branch, the integration the tickets passed on may be a different one now. It belongs to the spec,
// not to a ticket (docs/specs/m2-platform.md「收尾、PR 与合并」).

const MAX_JOB_FAILURES = 3;
const ENVIRONMENT_FAILED = "integration-environment-failed";
const JOB_FAILED = "job-failed";

// where a ticket is in the current round
type Status = "e2e" | "diagnosing" | "passed" | "failed";

interface Round {
  id: number;
  state: "active" | "blocked" | "done" | "waived";
  round: number;
  tickets: Record<string, Status>;
  job_floor: number;
}

export interface FinalE2ePayload {
  specId: number;
  ticketId: number;
  round: number;
  stage: "e2e" | "diagnose";
}

// The payload of a job of this step: a ticket's e2e or diagnose stage, marked as belonging to the spec's round.
export function readFinalE2ePayload(
  payload: Record<string, unknown>,
): FinalE2ePayload | undefined {
  const { finalE2e, specId, ticketId, round, stage } = payload;
  if (
    finalE2e !== true ||
    typeof specId !== "number" ||
    typeof ticketId !== "number" ||
    typeof round !== "number" ||
    (stage !== "e2e" && stage !== "diagnose")
  )
    return undefined;
  return { specId, ticketId, round, stage };
}

const roundOf = async (client: pg.PoolClient, specId: number) =>
  (
    await client.query<Round>(
      "SELECT id, state, round, tickets, job_floor FROM final_e2e WHERE spec_id = $1",
      [specId],
    )
  ).rows[0];

// The round a result or a failure belongs to, when it is still the one that is going: the spec is finalizing, the
// round is active and has this number, and the ticket is waiting for this stage.
async function currentRound(
  client: pg.PoolClient,
  read: FinalE2ePayload,
): Promise<Round | undefined> {
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  const round = await roundOf(client, read.specId);
  const expected: Status = read.stage === "e2e" ? "e2e" : "diagnosing";
  return spec.rows[0]?.state === "finalizing" &&
    round?.state === "active" &&
    round.round === read.round &&
    round.tickets[read.ticketId] === expected
    ? round
    : undefined;
}

interface TicketRef {
  id: number;
  repo_id: number;
  content_version: number;
}

async function integrationTickets(
  client: pg.PoolClient,
  specId: number,
): Promise<TicketRef[]> {
  return (
    await client.query<TicketRef>(
      `SELECT id, repo_id, content_version FROM tickets
       WHERE spec_id = $1 AND type = 'integration' AND state = 'done' ORDER BY id`,
      [specId],
    )
  ).rows;
}

async function enqueueFor(
  client: pg.PoolClient,
  specId: number,
  ticket: TicketRef,
  stage: "e2e" | "diagnose",
  round: number,
) {
  await enqueueStageJob(
    client,
    {
      id: ticket.id,
      specId,
      repoId: ticket.repo_id,
      contentVersion: ticket.content_version,
    },
    stage,
    { finalE2e: true, round },
  );
}

// Every integration ticket gets its e2e for the round, on the heads of the branches as the finalizations left them.
async function startRound(
  client: pg.PoolClient,
  specId: number,
  round: number,
): Promise<void> {
  const tickets = await integrationTickets(client, specId);
  await client.query(
    "UPDATE final_e2e SET tickets = $2, round = $3 WHERE spec_id = $1",
    [
      specId,
      JSON.stringify(Object.fromEntries(tickets.map((t) => [t.id, "e2e"]))),
      round,
    ],
  );
  for (const ticket of tickets)
    await enqueueFor(client, specId, ticket, "e2e", round);
}

// The pull requests go out when every repo's branch is settled, and the e2e before them (when there is one) has
// passed or been let through. Called when a repo's finalization is done, and when the e2e settles.
export async function settleFinalization(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const unsettled = await client.query(
    "SELECT 1 FROM finalizations WHERE spec_id = $1 AND state <> 'done'",
    [specId],
  );
  if (unsettled.rowCount) return;
  const round = await roundOf(client, specId);
  if (round) {
    if (round.state === "done" || round.state === "waived")
      await startOpeningPullRequests(client, specId);
    return;
  }
  // Only a final fix can have changed what the tickets' e2e saw; with no integration ticket there is nothing to run.
  const fixed = await client.query(
    `SELECT 1 FROM runs WHERE spec_id = $1 AND ticket_id IS NULL AND stage = 'final-fix' AND result = 'done' LIMIT 1`,
    [specId],
  );
  if (fixed.rowCount && (await integrationTickets(client, specId)).length > 0) {
    await client.query(
      "INSERT INTO final_e2e (spec_id, job_floor) VALUES ($1, (SELECT COALESCE(max(id), 0) FROM jobs))",
      [specId],
    );
    await startRound(client, specId, 1);
    return;
  }
  await startOpeningPullRequests(client, specId);
}

// One ticket's e2e or diagnosis is in (the caller holds nothing yet: the spec is locked here). Returns false for a
// result that does not belong to the round that is going.
export async function recordFinalE2eResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<"ignored" | "applied"> {
  const read = readFinalE2ePayload(job.payload);
  if (!read) return "ignored";
  await lockSpec(client, read.specId);
  const round = await currentRound(client, read);
  if (!round) return "ignored";

  const ticket = (
    await client.query<TicketRef & { spec_id: number }>(
      "SELECT id, spec_id, repo_id, content_version FROM tickets WHERE id = $1",
      [read.ticketId],
    )
  ).rows[0] as TicketRef & { spec_id: number };
  const parsed = StageResultSchema.safeParse(result);
  const valid =
    parsed.success && parsed.data.stage === read.stage
      ? parsed.data
      : undefined;
  // the runs belong to the ticket, so its page shows them and the acceptance pack reads the last e2e from them
  await writeFacts(
    client,
    {
      spec_id: read.specId,
      repo_id: ticket.repo_id,
      ticket_id: ticket.id,
      content_version: ticket.content_version,
    },
    job,
    read.stage,
    valid,
    result,
  );

  let status: Status;
  if (read.stage === "e2e") {
    if (valid?.outcome === "passed") status = "passed";
    else if (valid) status = "diagnosing";
    else status = "failed"; // nothing usable to diagnose
  } else {
    status = "failed"; // the diagnosis is for the brief only: whatever it said, a person decides
  }
  const tickets = { ...round.tickets, [read.ticketId]: status };
  await client.query("UPDATE final_e2e SET tickets = $2 WHERE id = $1", [
    round.id,
    JSON.stringify(tickets),
  ]);
  if (status === "diagnosing")
    await enqueueFor(client, read.specId, ticket, "diagnose", read.round);
  await settleRound(client, read.specId, round.id, tickets);
  return "applied";
}

// Every ticket has an answer: all passed lets the pull requests out, anything else is for a person to decide.
async function settleRound(
  client: pg.PoolClient,
  specId: number,
  id: number,
  tickets: Record<string, Status>,
): Promise<void> {
  const open = Object.values(tickets).some(
    (s) => s === "e2e" || s === "diagnosing",
  );
  if (open) return;
  if (Object.values(tickets).every((s) => s === "passed")) {
    await client.query("UPDATE final_e2e SET state = 'done' WHERE id = $1", [
      id,
    ]);
    await startOpeningPullRequests(client, specId);
    return;
  }
  await client.query(
    "UPDATE final_e2e SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [id, FINAL_E2E_FAILED],
  );
}

// A job of the step failed on the worker (the environment would not come up, mostly): tried again, and after three
// failures in a row the step is blocked. An unrecoverable error (a failed image build, a dead Cursor key) blocks
// at once.
export async function finalE2eJobFailed(
  client: pg.PoolClient,
  read: FinalE2ePayload,
  error: string,
): Promise<
  { status: "ignored" } | { status: "requeued" | "blocked"; failures: number }
> {
  await lockSpec(client, read.specId);
  const round = await currentRound(client, read);
  if (!round) return { status: "ignored" };
  const ticket = (
    await client.query<TicketRef>(
      "SELECT id, repo_id, content_version FROM tickets WHERE id = $1",
      [read.ticketId],
    )
  ).rows[0] as TicketRef;
  const failures = Number(
    (
      await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1 AND state = 'failed' AND id > $2",
        [
          `${ticketJobKeyPrefix({
            ticketId: ticket.id,
            contentVersion: ticket.content_version,
            stage: read.stage,
          })}%`,
          round.job_floor,
        ],
      )
    ).rows[0]?.n,
  );
  const unrecoverable = Boolean(unrecoverableJobError(error));
  if (!unrecoverable && failures < MAX_JOB_FAILURES) {
    await enqueueFor(client, read.specId, ticket, read.stage, read.round);
    return { status: "requeued", failures };
  }
  await client.query(
    "UPDATE final_e2e SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
    [round.id, unrecoverable ? JOB_FAILED : ENVIRONMENT_FAILED],
  );
  return { status: "blocked", failures };
}

// A person has looked at the blocked step and wants the e2e run again, on whatever the branches are now. The
// caller holds the spec lock. Returns whether there was a blocked step to retry.
export async function retryFinalE2e(
  client: pg.PoolClient,
  specId: number,
): Promise<boolean> {
  const round = await roundOf(client, specId);
  if (round?.state !== "blocked") return false;
  await client.query(
    `UPDATE final_e2e SET state = 'active', blocked_reason = NULL,
       job_floor = (SELECT COALESCE(max(id), 0) FROM jobs) WHERE id = $1`,
    [round.id],
  );
  await startRound(client, specId, round.round + 1);
  return true;
}

// A person lets the pull requests out although the e2e before them failed: the acceptance pack says so.
export async function waiveFinalE2e(
  pool: pg.Pool,
  specId: number,
): Promise<ActionResult<{ waived: true }>> {
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
    const round = await roundOf(client, specId);
    // a cancelled spec keeps its blocked row, but nothing is to be opened for it
    if (spec.rows[0]?.state !== "finalizing" || round?.state !== "blocked") {
      return {
        status: "refused",
        message: `${formatDisplayId("spec", specId)} has no blocked e2e to let through`,
      };
    }
    await client.query(
      "UPDATE final_e2e SET state = 'waived', blocked_reason = NULL WHERE id = $1",
      [round.id],
    );
    await recordAction(client, "waive-final", { specId });
    await startOpeningPullRequests(client, specId);
    return { status: "ok", waived: true };
  });
}
