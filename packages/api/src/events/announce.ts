import type { InvalidatePayload } from "@afk/shared";
import type pg from "pg";
import type { AppContext } from "../app.ts";
import { mergeOrderOf } from "../host/merge-order.ts";
import type { Shot, ShotFinal, ShotPull } from "../notify/notices.ts";

// Snapshot a spec so around* still has a before-image for callers that need it. Notices are dispatched
// from the events table (notify/dispatch.ts); page refresh is pushed from events/hub.ts.

const SKIP = new Set([
  "no-ticket",
  "no-spec",
  "no-project",
  "refused",
  "invalid",
  "not-confirmable",
  "not-importable",
  "name-taken",
  "slug-taken",
]);

export async function specIdOfTicket(
  pool: pg.Pool,
  ticketId: number,
): Promise<number | undefined> {
  const { rows } = await pool.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  return rows[0]?.spec_id;
}

export async function specIdsOfJob(
  pool: pg.Pool,
  jobId: number,
): Promise<number[]> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM jobs WHERE id = $1",
    [jobId],
  );
  const payload = rows[0]?.payload ?? {};
  if (typeof payload.specId === "number") return [payload.specId];
  if (typeof payload.ticketId === "number") {
    const specId = await specIdOfTicket(pool, payload.ticketId);
    return specId !== undefined ? [specId] : [];
  }
  if (typeof payload.pullId === "number") {
    const pull = await pool.query<{ spec_id: number }>(
      "SELECT spec_id FROM pull_requests WHERE id = $1",
      [payload.pullId],
    );
    return pull.rows[0] ? [pull.rows[0].spec_id] : [];
  }
  if (typeof payload.projectId === "number") {
    // host-sync: only specs that are not over, or that still have an open pull request
    const specs = await pool.query<{ id: number }>(
      `SELECT s.id FROM specs s
       WHERE s.project_id = $1
         AND (
           s.state NOT IN ('merged', 'cancelled')
           OR EXISTS (
             SELECT 1 FROM pull_requests p
             WHERE p.spec_id = s.id AND p.state = 'open'
           )
         )
       ORDER BY s.id`,
      [payload.projectId],
    );
    return specs.rows.map((row) => row.id);
  }
  return [];
}

export async function invalidateIdsOfJob(
  pool: pg.Pool,
  jobId: number,
): Promise<InvalidatePayload> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM jobs WHERE id = $1",
    [jobId],
  );
  const payload = rows[0]?.payload ?? {};
  const specIds = await specIdsOfJob(pool, jobId);
  const run = await pool.query<{ id: number }>(
    "SELECT id FROM runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1",
    [jobId],
  );
  return {
    ...(specIds[0] !== undefined ? { specId: specIds[0] } : {}),
    ...(typeof payload.ticketId === "number"
      ? { ticketId: payload.ticketId }
      : {}),
    ...(run.rows[0] ? { runId: run.rows[0].id } : {}),
  };
}

export async function loadShot(
  pool: pg.Pool,
  specId: number,
): Promise<Shot | undefined> {
  const spec = await pool.query<{
    id: number;
    title: string;
    state: string;
    pause_reason: string | null;
    token_merged: boolean;
    host_kind: string | null;
  }>(
    `SELECT s.id, s.title, s.state, s.pause_reason, s.token_merged,
            (SELECT r.host_kind FROM repos r WHERE r.project_id = s.project_id ORDER BY r.id LIMIT 1) AS host_kind
     FROM specs s WHERE s.id = $1`,
    [specId],
  );
  const row = spec.rows[0];
  if (!row) return undefined;
  const tickets = await pool.query<{
    id: number;
    title: string;
    state: string;
    blocked_reason: string | null;
  }>(
    "SELECT id, title, state, blocked_reason FROM tickets WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const finals = await pool.query<{
    id: number;
    repo_id: number;
    state: string;
    blocked_reason: string | null;
  }>(
    "SELECT id, repo_id, state, blocked_reason FROM finalizations WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const e2e = await pool.query<{
    id: number;
    state: string;
    blocked_reason: string | null;
  }>(
    "SELECT id, state, blocked_reason FROM final_e2e WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const pulls = await pool.query<{
    id: number;
    repo: string;
    state: string;
    draft: boolean;
    ci: string;
    review: string;
    head_sha: string;
    sync_error: string | null;
  }>(
    `SELECT p.id, r.name AS repo, p.state, p.draft, p.ci, p.review, p.head_sha, p.sync_error
     FROM pull_requests p JOIN repos r ON r.id = p.repo_id
     WHERE p.spec_id = $1 ORDER BY p.id`,
    [specId],
  );
  const order = await mergeOrderOf(pool, specId);
  const cleanup = await pool.query<{ spec_id: number }>(
    `SELECT DISTINCT ON (spec_id) spec_id FROM (
       SELECT (payload->>'specId')::int AS spec_id, state, id FROM jobs WHERE type = 'spec-cleanup'
     ) j
     WHERE spec_id = $1 AND state = 'failed' AND NOT EXISTS (
       SELECT 1 FROM jobs k WHERE k.type = 'spec-cleanup' AND (k.payload->>'specId')::int = j.spec_id
         AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))
     ORDER BY spec_id, id DESC`,
    [specId],
  );
  const ready = await pool.query<{ id: number }>(
    `SELECT DISTINCT ON (p.id) p.id
     FROM jobs j
     JOIN pull_requests p ON p.id = (j.payload->>'pullId')::int
     WHERE j.type = 'pr-ready' AND j.state = 'failed' AND p.draft AND p.spec_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM jobs k WHERE k.type = 'pr-ready' AND (k.payload->>'pullId')::int = p.id
           AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))
     ORDER BY p.id, j.id DESC`,
    [specId],
  );
  const finalRows: ShotFinal[] = [
    ...finals.rows.map((item) => ({
      key: `finalization:${item.id}`,
      state: item.state,
      blockedReason: item.blocked_reason,
    })),
    ...e2e.rows.map((item) => ({
      key: `final-e2e:${item.id}`,
      state: item.state,
      blockedReason: item.blocked_reason,
    })),
  ];
  const prs: ShotPull[] = pulls.rows.map((item) => ({
    id: item.id,
    repo: item.repo,
    state: item.state,
    draft: item.draft,
    ci: item.ci,
    review: item.review,
    headSha: item.head_sha,
    syncError: item.sync_error,
    mergeOrderDraft: (order.after[item.repo] ?? []).length > 0,
  }));
  return {
    specId: row.id,
    specTitle: row.title,
    specState: row.state,
    pauseReason: row.pause_reason,
    hostKind: row.host_kind === "gitlab" ? "gitlab" : "github",
    tokenMerged: row.token_merged,
    tickets: tickets.rows.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      blockedReason: item.blocked_reason,
    })),
    finals: finalRows,
    prs,
    cleanupFailed: cleanup.rows.length > 0,
    readyFailedPullIds: ready.rows.map((item) => item.id),
  };
}

export async function snapshotSpecs(
  pool: pg.Pool,
  specIds: number[],
): Promise<Map<number, Shot>> {
  const shots = new Map<number, Shot>();
  for (const id of specIds) {
    const shot = await loadShot(pool, id);
    if (shot) shots.set(id, shot);
  }
  return shots;
}

export async function emitTransition(
  _context: AppContext,
  _before: Map<number, Shot>,
  _extra: InvalidatePayload,
): Promise<void> {
  // Notices are dispatched from the events table (notify/dispatch.ts). Invalidate is pushed
  // from events/hub.ts after commit.
}

export async function aroundSpec<T extends { status: string }>(
  context: AppContext,
  specId: number,
  run: () => Promise<T>,
): Promise<T> {
  const before = await snapshotSpecs(context.pool, [specId]);
  const result = await run();
  if (!SKIP.has(result.status)) {
    await emitTransition(context, before, { specId });
  }
  return result;
}

export async function aroundTicket<T extends { status: string }>(
  context: AppContext,
  ticketId: number,
  run: () => Promise<T>,
): Promise<T> {
  const specId = await specIdOfTicket(context.pool, ticketId);
  const before =
    specId !== undefined
      ? await snapshotSpecs(context.pool, [specId])
      : new Map<number, Shot>();
  const result = await run();
  if (!SKIP.has(result.status)) {
    await emitTransition(context, before, { ticketId, specId });
  }
  return result;
}

export async function aroundJob<T extends { status: string }>(
  context: AppContext,
  jobId: number,
  run: () => Promise<T>,
): Promise<T> {
  const specIds = await specIdsOfJob(context.pool, jobId);
  const before = await snapshotSpecs(context.pool, specIds);
  const result = await run();
  if (result.status === "ok") {
    await emitTransition(
      context,
      before,
      await invalidateIdsOfJob(context.pool, jobId),
    );
  }
  return result;
}
