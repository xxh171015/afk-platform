import { STAGES, type Stage } from "@afk/shared";
import type pg from "pg";
import { ticketJobKey, ticketJobKeyPrefix } from "./idempotency.ts";
import { enqueueJob, type Job } from "./queue.ts";

export interface StageTicket {
  id: number;
  specId: number;
  repoId: number;
  contentVersion: number;
}

// Agent runs and gates are free-floating; a merge holds the integration branch's lock for its whole lease
// (docs/specs/m1-platform.md「作业队列」: integration:<仓库>:<spec/slug>).
function jobType(stage: Stage): string {
  if (stage === "merge") return "merge";
  if (stage === "gate") return "gate";
  return "agent-run";
}

// The payload of a ticket stage job, read back; undefined for any other kind of job.
export function readStagePayload(
  payload: Record<string, unknown>,
): { ticketId: number; stage: Stage; contentVersion: unknown } | undefined {
  const { ticketId, stage, contentVersion } = payload;
  if (typeof ticketId !== "number" || !isStage(stage)) return undefined;
  return { ticketId, stage, contentVersion };
}

const isStage = (value: unknown): value is Stage =>
  typeof value === "string" && (STAGES as readonly string[]).includes(value);

// Queues one stage of a ticket. A stage that runs again (a retry, a second gate after a fix) gets the next
// sequence number, so its idempotency key never collides with the earlier job.
export async function enqueueStageJob(
  client: pg.PoolClient,
  ticket: StageTicket,
  stage: Stage,
): Promise<Job> {
  const prefix = ticketJobKeyPrefix({
    ticketId: ticket.id,
    contentVersion: ticket.contentVersion,
    stage,
  });
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  let lockKey: string | undefined;
  if (stage === "merge") {
    const { rows } = await client.query<{ slug: string }>(
      "SELECT slug FROM specs WHERE id = $1",
      [ticket.specId],
    );
    // One lock per integration branch: the repo (by id, so two projects never share a key) and the branch.
    lockKey = `integration:${ticket.repoId}:spec/${rows[0]?.slug}`;
  }
  const { job } = await enqueueJob(client, {
    type: jobType(stage),
    payload: {
      stage,
      ticketId: ticket.id,
      specId: ticket.specId,
      repoId: ticket.repoId,
      contentVersion: ticket.contentVersion,
    },
    idempotencyKey: ticketJobKey({
      ticketId: ticket.id,
      contentVersion: ticket.contentVersion,
      stage,
      sequence: Number(earlier.rows[0]?.n) + 1,
    }),
    ...(lockKey ? { lockKey } : {}),
  });
  return job;
}
