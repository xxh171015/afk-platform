import {
  formatDisplayId,
  retryPlan,
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
    const plan = retryPlan(mode === "continue" ? "resume" : "restart");
    await client.query(
      `UPDATE tickets SET state = 'pending', blocked_reason = NULL, fix_counts = $2, reviewed = false, restart = $3
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
      "UPDATE tickets SET state = $2, blocked_reason = NULL, allowed_protected_paths = $3 WHERE id = $1",
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
