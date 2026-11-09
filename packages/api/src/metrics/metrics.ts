import {
  type FailureSource,
  formatDisplayId,
  lastWeekStarts,
  METRICS_WEEKS,
  medianMs,
  weekStartYmd,
  ymdInZone,
} from "@afk/shared";
import type pg from "pg";
import { specLeadTime } from "../tickets/lead-time.ts";

// The metrics page: last 12 weeks, three blocks, specs grouped by the week they ended
// (docs/specs/m3-platform.md「工期四段与度量页」). Cancelled specs skip 工期 and still count in 失败归因.

export type AttributionRow = {
  source: FailureSource;
  reason: string;
  count: number;
};

export type WeekLeadSpec = {
  id: number;
  displayId: string;
  title: string;
  totalMs: number;
};

export type WeekMetrics = {
  weekStart: string;
  leadTime: {
    ended: number;
    medianMs: number | null;
    agentMs: number;
    gateMs: number;
    queuedMs: number;
    waitingMs: number;
    specs: WeekLeadSpec[];
  };
  attribution: {
    recovered: AttributionRow[];
    needsHuman: AttributionRow[];
  };
  failureRate: {
    ended: number;
    platform: number | null;
    external: number | null;
    jobPlatform: number | null;
  };
};

export type MetricsView = {
  since: string | null;
  weeks: WeekMetrics[];
};

type FailureRow = {
  spec_id: number;
  type: string;
  to_state: string | null;
  reason: string | null;
  failure_source: FailureSource;
  job_id: number | null;
};

type JobRow = {
  spec_id: number;
  to_state: string | null;
  failure_source: FailureSource | null;
};

const HUMAN_TYPES = new Set([
  "ticket",
  "spec",
  "finalization",
  "final-e2e",
  "planning",
]);
const HUMAN_STATES = new Set(["blocked", "paused"]);

export async function metricsView(
  pool: pg.Pool,
  now: Date,
  projectId?: number,
): Promise<MetricsView> {
  const weeks = lastWeekStarts(now, METRICS_WEEKS);
  const weekSet = new Set(weeks);
  const since = (
    await pool.query<{ at: Date | null }>(
      `SELECT min(e.at) AS at
       FROM events e
       WHERE $1::int IS NULL
          OR e.spec_id IN (SELECT id FROM specs WHERE project_id = $1)`,
      [projectId ?? null],
    )
  ).rows[0]?.at;

  const ended = await pool.query<{
    id: number;
    title: string;
    state: string;
    ended_at: Date | null;
  }>(
    `SELECT s.id, s.title, s.state,
            CASE
              WHEN s.state = 'merged' THEN COALESCE(
                (SELECT max(p.merged_at) FROM pull_requests p WHERE p.spec_id = s.id),
                (SELECT max(e.at) FROM events e
                 WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'merged')
              )
              WHEN s.state = 'cancelled' THEN (
                SELECT max(e.at) FROM events e
                WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'cancelled'
              )
            END AS ended_at
     FROM specs s
     WHERE s.state IN ('merged', 'cancelled')
       AND ($1::int IS NULL OR s.project_id = $1)`,
    [projectId ?? null],
  );

  const byWeek = new Map<string, typeof ended.rows>();
  for (const row of ended.rows) {
    if (!row.ended_at) continue;
    const week = weekStartYmd(row.ended_at);
    if (!weekSet.has(week)) continue;
    const list = byWeek.get(week) ?? [];
    list.push(row);
    byWeek.set(week, list);
  }

  const specIds = ended.rows.map((row) => row.id);
  const failures = specIds.length
    ? (
        await pool.query<FailureRow>(
          `SELECT spec_id, type, to_state, reason, failure_source, job_id
           FROM events
           WHERE spec_id = ANY($1::int[]) AND failure_source IS NOT NULL`,
          [specIds],
        )
      ).rows
    : [];
  const jobs = specIds.length
    ? (
        await pool.query<JobRow>(
          `SELECT spec_id, to_state, failure_source
           FROM events
           WHERE spec_id = ANY($1::int[]) AND type = 'job'
             AND to_state IN ('succeeded', 'failed')`,
          [specIds],
        )
      ).rows
    : [];
  const failuresBySpec = groupBy(failures, (row) => row.spec_id);
  const jobsBySpec = groupBy(jobs, (row) => row.spec_id);

  const out: WeekMetrics[] = [];
  for (const weekStart of weeks) {
    const rows = byWeek.get(weekStart) ?? [];
    const merged = rows.filter((row) => row.state === "merged");
    const endedIds = rows.map((row) => row.id);
    const specFailures = endedIds.flatMap((id) => failuresBySpec.get(id) ?? []);
    const specJobs = endedIds.flatMap((id) => jobsBySpec.get(id) ?? []);
    out.push({
      weekStart,
      leadTime: await weekLeadTime(pool, now, merged),
      attribution: weekAttribution(specFailures),
      failureRate: weekFailureRate(endedIds, specFailures, specJobs),
    });
  }

  return { since: since ? ymdInZone(since) : null, weeks: out };
}

async function weekLeadTime(
  pool: pg.Pool,
  now: Date,
  merged: { id: number; title: string }[],
): Promise<WeekMetrics["leadTime"]> {
  const specs: WeekLeadSpec[] = [];
  const acc = { agentMs: 0, gateMs: 0, queuedMs: 0, waitingMs: 0 };
  const totals: number[] = [];
  for (const spec of merged) {
    const lt = await specLeadTime(pool, spec.id, now);
    if (!lt) continue;
    totals.push(lt.totalMs);
    acc.agentMs += lt.agentMs;
    acc.gateMs += lt.gateMs;
    acc.queuedMs += lt.queuedMs;
    acc.waitingMs += lt.waitingMs;
    specs.push({
      id: spec.id,
      displayId: formatDisplayId("spec", spec.id),
      title: spec.title,
      totalMs: lt.totalMs,
    });
  }
  return {
    ended: specs.length,
    medianMs: medianMs(totals),
    ...acc,
    specs,
  };
}

function weekAttribution(events: FailureRow[]): WeekMetrics["attribution"] {
  const needsHuman = events.filter(
    (event) =>
      HUMAN_TYPES.has(event.type) &&
      HUMAN_STATES.has(event.to_state ?? "") &&
      event.reason,
  );
  const humanJobs = new Set(
    needsHuman.map((event) => event.job_id).filter((id) => id !== null),
  );
  const recovered = events.filter(
    (event) =>
      event.type === "job" &&
      (event.to_state === "failed" || event.reason === "lease-expired") &&
      event.reason &&
      (event.job_id === null || !humanJobs.has(event.job_id)),
  );
  return { recovered: tally(recovered), needsHuman: tally(needsHuman) };
}

function tally(events: FailureRow[]): AttributionRow[] {
  const counts = new Map<string, AttributionRow>();
  for (const event of events) {
    if (!event.reason) continue;
    const key = `${event.failure_source}:${event.reason}`;
    const row = counts.get(key) ?? {
      source: event.failure_source,
      reason: event.reason,
      count: 0,
    };
    row.count += 1;
    counts.set(key, row);
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.source.localeCompare(b.source) ||
      a.reason.localeCompare(b.reason),
  );
}

function weekFailureRate(
  endedIds: number[],
  failures: FailureRow[],
  jobs: JobRow[],
): WeekMetrics["failureRate"] {
  const ended = endedIds.length;
  if (ended === 0) {
    return { ended: 0, platform: null, external: null, jobPlatform: null };
  }
  const human = failures.filter(
    (event) =>
      HUMAN_TYPES.has(event.type) && HUMAN_STATES.has(event.to_state ?? ""),
  );
  const share = (source: FailureSource) => {
    const hit = new Set(
      human
        .filter((event) => event.failure_source === source)
        .map((event) => event.spec_id),
    );
    return hit.size / ended;
  };
  const finished = jobs.length;
  const platformJobs = jobs.filter(
    (job) => job.to_state === "failed" && job.failure_source === "platform",
  ).length;
  return {
    ended,
    platform: share("platform"),
    external: share("external"),
    jobPlatform: finished === 0 ? null : platformJobs / finished,
  };
}

function groupBy<T>(rows: T[], keyOf: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}
