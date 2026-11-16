import { formatDisplayId } from "@afk/shared";
import type pg from "pg";
import { readFinalPayload, readStagePayload } from "../jobs/stage-jobs.ts";

const QUEUED_LIMIT = 80;

export interface RuntimeJob {
  id: number;
  type: string;
  state: "running" | "queued";
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lockKey: string | null;
  notBefore: string | null;
  label: string;
  stage: string | null;
  specId: number | null;
  specDisplayId: string | null;
  ticketId: number | null;
  ticketDisplayId: string | null;
  runId: number | null;
}

export interface RuntimeWorker {
  id: string;
  reportedAt: string;
  freeBytes: number | null;
  cleaned: { sandboxLogs: number; salvage: number; snapshots: number };
  heldJobId: number | null;
}

export interface Runtime {
  instance: { id: string };
  summary: { running: number; queued: number };
  jobs: { running: RuntimeJob[]; queued: RuntimeJob[] };
  workers: RuntimeWorker[];
}

interface JobRow {
  id: number;
  type: string;
  state: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  lock_key: string | null;
  not_before: Date | null;
  payload: Record<string, unknown>;
  run_id: number | null;
}

interface Lookups {
  ticketTitle: Map<number, { specId: number; repo: string }>;
  specTitle: Map<number, string>;
  projectName: Map<number, string>;
  repoName: Map<number, string>;
}

function collectIds(rows: JobRow[]) {
  const ticketIds = new Set<number>();
  const specIds = new Set<number>();
  const projectIds = new Set<number>();
  const repoIds = new Set<number>();
  for (const row of rows) {
    const payload = row.payload;
    if (typeof payload.ticketId === "number") ticketIds.add(payload.ticketId);
    if (typeof payload.specId === "number") specIds.add(payload.specId);
    if (typeof payload.projectId === "number")
      projectIds.add(payload.projectId);
    if (typeof payload.repoId === "number") repoIds.add(payload.repoId);
  }
  return { ticketIds, specIds, projectIds, repoIds };
}

async function loadLookups(
  pool: pg.Pool,
  ids: ReturnType<typeof collectIds>,
): Promise<Lookups> {
  const ticketTitle = new Map<number, { specId: number; repo: string }>();
  const specTitle = new Map<number, string>();
  const projectName = new Map<number, string>();
  const repoName = new Map<number, string>();

  if (ids.ticketIds.size > 0) {
    const tickets = await pool.query<{
      id: number;
      spec_id: number;
      name: string;
    }>(
      `SELECT t.id, t.spec_id, r.name
       FROM tickets t JOIN repos r ON r.id = t.repo_id
       WHERE t.id = ANY($1::int[])`,
      [Array.from(ids.ticketIds)],
    );
    for (const row of tickets.rows) {
      ticketTitle.set(row.id, { specId: row.spec_id, repo: row.name });
    }
  }

  const allSpecIds = new Set(ids.specIds);
  for (const entry of ticketTitle.values()) allSpecIds.add(entry.specId);

  if (allSpecIds.size > 0) {
    const specs = await pool.query<{ id: number; title: string }>(
      "SELECT id, title FROM specs WHERE id = ANY($1::int[])",
      [Array.from(allSpecIds)],
    );
    for (const row of specs.rows) specTitle.set(row.id, row.title);
  }
  if (ids.projectIds.size > 0) {
    const projects = await pool.query<{ id: number; name: string }>(
      "SELECT id, name FROM projects WHERE id = ANY($1::int[])",
      [Array.from(ids.projectIds)],
    );
    for (const row of projects.rows) projectName.set(row.id, row.name);
  }
  if (ids.repoIds.size > 0) {
    const repos = await pool.query<{ id: number; name: string }>(
      "SELECT id, name FROM repos WHERE id = ANY($1::int[])",
      [Array.from(ids.repoIds)],
    );
    for (const row of repos.rows) repoName.set(row.id, row.name);
  }

  return { ticketTitle, specTitle, projectName, repoName };
}

function jobLabel(row: JobRow, lookups: Lookups): string {
  const payload = row.payload;
  const stagePayload = readStagePayload(payload);
  if (stagePayload) {
    const ticket = lookups.ticketTitle.get(stagePayload.ticketId);
    const ticketRef = formatDisplayId("ticket", stagePayload.ticketId);
    const repo = ticket?.repo ?? "";
    return repo
      ? `${stagePayload.stage} · ${ticketRef} · ${repo}`
      : `${stagePayload.stage} · ${ticketRef}`;
  }
  const finalPayload = readFinalPayload(payload);
  if (finalPayload) {
    const specRef = formatDisplayId("spec", finalPayload.specId);
    const repo =
      lookups.repoName.get(finalPayload.repoId) ??
      `repo-${finalPayload.repoId}`;
    return `收尾 ${finalPayload.step} · ${specRef} · ${repo}`;
  }
  if (row.type === "host-sync" && typeof payload.projectId === "number") {
    const name =
      lookups.projectName.get(payload.projectId) ?? `项目 ${payload.projectId}`;
    return `${name} · 同步 PR`;
  }
  if (row.type === "open-pr" && typeof payload.specId === "number") {
    return `开 PR · ${formatDisplayId("spec", payload.specId)}`;
  }
  if (row.type === "spec-cleanup" && typeof payload.specId === "number") {
    return `清理分支 · ${formatDisplayId("spec", payload.specId)}`;
  }
  if (typeof payload.specId === "number") {
    const title = lookups.specTitle.get(payload.specId);
    const specRef = formatDisplayId("spec", payload.specId);
    return title ? `${row.type} · ${specRef}` : `${row.type} · ${specRef}`;
  }
  return `${row.type} #${row.id}`;
}

function toRuntimeJob(row: JobRow, lookups: Lookups): RuntimeJob {
  const payload = row.payload;
  const stagePayload = readStagePayload(payload);
  const finalPayload = readFinalPayload(payload);
  let specId: number | null = null;
  let ticketId: number | null = null;
  let stage: string | null = null;

  if (stagePayload) {
    ticketId = stagePayload.ticketId;
    stage = stagePayload.stage;
    specId = lookups.ticketTitle.get(ticketId)?.specId ?? null;
  } else if (finalPayload) {
    specId = finalPayload.specId;
    stage = finalPayload.step;
  } else if (typeof payload.specId === "number") {
    specId = payload.specId;
  } else if (typeof payload.ticketId === "number") {
    ticketId = payload.ticketId;
    specId = lookups.ticketTitle.get(ticketId)?.specId ?? null;
  }
  if (typeof payload.stage === "string" && stage === null) {
    stage = payload.stage;
  }

  const state = row.state === "running" ? "running" : "queued";

  return {
    id: row.id,
    type: row.type,
    state,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    lockKey: row.lock_key,
    notBefore: row.not_before?.toISOString() ?? null,
    label: jobLabel(row, lookups),
    stage,
    specId,
    specDisplayId: specId === null ? null : formatDisplayId("spec", specId),
    ticketId,
    ticketDisplayId:
      ticketId === null ? null : formatDisplayId("ticket", ticketId),
    runId: row.run_id,
  };
}

async function jobRows(
  pool: pg.Pool,
  state: "running" | "queued",
  limit?: number,
): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT j.id, j.type, j.state, j.attempt, j.lease_owner, j.lease_expires_at,
            j.lock_key, j.not_before, j.payload, r.id AS run_id
     FROM jobs j
     LEFT JOIN runs r ON r.job_id = j.id
     WHERE j.state = $1
     ORDER BY j.id
     ${limit !== undefined ? "LIMIT $2" : ""}`,
    limit !== undefined ? [state, limit] : [state],
  );
  return rows.map((row) => ({
    ...row,
    payload:
      row.payload &&
      typeof row.payload === "object" &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
  }));
}

export async function runtimeView(pool: pg.Pool): Promise<Runtime> {
  const instance = await pool.query<{ id: string }>("SELECT id FROM instance");
  const counts = await pool.query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM jobs
     WHERE state IN ('running', 'queued') GROUP BY state`,
  );
  const runningN =
    Number(counts.rows.find((row) => row.state === "running")?.n) || 0;
  const queuedN =
    Number(counts.rows.find((row) => row.state === "queued")?.n) || 0;

  const runningRows = await jobRows(pool, "running");
  const queuedRows = await jobRows(pool, "queued", QUEUED_LIMIT);
  const allRows = [...runningRows, ...queuedRows];
  const lookups = await loadLookups(pool, collectIds(allRows));

  const running = runningRows.map((row) => toRuntimeJob(row, lookups));
  const queued = queuedRows.map((row) => toRuntimeJob(row, lookups));

  const heldByWorker = new Map<string, number>();
  for (const job of running) {
    if (job.leaseOwner) heldByWorker.set(job.leaseOwner, job.id);
  }

  const workers = await pool.query<{
    id: string;
    reported_at: Date;
    free_bytes: string | null;
    cleaned_sandbox_logs: number;
    cleaned_salvage: number;
    cleaned_snapshots: number;
  }>(
    `SELECT id, reported_at, free_bytes, cleaned_sandbox_logs, cleaned_salvage, cleaned_snapshots
     FROM workers ORDER BY id`,
  );

  return {
    instance: { id: instance.rows[0]?.id ?? "" },
    summary: { running: runningN, queued: queuedN },
    jobs: { running, queued },
    workers: workers.rows.map((row) => ({
      id: row.id,
      reportedAt: row.reported_at.toISOString(),
      freeBytes: row.free_bytes === null ? null : Number(row.free_bytes),
      cleaned: {
        sandboxLogs: row.cleaned_sandbox_logs,
        salvage: row.cleaned_salvage,
        snapshots: row.cleaned_snapshots,
      },
      heldJobId: heldByWorker.get(row.id) ?? null,
    })),
  };
}
