import { formatDisplayId } from "@afk/shared";
import type pg from "pg";

// Computed each time the waiting queue is read: what an item blocks, and how long it has waited.
// Nothing is stored (docs/optimization-plan.md §1.1; issue #186).

export interface Blocking {
  downstream: string[];
  finalization: boolean;
  pullRequests: boolean;
  spec: boolean;
  merge: boolean;
}

export const NO_BLOCKING: Blocking = {
  downstream: [],
  finalization: false,
  pullRequests: false,
  spec: false,
  merge: false,
};

export type WaitingRef =
  | { kind: "ticket"; id: number }
  | { kind: "finalization"; id: number; step: string }
  | { kind: "pullRequest"; specId: number; repo: string; number: number }
  | { kind: "cleanup"; specId: number }
  | { kind: "readyFailure"; specId: number; repo: string; number: number }
  | { kind: "planning"; specId: number }
  | { kind: "pausedSpec"; id: number };

export interface WaitingFields {
  waitingSince: string;
  blocking: Blocking;
}

export function rankOf(blocking: Blocking): number {
  if (blocking.downstream.length > 0) return 0;
  if (blocking.finalization || blocking.pullRequests) return 1;
  if (blocking.spec || blocking.merge) return 2;
  return 3;
}

export function compareWaiting(
  a: { blocking: Blocking; waitingSince: string; serialId: number },
  b: { blocking: Blocking; waitingSince: string; serialId: number },
): number {
  const ranks = rankOf(a.blocking) - rankOf(b.blocking);
  if (ranks !== 0) return ranks;
  const waited = a.waitingSince.localeCompare(b.waitingSince);
  if (waited !== 0) return waited;
  return a.serialId - b.serialId;
}

function iso(value: Date | string | null | undefined, fallback: Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

async function timesById(
  pool: pg.Pool,
  sql: string,
  ids: number[],
): Promise<Map<number, Date>> {
  const map = new Map<number, Date>();
  if (ids.length === 0) return map;
  const { rows } = await pool.query(sql, [ids]);
  for (const row of rows) {
    const id = Number(row.id);
    const at = row.at as Date | null;
    if (Number.isFinite(id) && at) map.set(id, at);
  }
  return map;
}

async function downstreamByTicket(
  pool: pg.Pool,
  ticketIds: number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (ticketIds.length === 0) return map;
  const { rows } = await pool.query<{ source: number; id: number }>(
    `WITH RECURSIVE walk AS (
       SELECT e.from_ticket_id AS source, t.id, t.state
       FROM edges e
       JOIN tickets src ON src.id = e.from_ticket_id
       JOIN tickets t ON t.id = e.to_ticket_id AND t.spec_id = src.spec_id
       WHERE e.from_ticket_id = ANY($1)
       UNION
       SELECT w.source, t.id, t.state
       FROM walk w
       JOIN tickets src ON src.id = w.source
       JOIN edges e ON e.from_ticket_id = w.id
       JOIN tickets t ON t.id = e.to_ticket_id AND t.spec_id = src.spec_id
     )
     SELECT source, id FROM walk
     WHERE state NOT IN ('done', 'cancelled')
     ORDER BY source, id`,
    [ticketIds],
  );
  for (const row of rows) {
    const list = map.get(row.source) ?? [];
    const displayId = formatDisplayId("ticket", row.id);
    if (!list.includes(displayId)) list.push(displayId);
    map.set(row.source, list);
  }
  return map;
}

export interface RankableQueue {
  tickets: {
    id: number;
    specId: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  finalizations: {
    id: number;
    specId: number;
    step: string;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  pullRequests: {
    specId: number;
    repo: string;
    number: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  cleanups: {
    specId: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  readyFailures: {
    specId: number;
    repo: string;
    number: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  planning: {
    specId: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
  specs: {
    id: number;
    waitingSince?: string;
    blocking?: Blocking;
  }[];
}

export async function rankWaitingQueue<Q extends RankableQueue>(
  pool: pg.Pool,
  queue: Q,
): Promise<Q & { items: WaitingRef[] }> {
  const ticketIds = queue.tickets.map((ticket) => ticket.id);
  const specIds = [
    ...new Set([
      ...queue.tickets.map((ticket) => ticket.specId),
      ...queue.finalizations.map((item) => item.specId),
      ...queue.pullRequests.map((item) => item.specId),
      ...queue.cleanups.map((item) => item.specId),
      ...queue.readyFailures.map((item) => item.specId),
      ...queue.planning.map((item) => item.specId),
      ...queue.specs.map((item) => item.id),
    ]),
  ];
  const finalizationIds = queue.finalizations.map((item) => item.id);

  const [
    ticketCreated,
    ticketFinished,
    specCreated,
    specFinished,
    finalCreated,
    finalFinished,
    e2eFinished,
    openBySpec,
    downstreamById,
    pullTimes,
    cleanupTimes,
    readyTimes,
  ] = await Promise.all([
    timesById(
      pool,
      "SELECT id, created_at AS at FROM tickets WHERE id = ANY($1)",
      ticketIds,
    ),
    timesById(
      pool,
      `SELECT ticket_id AS id, MAX(finished_at) AS at FROM runs
       WHERE ticket_id = ANY($1) AND finished_at IS NOT NULL GROUP BY ticket_id`,
      ticketIds,
    ),
    timesById(
      pool,
      "SELECT id, created_at AS at FROM specs WHERE id = ANY($1)",
      specIds,
    ),
    timesById(
      pool,
      `SELECT spec_id AS id, MAX(finished_at) AS at FROM runs
       WHERE spec_id = ANY($1) AND finished_at IS NOT NULL GROUP BY spec_id`,
      specIds,
    ),
    timesById(
      pool,
      `SELECT id, created_at AS at FROM (
         SELECT id, created_at FROM finalizations WHERE id = ANY($1)
         UNION ALL
         SELECT id, created_at FROM final_e2e WHERE id = ANY($1)
       ) s`,
      finalizationIds,
    ),
    timesById(
      pool,
      `SELECT spec_id AS id, MAX(finished_at) AS at FROM runs
       WHERE spec_id = ANY($1) AND ticket_id IS NULL AND finished_at IS NOT NULL
       GROUP BY spec_id`,
      specIds,
    ),
    timesById(
      pool,
      `SELECT t.spec_id AS id, MAX(r.finished_at) AS at
       FROM runs r JOIN tickets t ON t.id = r.ticket_id
       WHERE t.spec_id = ANY($1) AND r.stage IN ('e2e', 'diagnose')
         AND r.finished_at IS NOT NULL
       GROUP BY t.spec_id`,
      specIds,
    ),
    (async () => {
      const map = new Map<number, number>();
      if (specIds.length === 0) return map;
      const { rows } = await pool.query<{ spec_id: number; open: string }>(
        `SELECT spec_id, count(*) FILTER (WHERE state NOT IN ('done', 'cancelled'))::text AS open
         FROM tickets WHERE spec_id = ANY($1) GROUP BY spec_id`,
        [specIds],
      );
      for (const row of rows) map.set(row.spec_id, Number(row.open));
      return map;
    })(),
    downstreamByTicket(pool, ticketIds),
    (async () => {
      const map = new Map<string, Date>();
      if (queue.pullRequests.length === 0 && queue.readyFailures.length === 0)
        return map;
      const { rows } = await pool.query<{
        spec_id: number;
        repo: string;
        number: number;
        created_at: Date;
        synced_at: Date | null;
      }>(
        `SELECT p.spec_id, r.name AS repo, p.number, p.created_at, p.synced_at
         FROM pull_requests p JOIN repos r ON r.id = p.repo_id
         WHERE p.spec_id = ANY($1)`,
        [specIds],
      );
      for (const row of rows) {
        map.set(
          `${row.spec_id}:${row.repo}:${row.number}`,
          row.synced_at ?? row.created_at,
        );
      }
      return map;
    })(),
    timesById(
      pool,
      `SELECT spec_id AS id, created_at AS at FROM (
         SELECT DISTINCT ON (spec_id) (payload->>'specId')::int AS spec_id, created_at, id
         FROM jobs WHERE type = 'spec-cleanup' AND state = 'failed'
         ORDER BY spec_id, id DESC
       ) j WHERE spec_id = ANY($1)`,
      queue.cleanups.map((item) => item.specId),
    ),
    (async () => {
      const map = new Map<string, Date>();
      if (queue.readyFailures.length === 0) return map;
      const { rows } = await pool.query<{
        spec_id: number;
        repo: string;
        number: number;
        created_at: Date;
      }>(
        `SELECT DISTINCT ON (p.id) p.spec_id, r.name AS repo, p.number, j.created_at
         FROM jobs j
         JOIN pull_requests p ON p.id = (j.payload->>'pullId')::int
         JOIN repos r ON r.id = p.repo_id
         WHERE j.type = 'pr-ready' AND j.state = 'failed' AND p.spec_id = ANY($1)
         ORDER BY p.id, j.id DESC`,
        [specIds],
      );
      for (const row of rows) {
        map.set(`${row.spec_id}:${row.repo}:${row.number}`, row.created_at);
      }
      return map;
    })(),
  ]);

  const now = new Date();
  const ranked: {
    ref: WaitingRef;
    blocking: Blocking;
    waitingSince: string;
    serialId: number;
  }[] = [];

  const tickets = queue.tickets.map((ticket) => {
    const blockedDownstream = downstreamById.get(ticket.id) ?? [];
    const blocking: Blocking = {
      ...NO_BLOCKING,
      downstream: blockedDownstream,
      finalization: (openBySpec.get(ticket.specId) ?? 0) > 0,
    };
    const waitingSince = iso(
      ticketFinished.get(ticket.id) ?? ticketCreated.get(ticket.id),
      now,
    );
    ranked.push({
      ref: { kind: "ticket", id: ticket.id },
      blocking,
      waitingSince,
      serialId: ticket.id,
    });
    return { ...ticket, waitingSince, blocking };
  });

  const finalizations = queue.finalizations.map((item) => {
    const blocking: Blocking = { ...NO_BLOCKING, pullRequests: true };
    const related =
      item.step === "final-e2e"
        ? e2eFinished.get(item.specId)
        : finalFinished.get(item.specId);
    const waitingSince = iso(related ?? finalCreated.get(item.id), now);
    ranked.push({
      ref: { kind: "finalization", id: item.id, step: item.step },
      blocking,
      waitingSince,
      serialId: item.id,
    });
    return { ...item, waitingSince, blocking };
  });

  const pullRequests = queue.pullRequests.map((item) => {
    const blocking: Blocking = { ...NO_BLOCKING, merge: true };
    const waitingSince = iso(
      pullTimes.get(`${item.specId}:${item.repo}:${item.number}`),
      specCreated.get(item.specId) ?? now,
    );
    ranked.push({
      ref: {
        kind: "pullRequest",
        specId: item.specId,
        repo: item.repo,
        number: item.number,
      },
      blocking,
      waitingSince,
      serialId: item.number,
    });
    return { ...item, waitingSince, blocking };
  });

  const cleanups = queue.cleanups.map((item) => {
    const blocking = { ...NO_BLOCKING };
    const waitingSince = iso(
      cleanupTimes.get(item.specId),
      specCreated.get(item.specId) ?? now,
    );
    ranked.push({
      ref: { kind: "cleanup", specId: item.specId },
      blocking,
      waitingSince,
      serialId: item.specId,
    });
    return { ...item, waitingSince, blocking };
  });

  const readyFailures = queue.readyFailures.map((item) => {
    const blocking: Blocking = { ...NO_BLOCKING, merge: true };
    const waitingSince = iso(
      readyTimes.get(`${item.specId}:${item.repo}:${item.number}`) ??
        pullTimes.get(`${item.specId}:${item.repo}:${item.number}`),
      specCreated.get(item.specId) ?? now,
    );
    ranked.push({
      ref: {
        kind: "readyFailure",
        specId: item.specId,
        repo: item.repo,
        number: item.number,
      },
      blocking,
      waitingSince,
      serialId: item.number,
    });
    return { ...item, waitingSince, blocking };
  });

  const planning = queue.planning.map((item) => {
    const blocking: Blocking = { ...NO_BLOCKING, spec: true };
    const waitingSince = iso(
      specFinished.get(item.specId) ?? specCreated.get(item.specId),
      now,
    );
    ranked.push({
      ref: { kind: "planning", specId: item.specId },
      blocking,
      waitingSince,
      serialId: item.specId,
    });
    return { ...item, waitingSince, blocking };
  });

  const specs = queue.specs.map((item) => {
    const blocking: Blocking = { ...NO_BLOCKING, spec: true };
    const waitingSince = iso(
      specFinished.get(item.id) ?? specCreated.get(item.id),
      now,
    );
    ranked.push({
      ref: { kind: "pausedSpec", id: item.id },
      blocking,
      waitingSince,
      serialId: item.id,
    });
    return { ...item, waitingSince, blocking };
  });

  ranked.sort(compareWaiting);
  return {
    ...queue,
    tickets,
    finalizations,
    pullRequests,
    cleanups,
    readyFailures,
    planning,
    specs,
    items: ranked.map((item) => item.ref),
  };
}
