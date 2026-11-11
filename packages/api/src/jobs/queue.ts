import type { JobState } from "@afk/shared";
import type pg from "pg";
import { applyOrigin } from "../events/origin.ts";

// The job queue lives on the `jobs` table (docs/specs/m1-platform.md「作业队列」).
// Every function takes `now` so lease expiry is decided by the caller's clock, not by waiting.

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  state: JobState;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attempt: number; // fencing token: bumped each time an expired lease is taken back
  idempotencyKey: string;
  lockKey: string | null;
  requiredCapabilities: string[];
  result: unknown;
  error: string | null;
}

// A job a worker holds: the lease fields are always set while it is running.
export type LeasedJob = Job & { leaseOwner: string; leaseExpiresAt: Date };

export interface NewJob {
  type: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  lockKey?: string;
  requiredCapabilities?: string[];
  notBefore?: Date; // not claimable before this time
}

const COLUMNS = `id, type, payload, state, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
  attempt, idempotency_key AS "idempotencyKey", lock_key AS "lockKey", required_capabilities AS "requiredCapabilities", result, error`;

// Either a pool or a client inside a transaction.
export type Queryable = Pick<pg.Pool, "query">;

export async function enqueueJob(
  pool: Queryable,
  job: NewJob,
): Promise<{ job: Job; created: boolean }> {
  const inserted = await pool.query<Job>(
    `INSERT INTO jobs (type, payload, idempotency_key, lock_key, required_capabilities, not_before)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      job.type,
      JSON.stringify(job.payload ?? {}),
      job.idempotencyKey,
      job.lockKey ?? null,
      job.requiredCapabilities ?? [],
      job.notBefore ?? null,
    ],
  );
  if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
  const existing = await pool.query<Job>(
    `SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`,
    [job.idempotencyKey],
  );
  return { job: existing.rows[0] as Job, created: false };
}

export interface ClaimRequest {
  workerId: string;
  capabilities: string[];
  now: Date;
  leaseSeconds: number;
}

// A job belongs to a project through whatever id its payload carries (host-sync has projectId, most
// others specId / ticketId / repoId / pullId). Jobs with none of those stay unattributed and keep FIFO.
const JOB_PROJECT_ID = `(
  SELECT COALESCE(
    (j.payload->>'projectId')::int,
    (SELECT s.project_id FROM specs s WHERE s.id = (j.payload->>'specId')::int),
    (SELECT s.project_id FROM tickets t JOIN specs s ON s.id = t.spec_id
      WHERE t.id = (j.payload->>'ticketId')::int),
    (SELECT r.project_id FROM repos r WHERE r.id = (j.payload->>'repoId')::int),
    (SELECT s.project_id FROM pull_requests pr JOIN specs s ON s.id = pr.spec_id
      WHERE pr.id = (j.payload->>'pullId')::int)
  )
)`;

export async function claimJob(
  pool: pg.Pool,
  request: ClaimRequest,
): Promise<LeasedJob | null> {
  const leaseExpiresAt = new Date(
    request.now.getTime() + request.leaseSeconds * 1000,
  );
  const client = await pool.connect();
  let broken: Error | undefined; // a connection whose ROLLBACK failed must not go back to the pool
  try {
    await client.query("BEGIN");
    await applyOrigin(client);
    // Claims of one worker's slots must see each other's last_claimed_at, or both slots take the same
    // project's pile. Transaction-scoped, so PgBouncer in transaction mode is fine.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('afk-job-claim'))",
    );
    // A lease that ran out puts the job back in the queue; the bumped attempt shuts the old holder out.
    await client.query(
      `UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, attempt = attempt + 1
       WHERE state = 'running' AND lease_expires_at <= $1`,
      [request.now],
    );
    const { rows } = await client.query<Job>(
      `UPDATE jobs SET state = 'running', lease_owner = $1, lease_expires_at = $2
       WHERE id = (SELECT j.id FROM jobs j
         LEFT JOIN projects p ON p.id = ${JOB_PROJECT_ID}
         WHERE j.state = 'queued'
           AND (j.not_before IS NULL OR j.not_before <= $4)
           AND j.required_capabilities <@ $3::text[]
           -- while the agents' provider refuses work, no agent job is handed out (agents-pause.ts)
           AND NOT (j.type = 'agent-run' AND EXISTS (SELECT 1 FROM instance WHERE agents_paused_at IS NOT NULL))
           AND (j.lock_key IS NULL OR (
             -- the key is free: nobody holds a live lease on it ...
             NOT EXISTS (SELECT 1 FROM jobs h WHERE h.lock_key = j.lock_key AND h.state = 'running' AND h.lease_expires_at > $4)
             -- ... and nothing older is still waiting for it (first in, first out)
             AND NOT EXISTS (SELECT 1 FROM jobs e WHERE e.lock_key = j.lock_key AND e.state = 'queued' AND e.id < j.id)))
         ORDER BY COALESCE(p.last_claimed_at, '-infinity'::timestamptz), j.id
         FOR UPDATE OF j SKIP LOCKED LIMIT 1)
       RETURNING ${COLUMNS}`,
      [request.workerId, leaseExpiresAt, request.capabilities, request.now],
    );
    const job = (rows[0] as LeasedJob | undefined) ?? null;
    if (job) {
      await client.query(
        `UPDATE projects SET last_claimed_at = $2
         WHERE id = (SELECT ${JOB_PROJECT_ID} FROM jobs j WHERE j.id = $1)`,
        [job.id, request.now],
      );
    }
    await client.query("COMMIT");
    return job;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

// What a worker's call about a job it claims to hold can turn out to be.
export type HolderOutcome<T = object> =
  | ({ status: "ok" } & T)
  | { status: "stale" }
  | { status: "not-found" };

export interface HolderCall {
  jobId: number;
  workerId: string;
  attempt: number;
  now: Date;
}

// The fencing rule: only the worker that holds the live lease, at the current attempt, may act on the job.
const HOLDS_LEASE = `id = $1 AND state = 'running' AND lease_owner = $2 AND attempt = $3 AND lease_expires_at > $4`;

async function classify(
  pool: Queryable,
  jobId: number,
): Promise<"stale" | "not-found"> {
  const { rowCount } = await pool.query("SELECT 1 FROM jobs WHERE id = $1", [
    jobId,
  ]);
  return rowCount ? "stale" : "not-found";
}

export async function heartbeat(
  pool: pg.Pool,
  call: HolderCall & { leaseSeconds: number },
): Promise<HolderOutcome<{ leaseExpiresAt: Date }>> {
  const leaseExpiresAt = new Date(
    call.now.getTime() + call.leaseSeconds * 1000,
  );
  const { rows } = await pool.query(
    `UPDATE jobs SET lease_expires_at = $5 WHERE ${HOLDS_LEASE} RETURNING id`,
    [call.jobId, call.workerId, call.attempt, call.now, leaseExpiresAt],
  );
  if (rows[0]) return { status: "ok", leaseExpiresAt };
  return { status: await classify(pool, call.jobId) };
}

// Before pushing the integration branch the worker re-checks it still holds the job, and that check renews
// the lease too (docs/design.md「作业与恢复」: 校验 (作业号, attempt) 仍是当前持有者并续期).
export const checkBeforePush = heartbeat;

async function finish(
  pool: Queryable,
  call: HolderCall,
  state: "done" | "failed",
  result: unknown,
  error: string | null,
): Promise<HolderOutcome> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET state = $5, result = $6, error = $7, lease_owner = NULL, lease_expires_at = NULL WHERE ${HOLDS_LEASE}`,
    [
      call.jobId,
      call.workerId,
      call.attempt,
      call.now,
      state,
      result == null ? null : JSON.stringify(result),
      error,
    ],
  );
  if (rowCount) return { status: "ok" };
  return { status: await classify(pool, call.jobId) };
}

// A complete or fail that arrives twice (the first reply was lost) gets a 409 the second time: the job is already
// finished and the lease is gone, so the fencing check cannot tell it from a stale holder.
export const completeJob = (
  pool: Queryable,
  call: HolderCall,
  result: unknown,
) => finish(pool, call, "done", result, null);
export const failJob = (pool: Queryable, call: HolderCall, error: string) =>
  finish(pool, call, "failed", null, error);

// Put a finished job back in the queue (host-sync: the same row looks again a minute later). The attempt is
// bumped so a complete from the look that just finished cannot be retried against the next one: fencing is the
// job id and the attempt together, and host-sync keeps the id.
export async function requeueJob(
  pool: Queryable,
  jobId: number,
  notBefore: Date | null,
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET state = 'queued', not_before = $2, lease_owner = NULL, lease_expires_at = NULL,
       result = NULL, error = NULL, attempt = attempt + 1
     WHERE id = $1 AND state IN ('done', 'failed')`,
    [jobId, notBefore],
  );
}

// A read-only version of the fencing check, for calls that must not renew the lease.
export async function checkHolder(
  pool: Queryable,
  call: HolderCall,
): Promise<HolderOutcome> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM jobs WHERE ${HOLDS_LEASE}`,
    [call.jobId, call.workerId, call.attempt, call.now],
  );
  return rowCount
    ? { status: "ok" }
    : { status: await classify(pool, call.jobId) };
}

// Does anyone hold the live lease of this job at this attempt? For a worker deciding whether a slot's lock belongs
// to a zombie; it does not say who holds it and does not renew anything.
export async function isLeaseLive(
  pool: Queryable,
  call: { jobId: number; attempt: number; now: Date },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM jobs WHERE id = $1 AND state = 'running' AND attempt = $2 AND lease_expires_at > $3",
    [call.jobId, call.attempt, call.now],
  );
  return rowCount === 1;
}
