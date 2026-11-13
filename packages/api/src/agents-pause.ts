import {
  isAgentProviderUnavailable,
  QUOTA_EXHAUSTED_BRIEF,
  unrecoverableJobError,
} from "@afk/shared";
import type pg from "pg";
import { recordSystemEvent } from "./events/system.ts";
import type { Queryable } from "./jobs/queue.ts";

// When the agents' provider refuses work (its usage ran out, it refuses the key), every agent job would fail the same
// way: retrying it three times and blocking the ticket only makes a person retry each ticket afterwards. Instead the
// failed job goes back to the queue as it was, no agent job is claimed until the agents are resumed, and the gates and
// merges that need no agent go on meanwhile.
//
// Usage comes back by itself, so a pause for it tries the provider again: after PROBE_FIRST_MINUTES one agent job is
// handed out (claimJob), and the wait doubles after each try up to PROBE_MAX_MINUTES. A probe that comes back with a
// result resumes the agents. A refused key does not mend itself: only a person resumes that pause.

export const AGENT_JOB_TYPE = "agent-run";
export const PROBE_FIRST_MINUTES = 15;
export const PROBE_MAX_MINUTES = 60;

export interface AgentsPause {
  since: string;
  reason: string;
  nextProbeAt: string | null; // null: it waits for a person
}

export async function agentsPause(
  pool: Queryable,
): Promise<AgentsPause | null> {
  const { rows } = await pool.query<{
    agents_paused_at: Date | null;
    agents_pause_reason: string | null;
    agents_probe_at: Date | null;
  }>(
    "SELECT agents_paused_at, agents_pause_reason, agents_probe_at FROM instance",
  );
  const row = rows[0];
  return row?.agents_paused_at
    ? {
        since: row.agents_paused_at.toISOString(),
        reason: row.agents_pause_reason ?? "",
        nextProbeAt: row.agents_probe_at?.toISOString() ?? null,
      }
    : null;
}

// A failed agent job whose error says the provider refuses work: its Run ends as provider-unavailable and lets go of
// the job, the job goes back to the queue under a new attempt, and the agents are paused. Returns undefined when they
// were already paused (or just paused, with a system event inserted); false when the failure is an ordinary one.
export async function pauseForProvider(
  client: pg.PoolClient,
  job: { id: number; type: string },
  error: string,
  now: Date,
): Promise<undefined | false> {
  if (job.type !== AGENT_JOB_TYPE || !isAgentProviderUnavailable(error))
    return false;
  // The Run keeps the failure, in the person's words, in the history; the job's next claim starts a Run of its own.
  const brief = unrecoverableJobError(error) ?? error;
  await client.query(
    `UPDATE runs SET job_id = NULL, finished_at = COALESCE(finished_at, now()), result = 'provider-unavailable',
       duration_ms = COALESCE(duration_ms, LEAST(extract(epoch FROM (now() - started_at)) * 1000, 2147483647)::int),
       output = jsonb_build_object('error', $2::text)
     WHERE job_id = $1`,
    [job.id, brief],
  );
  await client.query(
    `UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, error = NULL,
       attempt = attempt + 1
     WHERE id = $1`,
    [job.id],
  );
  const usage = brief === QUOTA_EXHAUSTED_BRIEF;
  const paused = await client.query(
    `UPDATE instance SET agents_paused_at = $1::timestamptz, agents_pause_reason = $2,
       agents_probe_at = CASE WHEN $3 THEN $1::timestamptz + make_interval(mins => $4) END,
       agents_probes = 0, agents_probe_job_id = NULL
     WHERE agents_paused_at IS NULL RETURNING 1`,
    [now, brief.slice(0, 1000), usage, PROBE_FIRST_MINUTES],
  );
  if (paused.rowCount === 0) {
    // a probe found the key refused this time: that pause waits for a person
    if (!usage)
      await client.query(
        `UPDATE instance SET agents_pause_reason = $1, agents_probe_at = NULL
         WHERE agents_paused_at IS NOT NULL`,
        [brief.slice(0, 1000)],
      );
    return undefined;
  }
  await recordSystemEvent(client, { kind: "agents-paused", reason: brief });
  return undefined;
}

// Called in the claim's transaction when an agent job was handed out: while paused that job is the probe, and the
// next one waits twice as long as the last wait (15, 30, 60 minutes, no longer than PROBE_MAX_MINUTES).
export async function probeHandedOut(
  client: Pick<pg.PoolClient, "query">,
  jobId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE instance SET agents_probes = agents_probes + 1, agents_probe_job_id = $1,
       agents_probe_at = $2::timestamptz
         + make_interval(mins => LEAST($3 * power(2, agents_probes + 1), $4)::int)
     WHERE agents_paused_at IS NOT NULL AND agents_probe_at IS NOT NULL`,
    [jobId, now, PROBE_FIRST_MINUTES, PROBE_MAX_MINUTES],
  );
}

// The agents take work again, starting with the jobs put back. With `probeJobId`, a job came back with a result and
// resumes them only when it was the probe (automatic); without, a person resumes them.
export async function resumeAgents(
  client: Pick<pg.PoolClient, "query">,
  now: Date,
  probeJobId?: number,
): Promise<boolean> {
  const { rows } = await client.query<{ since: Date }>(
    `WITH paused AS (SELECT agents_paused_at AS since FROM instance WHERE agents_paused_at IS NOT NULL FOR UPDATE)
     UPDATE instance SET agents_paused_at = NULL, agents_pause_reason = NULL, agents_probe_at = NULL,
       agents_probes = 0, agents_probe_job_id = NULL
     FROM paused WHERE ($1::int IS NULL OR agents_probe_job_id = $1)
     RETURNING paused.since`,
    [probeJobId ?? null],
  );
  const since = rows[0]?.since;
  if (!since) return false;
  await recordSystemEvent(client, {
    kind: "agents-resumed",
    automatic: probeJobId !== undefined,
    pausedMinutes: Math.round((now.getTime() - since.getTime()) / 60_000),
  });
  return true;
}
