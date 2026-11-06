import { formatDisplayId, isSlowStage, type SpecState } from "@afk/shared";
import type pg from "pg";
import {
  blockedQueue,
  type Progress,
  type SpecListItem,
  specListItems,
} from "./views.ts";

// The control-tower home: four quadrants a person glances at instead of a spec table
// (docs/specs/experience-platform.md「工作台与导航」). Waiting is the waiting queue without briefs.

export interface WorkbenchSpec {
  id: number;
  displayId: string;
  slug: string;
  title: string;
  type: string;
  state: SpecState;
  pauseReason: string | null;
  project: string;
  repos: SpecListItem["repos"];
  startedAt: string;
  endedAt: string | null;
  progress: Progress;
}

export interface RunningTicket {
  id: number;
  displayId: string;
  title: string;
  state: string;
  repo: string;
  stage: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  meanMs: number | null;
  slow: boolean;
}

type RankedQueue = Awaited<ReturnType<typeof blockedQueue>>;

function dropBrief<T extends { brief?: unknown }>(item: T): Omit<T, "brief"> {
  const { brief: _brief, ...rest } = item;
  return rest;
}

function slimWaiting(queue: RankedQueue) {
  return {
    ...queue,
    tickets: queue.tickets.map(dropBrief),
    finalizations: queue.finalizations.map(dropBrief),
  };
}

export interface Workbench {
  waiting: ReturnType<typeof slimWaiting>;
  running: { spec: WorkbenchSpec; tickets: RunningTicket[] }[];
  awaitingAcceptance: {
    spec: WorkbenchSpec;
    pullRequestCount: number;
    verifiedCriteria: number;
    totalCriteria: number;
  }[];
  recentlyCompleted: { spec: WorkbenchSpec; completedAt: string }[];
}

const RECENT_LIMIT = 10;

function criteriaCounts(content: unknown): {
  verified: number;
  total: number;
} {
  const pack = content as {
    repos?: { tickets?: { criteria?: { status?: string }[] }[] }[];
    integration?: { tickets?: { criteria?: { status?: string }[] }[] };
  } | null;
  const all = [
    ...(pack?.repos ?? []).flatMap((repo) =>
      (repo.tickets ?? []).flatMap((ticket) => ticket.criteria ?? []),
    ),
    ...(pack?.integration?.tickets ?? []).flatMap(
      (ticket) => ticket.criteria ?? [],
    ),
  ];
  return {
    total: all.length,
    verified: all.filter((criterion) => criterion.status === "verified").length,
  };
}

async function specIdsIn(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(sql, params);
  return rows.map((row) => row.id);
}

export async function workbench(pool: pg.Pool, now: Date): Promise<Workbench> {
  const waiting = slimWaiting(await blockedQueue(pool, { brief: false }));

  const means = await pool.query<{
    project_id: number;
    stage: string;
    mean: string | number;
  }>(
    `SELECT s.project_id, r.stage, AVG(r.duration_ms) AS mean
     FROM runs r JOIN specs s ON s.id = r.spec_id
     WHERE r.duration_ms IS NOT NULL AND r.finished_at IS NOT NULL
     GROUP BY s.project_id, r.stage`,
  );
  const meanOf = new Map<string, number>();
  for (const row of means.rows) {
    meanOf.set(`${row.project_id}\0${row.stage}`, Math.round(Number(row.mean)));
  }

  const runningRows = await pool.query<{
    id: number;
    spec_id: number;
    title: string;
    state: string;
    repo: string;
    project_id: number;
    stage: string | null;
    started_at: Date | null;
  }>(
    `SELECT t.id, t.spec_id, t.title, t.state, r.name AS repo, s.project_id,
            run.stage, run.started_at
     FROM tickets t
     JOIN repos r ON r.id = t.repo_id
     JOIN specs s ON s.id = t.spec_id
     LEFT JOIN LATERAL (
       SELECT stage, started_at FROM runs
       WHERE ticket_id = t.id AND finished_at IS NULL
       ORDER BY id DESC LIMIT 1
     ) run ON true
     WHERE s.state = 'running' AND t.state IN ('running', 'merging')
     ORDER BY s.id DESC, t.id`,
  );

  const ticketsBySpec = new Map<number, RunningTicket[]>();
  for (const row of runningRows.rows) {
    const startedAt = row.started_at ? row.started_at.toISOString() : null;
    const elapsedMs =
      row.started_at === null
        ? null
        : Math.max(0, now.getTime() - row.started_at.getTime());
    const meanMs =
      row.stage === null
        ? null
        : (meanOf.get(`${row.project_id}\0${row.stage}`) ?? null);
    const listFor = ticketsBySpec.get(row.spec_id) ?? [];
    listFor.push({
      id: row.id,
      displayId: formatDisplayId("ticket", row.id),
      title: row.title,
      state: row.state,
      repo: row.repo,
      stage: row.stage,
      startedAt,
      elapsedMs,
      meanMs,
      slow: elapsedMs !== null && isSlowStage(elapsedMs, meanMs),
    });
    ticketsBySpec.set(row.spec_id, listFor);
  }

  const runningIds = await specIdsIn(
    pool,
    "SELECT id FROM specs WHERE state = 'running' ORDER BY created_at DESC, id DESC",
  );
  const runningSpecs = await specListItems(pool, runningIds);
  const running = runningSpecs.map((spec) => ({
    spec,
    tickets: ticketsBySpec.get(spec.id) ?? [],
  }));

  const reviewIds = await specIdsIn(
    pool,
    `SELECT id FROM specs
     WHERE state IN ('awaiting-review', 'partially-merged')
     ORDER BY created_at DESC, id DESC`,
  );
  const reviewSpecs = await specListItems(pool, reviewIds);
  const prCounts = new Map<number, number>();
  const verified = new Map<number, { verified: number; total: number }>();
  if (reviewIds.length > 0) {
    const prs = await pool.query<{ spec_id: number; n: string }>(
      `SELECT spec_id, count(*)::text AS n FROM pull_requests
       WHERE spec_id = ANY($1) GROUP BY spec_id`,
      [reviewIds],
    );
    for (const row of prs.rows) prCounts.set(row.spec_id, Number(row.n));
    const packs = await pool.query<{ spec_id: number; content: unknown }>(
      "SELECT spec_id, content FROM acceptance_packs WHERE spec_id = ANY($1)",
      [reviewIds],
    );
    for (const row of packs.rows)
      verified.set(row.spec_id, criteriaCounts(row.content));
  }

  const awaitingAcceptance = reviewSpecs.map((spec) => {
    const counts = verified.get(spec.id) ?? { verified: 0, total: 0 };
    return {
      spec,
      pullRequestCount: prCounts.get(spec.id) ?? 0,
      verifiedCriteria: counts.verified,
      totalCriteria: counts.total,
    };
  });

  const completedRows = await pool.query<{
    id: number;
    completed_at: Date;
  }>(
    `SELECT s.id, COALESCE(
        MAX(p.synced_at) FILTER (WHERE p.state = 'merged'),
        s.created_at
      ) AS completed_at
     FROM specs s LEFT JOIN pull_requests p ON p.spec_id = s.id
     WHERE s.state = 'merged'
     GROUP BY s.id
     ORDER BY completed_at DESC, s.id DESC
     LIMIT $1`,
    [RECENT_LIMIT],
  );

  const completedSpecs = await specListItems(
    pool,
    completedRows.rows.map((row) => row.id),
  );
  const completedById = new Map(completedSpecs.map((spec) => [spec.id, spec]));
  const recentlyCompleted = completedRows.rows.flatMap((row) => {
    const spec = completedById.get(row.id);
    return spec ? [{ spec, completedAt: row.completed_at.toISOString() }] : [];
  });

  return { waiting, running, awaitingAcceptance, recentlyCompleted };
}
