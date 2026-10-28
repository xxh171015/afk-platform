import {
  type Capacity,
  formatDisplayId,
  type IncomingEdge,
  isRunnable,
  resolveLimits,
  type SpecState,
  specTransition,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import { ticketJobKey } from "../jobs/idempotency.ts";
import { enqueueJob } from "../jobs/queue.ts";

// Confirming a split and deciding which tickets may start (docs/design.md「依赖边什么时候算满足」,
// docs/specs/m1-platform.md「并发与预算默认值」). The scheduler is the only thing that moves a ticket from
// pending to queued; it re-runs after a confirmation, after a ticket is done, and after a human retry.

export interface ScheduledTicket {
  ticketId: number;
  displayId: string;
  jobId: number;
}

export interface ScheduleResult {
  enqueued: ScheduledTicket[];
  // Set when the spec's agent time ran out during this pass.
  paused: boolean;
}

export type ConfirmResult =
  | {
      status: "ok";
      state: SpecState;
      integrationBranches: { repoId: number; branch: string }[];
      enqueued: ScheduledTicket[];
    }
  | { status: "no-spec" }
  | { status: "not-confirmable"; message: string };

async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// draft -> planned -> running in one step, one integration branch (spec/<slug>) per repo the spec touches,
// then the first scheduling pass.
export async function confirmSpec(
  pool: pg.Pool,
  specId: number,
): Promise<ConfirmResult> {
  return inTransaction(pool, async (client) => {
    const spec = await client.query(
      "SELECT slug, state FROM specs WHERE id = $1 FOR UPDATE",
      [specId],
    );
    if (spec.rowCount === 0) return { status: "no-spec" };
    const { slug, state } = spec.rows[0] as { slug: string; state: SpecState };
    const planned = specTransition(state, "confirm-plan");
    if (!planned.ok) {
      return { status: "not-confirmable", message: planned.reason };
    }
    const repos = await client.query<{ repo_id: number }>(
      "SELECT DISTINCT repo_id FROM tickets WHERE spec_id = $1 ORDER BY repo_id",
      [specId],
    );
    if (repos.rowCount === 0) {
      return {
        status: "not-confirmable",
        message: `${formatDisplayId("spec", specId)} has no tickets to run`,
      };
    }
    const running = specTransition(planned.state, "start");
    if (!running.ok) throw new Error(running.reason);
    const integrationBranches = repos.rows.map((row) => ({
      repoId: row.repo_id,
      branch: `spec/${slug}`,
    }));
    await client.query(
      "UPDATE specs SET state = $2, integration_branches = $3 WHERE id = $1",
      [specId, running.state, JSON.stringify(integrationBranches)],
    );
    const scheduled = await schedulePass(client, specId);
    return {
      status: "ok",
      state: scheduled.paused ? "paused" : running.state,
      integrationBranches,
      enqueued: scheduled.enqueued,
    };
  });
}

// Recomputes which pending tickets of a running spec can start and queues an implement job for each.
// Safe to call at any time and any number of times: the spec row lock serialises passes, and a ticket that was
// queued is no longer pending.
export async function scheduleSpec(
  pool: pg.Pool,
  specId: number,
): Promise<ScheduleResult> {
  return inTransaction(pool, async (client) => {
    await client.query("SELECT 1 FROM specs WHERE id = $1 FOR UPDATE", [
      specId,
    ]);
    return schedulePass(client, specId);
  });
}

interface TicketRow {
  id: number;
  repo_id: number;
  state: TicketState;
  content_version: number;
  contract_sha: string | null;
}

async function schedulePass(
  client: pg.PoolClient,
  specId: number,
): Promise<ScheduleResult> {
  const none: ScheduleResult = { enqueued: [], paused: false };
  const spec = await client.query<{ state: SpecState; project_id: number }>(
    "SELECT state, project_id FROM specs WHERE id = $1",
    [specId],
  );
  const row = spec.rows[0];
  if (row?.state !== "running") return none;

  const project = await client.query(
    "SELECT limits, max_concurrency FROM projects WHERE id = $1",
    [row.project_id],
  );
  const limits = resolveLimits({
    ...(project.rows[0].max_concurrency
      ? { projectConcurrency: project.rows[0].max_concurrency }
      : {}),
    ...project.rows[0].limits,
  });

  if ((await agentSecondsUsed(client, specId)) >= limits.specAgentSeconds) {
    const paused = specTransition(row.state, "pause");
    if (!paused.ok) throw new Error(paused.reason);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      specId,
      paused.state,
    ]);
    return { enqueued: [], paused: true };
  }

  const tickets = await client.query<TicketRow>(
    "SELECT id, repo_id, state, content_version, contract_sha FROM tickets WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const byId = new Map(tickets.rows.map((ticket) => [ticket.id, ticket]));
  const edges = await client.query<{
    from_ticket_id: number;
    to_ticket_id: number;
    kind: "blocks" | "contract";
  }>(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind FROM edges e
     JOIN tickets t ON t.id = e.to_ticket_id WHERE t.spec_id = $1`,
    [specId],
  );
  const incoming = new Map<number, IncomingEdge[]>();
  for (const edge of edges.rows) {
    const blocker = byId.get(edge.from_ticket_id) as TicketRow;
    const list = incoming.get(edge.to_ticket_id) ?? [];
    list.push({
      kind: edge.kind,
      scope: "same-spec",
      blockerState: blocker.state,
      ...(blocker.contract_sha ? { contractSha: blocker.contract_sha } : {}),
    });
    incoming.set(edge.to_ticket_id, list);
  }

  const usage = await concurrencyInUse(client, row.project_id);
  const enqueued: ScheduledTicket[] = [];
  for (const ticket of tickets.rows) {
    if (ticket.state !== "pending") continue;
    const projectUsed = usage.project;
    const repoUsed = usage.repos.get(ticket.repo_id) ?? 0;
    const capacity: Capacity[] = [
      {
        scope: "project",
        resource: "concurrency",
        used: projectUsed,
        max: limits.projectConcurrency,
      },
      {
        scope: "repo",
        resource: "concurrency",
        used: repoUsed,
        max: limits.repoConcurrency,
      },
    ];
    const verdict = isRunnable({
      state: ticket.state,
      edges: incoming.get(ticket.id) ?? [],
      limits: capacity,
    });
    if (!verdict.runnable) continue;

    const queued = ticketTransition(ticket.state, { type: "enqueue" });
    if (!queued.ok) throw new Error(queued.reason);
    await client.query("UPDATE tickets SET state = $2 WHERE id = $1", [
      ticket.id,
      queued.state,
    ]);
    const { job } = await enqueueJob(client, {
      type: "agent-run",
      payload: {
        stage: "implement",
        ticketId: ticket.id,
        specId,
        repoId: ticket.repo_id,
        contentVersion: ticket.content_version,
      },
      idempotencyKey: ticketJobKey({
        ticketId: ticket.id,
        contentVersion: ticket.content_version,
        stage: "implement",
        sequence: await nextSequence(client, ticket, "implement"),
      }),
    });
    usage.project += 1;
    usage.repos.set(ticket.repo_id, repoUsed + 1);
    enqueued.push({
      ticketId: ticket.id,
      displayId: formatDisplayId("ticket", ticket.id),
      jobId: job.id,
    });
  }
  return { enqueued, paused: false };
}

// A retry queues the same stage again; the sequence number keeps its key distinct from the earlier attempts.
async function nextSequence(
  client: pg.PoolClient,
  ticket: TicketRow,
  stage: string,
): Promise<number> {
  const prefix = ticketJobKey({
    ticketId: ticket.id,
    contentVersion: ticket.content_version,
    stage,
    sequence: 1,
  }).replace(/1$/, "");
  const { rows } = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return Number(rows[0]?.n) + 1;
}

// A queued or running ticket holds an agent run, whatever spec it belongs to.
async function concurrencyInUse(client: pg.PoolClient, projectId: number) {
  const { rows } = await client.query<{ repo_id: number; used: string }>(
    `SELECT t.repo_id, count(*) AS used FROM tickets t JOIN specs s ON s.id = t.spec_id
     WHERE s.project_id = $1 AND t.state IN ('queued', 'running') GROUP BY t.repo_id`,
    [projectId],
  );
  const repos = new Map(rows.map((r) => [r.repo_id, Number(r.used)]));
  return {
    project: [...repos.values()].reduce((sum, used) => sum + used, 0),
    repos,
  };
}

async function agentSecondsUsed(
  client: pg.PoolClient,
  specId: number,
): Promise<number> {
  const { rows } = await client.query<{ ms: string }>(
    "SELECT COALESCE(sum(duration_ms), 0) AS ms FROM runs WHERE spec_id = $1",
    [specId],
  );
  return Number(rows[0]?.ms) / 1000;
}

export type CompleteTicketResult =
  | { status: "ok"; schedule: ScheduleResult }
  | { status: "no-ticket" }
  | { status: "not-mergeable"; message: string }
  | { status: "missing-contract-sha" };

// The merge stage's last step: the ticket is on the integration branch and its post-merge gate passed.
// A contract ticket records the integration branch head as the contract SHA, which is what satisfies its
// contract edges. Then the spec is scheduled again, because downstream tickets may now be free.
export async function completeTicket(
  pool: pg.Pool,
  ticketId: number,
  options: { contractSha?: string } = {},
): Promise<CompleteTicketResult> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{
      spec_id: number;
      state: TicketState;
      type: string;
    }>("SELECT spec_id, state, type FROM tickets WHERE id = $1", [ticketId]);
    const ticket = found.rows[0];
    if (!ticket) return { status: "no-ticket" };
    await client.query("SELECT 1 FROM specs WHERE id = $1 FOR UPDATE", [
      ticket.spec_id,
    ]);
    const current = await client.query<{ state: TicketState }>(
      "SELECT state FROM tickets WHERE id = $1",
      [ticketId],
    );
    const done = ticketTransition(current.rows[0]?.state ?? ticket.state, {
      type: "merge-succeeded",
    });
    if (!done.ok) return { status: "not-mergeable", message: done.reason };
    if (ticket.type === "contract" && !options.contractSha) {
      return { status: "missing-contract-sha" };
    }
    await client.query(
      "UPDATE tickets SET state = $2, contract_sha = $3 WHERE id = $1",
      [
        ticketId,
        done.state,
        ticket.type === "contract" ? (options.contractSha as string) : null,
      ],
    );
    return {
      status: "ok",
      schedule: await schedulePass(client, ticket.spec_id),
    };
  });
}
