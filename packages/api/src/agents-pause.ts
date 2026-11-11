import { isAgentProviderUnavailable, unrecoverableJobError } from "@afk/shared";
import type pg from "pg";
import type { Queryable } from "./jobs/queue.ts";
import type { Notice } from "./notify/notices.ts";
import { pageUrl } from "./page-url.ts";

// When the agents' provider refuses work (its usage ran out, it refuses the key), every agent job would fail the same
// way: retrying it three times and blocking the ticket only makes a person retry each ticket afterwards. Instead the
// failed job goes back to the queue as it was, no agent job is claimed until a person resumes them, and the gates and
// merges that need no agent go on meanwhile.

export const AGENT_JOB_TYPE = "agent-run";

export interface AgentsPause {
  since: string;
  reason: string;
}

export async function agentsPause(
  pool: Queryable,
): Promise<AgentsPause | null> {
  const { rows } = await pool.query<{
    agents_paused_at: Date | null;
    agents_pause_reason: string | null;
  }>("SELECT agents_paused_at, agents_pause_reason FROM instance");
  const row = rows[0];
  return row?.agents_paused_at
    ? {
        since: row.agents_paused_at.toISOString(),
        reason: row.agents_pause_reason ?? "",
      }
    : null;
}

// A failed agent job whose error says the provider refuses work: its Run ends as provider-unavailable and lets go of
// the job, the job goes back to the queue under a new attempt, and the agents are paused. Returns the notice to send
// when this is what paused them, undefined when it was already paused; false when the failure is an ordinary one.
export async function pauseForProvider(
  client: pg.PoolClient,
  job: { id: number; type: string },
  error: string,
  now: Date,
): Promise<Notice | undefined | false> {
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
  const paused = await client.query(
    `UPDATE instance SET agents_paused_at = $1::timestamptz, agents_pause_reason = $2
     WHERE agents_paused_at IS NULL RETURNING 1`,
    [now, brief.slice(0, 1000)],
  );
  if (paused.rowCount === 0) return undefined;
  return {
    title: "Agent 已暂停",
    body: `${brief}\n恢复后在页面上点「恢复」，或运行 plat agents resume\n${pageUrl("/")}`,
  };
}

// A person says the provider takes work again: agent jobs are claimed again, starting with the ones put back.
export async function resumeAgents(pool: Queryable): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE instance SET agents_paused_at = NULL, agents_pause_reason = NULL
     WHERE agents_paused_at IS NOT NULL`,
  );
  return (rowCount ?? 0) > 0;
}
