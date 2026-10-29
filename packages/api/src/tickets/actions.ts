import {
  formatDisplayId,
  retryPlan,
  type SpecState,
  specTransition,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import { enqueueStageJob } from "../jobs/stage-jobs.ts";
import {
  inTransaction,
  lockSpec,
  schedulePass,
} from "../scheduling/scheduler.ts";

// What a person can do with a blocked ticket (docs/design.md「blocked 处理」): try again, approve protected path
// changes, or cancel. Every action moves the ticket through the shared state machine, then lets the scheduler
// look at the spec again, since a ticket changing state can free a slot or a downstream ticket.

interface TicketRow {
  id: number;
  spec_id: number;
  repo_id: number;
  state: TicketState;
  blocked_reason: string | null;
  content_version: number;
  allowed_protected_paths: string[];
}

async function loadLocked(
  client: pg.PoolClient,
  ticketId: number,
): Promise<TicketRow | undefined> {
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  if (!found.rows[0]) return undefined;
  await lockSpec(client, found.rows[0].spec_id);
  const row = await client.query<TicketRow>(
    `SELECT id, spec_id, repo_id, state, blocked_reason, content_version, allowed_protected_paths
     FROM tickets WHERE id = $1`,
    [ticketId],
  );
  return row.rows[0];
}

export type ActionResult<T> =
  | ({ status: "ok" } & T)
  | { status: "no-ticket" }
  | { status: "refused"; message: string };

const refused = (message: string) => ({ status: "refused", message }) as const;

export type RetryMode = "continue" | "restart";

// continue keeps the branch and its commits; restart starts again from the integration branch. Either way the
// fix counts and the review start over, and the ticket goes back to pending for the scheduler.
export async function retryTicket(
  pool: pg.Pool,
  ticketId: number,
  mode: RetryMode,
): Promise<ActionResult<{ state: TicketState }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    const next = ticketTransition(ticket.state, { type: "retry" });
    if (!next.ok) return refused(next.reason);
    if (ticket.blocked_reason === "upstream-cancelled") {
      // Back to pending it would wait for a ticket that is gone, for ever.
      const gone = await client.query<{ id: number }>(
        `SELECT u.id FROM edges e JOIN tickets u ON u.id = e.from_ticket_id
         WHERE e.to_ticket_id = $1 AND u.state = 'cancelled'`,
        [ticketId],
      );
      if (gone.rows.length > 0) {
        return refused(
          `${formatDisplayId("ticket", ticketId)} waits for ${gone.rows.map((r) => formatDisplayId("ticket", r.id)).join(", ")}, which was cancelled: cancel this ticket too, or import a replacement`,
        );
      }
    }
    const plan = retryPlan(mode === "continue" ? "resume" : "restart");
    await client.query(
      `UPDATE tickets SET state = 'pending', blocked_reason = NULL, fix_counts = $2, reviewed = false, restart = $3,
         job_floor = (SELECT COALESCE(max(id), 0) FROM jobs)
       WHERE id = $1`,
      [ticketId, JSON.stringify(plan.fixCounts), plan.deleteBranch],
    );
    await schedulePass(client, ticket.spec_id);
    const after = await client.query<{ state: TicketState }>(
      "SELECT state FROM tickets WHERE id = $1",
      [ticketId],
    );
    return { status: "ok", state: after.rows[0]?.state as TicketState };
  });
}

// Only for protected-path-changed: the paths the gate found are added to the ticket's approved paths and the
// ticket goes on from the gate.
export async function approveProtected(
  pool: pg.Pool,
  ticketId: number,
): Promise<ActionResult<{ approved: string[] }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    if (
      ticket.state !== "blocked" ||
      ticket.blocked_reason !== "protected-path-changed"
    ) {
      return refused(
        `only a ticket blocked by protected-path-changed can be approved; this one is ${ticket.state}${ticket.blocked_reason ? ` (${ticket.blocked_reason})` : ""}`,
      );
    }
    const gate = await client.query<{ unapproved: string[] | null }>(
      `SELECT output->'unapproved' AS unapproved FROM runs
       WHERE ticket_id = $1 AND stage = 'gate' AND result = 'protected-path-changed' ORDER BY id DESC LIMIT 1`,
      [ticketId],
    );
    const approved = gate.rows[0]?.unapproved;
    if (!approved || approved.length === 0) {
      return refused(
        "the gate run that found the protected paths has no record of which ones they were",
      );
    }
    const next = ticketTransition(ticket.state, { type: "approve-protected" });
    if (!next.ok || next.state === "blocked")
      return refused(next.ok ? "unexpected" : next.reason);
    const allowed = [
      ...new Set([...ticket.allowed_protected_paths, ...approved]),
    ];
    await client.query(
      "UPDATE tickets SET state = $2, blocked_reason = NULL, allowed_protected_paths = $3,\n         job_floor = (SELECT COALESCE(max(id), 0) FROM jobs) WHERE id = $1",
      [ticketId, next.state, allowed],
    );
    await enqueueStageJob(
      client,
      {
        id: ticket.id,
        specId: ticket.spec_id,
        repoId: ticket.repo_id,
        contentVersion: ticket.content_version,
      },
      "gate",
    );
    return { status: "ok", approved };
  });
}

// For any blocked ticket: more paths are added to its approved ones, for the next run. The ticket stays blocked;
// a retry is a separate decision. (The route checks the paths like the import's `protected_paths_ok`: non-empty text.)
export async function allowPaths(
  pool: pg.Pool,
  ticketId: number,
  paths: string[],
): Promise<ActionResult<{ allowed: string[] }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    if (ticket.state !== "blocked") {
      return refused(
        `only a blocked ticket can be given more protected paths; this one is ${ticket.state}`,
      );
    }
    const allowed = [...new Set([...ticket.allowed_protected_paths, ...paths])];
    await client.query(
      "UPDATE tickets SET allowed_protected_paths = $2 WHERE id = $1",
      [ticketId, allowed],
    );
    return { status: "ok", allowed };
  });
}

export interface CancelOutcome {
  cancelled: string[]; // display ids
  blocked: string[]; // downstream tickets put into blocked (upstream-cancelled)
  skipped: string[]; // downstream tickets that could not be touched because they are already under way
}

// By default the tickets that waited for this one go to blocked (upstream-cancelled), so a person decides what
// becomes of them; with cascade everything downstream is cancelled too.
export async function cancelTicket(
  pool: pg.Pool,
  ticketId: number,
  cascade: boolean,
): Promise<ActionResult<CancelOutcome>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    const cancelled = ticketTransition(ticket.state, { type: "cancel" });
    if (!cancelled.ok)
      return refused(
        `${cancelled.reason} (only a pending or blocked ticket can be cancelled)`,
      );

    const outcome: CancelOutcome = {
      cancelled: [formatDisplayId("ticket", ticketId)],
      blocked: [],
      skipped: [],
    };
    await client.query(
      "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = $1",
      [ticketId],
    );

    const edges = await client.query<{
      from_ticket_id: number;
      to_ticket_id: number;
    }>(
      `SELECT e.from_ticket_id, e.to_ticket_id FROM edges e JOIN tickets t ON t.id = e.to_ticket_id WHERE t.spec_id = $1`,
      [ticket.spec_id],
    );
    const below = new Map<number, number[]>();
    for (const edge of edges.rows)
      below.set(edge.from_ticket_id, [
        ...(below.get(edge.from_ticket_id) ?? []),
        edge.to_ticket_id,
      ]);
    const states = new Map(
      (
        await client.query<{ id: number; state: TicketState }>(
          "SELECT id, state FROM tickets WHERE spec_id = $1",
          [ticket.spec_id],
        )
      ).rows.map((row) => [row.id, row.state]),
    );

    // direct downstream, or everything below when cascading
    const queue = [...(below.get(ticketId) ?? [])];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const id = queue.shift() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = states.get(id) as TicketState;
      const display = formatDisplayId("ticket", id);
      if (cascade) {
        const next = ticketTransition(state, { type: "cancel" });
        if (next.ok) {
          await client.query(
            "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = $1",
            [id],
          );
          outcome.cancelled.push(display);
        } else if (state !== "cancelled" && state !== "done") {
          outcome.skipped.push(display);
        }
        queue.push(...(below.get(id) ?? []));
      } else {
        const next = ticketTransition(state, {
          type: "block",
          reason: "upstream-cancelled",
        });
        if (
          !next.ok &&
          state !== "blocked" &&
          state !== "cancelled" &&
          state !== "done"
        ) {
          outcome.skipped.push(display); // already under way: not ours to stop
        }
        if (next.ok) {
          await client.query(
            "UPDATE tickets SET state = 'blocked', blocked_reason = 'upstream-cancelled' WHERE id = $1",
            [id],
          );
          outcome.blocked.push(display);
        }
      }
    }
    await schedulePass(client, ticket.spec_id);
    return { status: "ok", ...outcome };
  });
}

// The spec's state once its lock is held, so it cannot change under the caller; undefined for an unknown spec.
async function lockedSpecState(
  client: pg.PoolClient,
  specId: number,
): Promise<SpecState | undefined> {
  const found = await client.query("SELECT 1 FROM specs WHERE id = $1", [
    specId,
  ]);
  if (!found.rows[0]) return undefined;
  await lockSpec(client, specId);
  const current = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  return current.rows[0]?.state;
}

// A spec the platform paused (its agent time ran out) goes on after a person says how much more it may use.
export async function resumeSpec(
  pool: pg.Pool,
  specId: number,
  extraSeconds: number,
): Promise<ActionResult<{ state: SpecState }>> {
  return inTransaction(pool, async (client) => {
    const state = await lockedSpecState(client, specId);
    if (!state) return { status: "no-ticket" };
    const next = specTransition(state, "resume");
    if (!next.ok) return refused(next.reason);
    await client.query(
      "UPDATE specs SET state = $2, pause_reason = NULL, budget_extra_seconds = budget_extra_seconds + $3 WHERE id = $1",
      [specId, next.state, extraSeconds],
    );
    await schedulePass(client, specId);
    const after = await client.query<{ state: SpecState }>(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    return { status: "ok", state: after.rows[0]?.state as SpecState };
  });
}

// The whole spec is given up. Every ticket that has not finished is cancelled (one under way too), the jobs of the
// spec are failed so nothing more is claimed and a worker still holding one learns on its next call that it no
// longer does, and their Runs are closed. Done tickets and what was already merged stay as they are.
// A pull request the platform last saw open; the repo is named by its role in the project.
export interface OpenPullRequest {
  repo: string;
  number: number;
  url: string;
}

export async function cancelSpec(
  pool: pg.Pool,
  specId: number,
): Promise<
  ActionResult<{
    state: SpecState;
    cancelled: string[];
    pullRequests: OpenPullRequest[];
  }>
> {
  return inTransaction(pool, async (client) => {
    const state = await lockedSpecState(client, specId);
    if (!state) return { status: "no-ticket" };
    const next = specTransition(state, "cancel");
    if (!next.ok)
      return refused(`${next.reason}: a merged or cancelled spec is final`);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      specId,
      next.state,
    ]);

    const tickets = await client.query<{ id: number; state: TicketState }>(
      "SELECT id, state FROM tickets WHERE spec_id = $1 ORDER BY id",
      [specId],
    );
    const cancelled: number[] = [];
    for (const ticket of tickets.rows) {
      if (ticketTransition(ticket.state, { type: "spec-cancelled" }).ok)
        cancelled.push(ticket.id);
    }
    if (cancelled.length > 0) {
      await client.query(
        "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = ANY($1)",
        [cancelled],
      );
    }
    // Every kind of job names its spec in the payload: stages, final steps, open-pr.
    await client.query(
      `UPDATE jobs SET state = 'failed', error = 'the spec was cancelled', lease_owner = NULL, lease_expires_at = NULL
       WHERE state IN ('queued', 'running') AND (payload->>'specId')::int = $1`,
      [specId],
    );
    await client.query(
      `UPDATE runs SET finished_at = now(), result = 'cancelled',
         duration_ms = LEAST(extract(epoch FROM (now() - started_at)) * 1000, 2147483647)::int,
         output = jsonb_build_object('error', 'the spec was cancelled')
       WHERE spec_id = $1 AND finished_at IS NULL`,
      [specId],
    );
    // The platform never closes a pull request: the ones it last saw open are handed to the person.
    const open = await client.query<OpenPullRequest>(
      `SELECT r.role AS repo, p.number, p.url FROM pull_requests p JOIN repos r ON r.id = p.repo_id
       WHERE p.spec_id = $1 AND p.state = 'open' ORDER BY p.id`,
      [specId],
    );
    return {
      status: "ok",
      state: next.state,
      cancelled: cancelled.map((id) => formatDisplayId("ticket", id)),
      pullRequests: open.rows,
    };
  });
}
