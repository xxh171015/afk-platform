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

// The metrics page: last 12 weeks, three blocks plus 成功标准, specs grouped by the week they ended
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
  success: {
    mergedPulls: number;
    mergeRate: number | null;
    humanCommitsRate: number | null;
    untouchedRate: number | null;
  };
  // the agents' pauses that ended this week (agents-pause.ts), in order: they pause the whole instance, so every
  // project shows them
  agentsPauses: AgentsPauseRow[];
};

export type AgentsPauseRow = { pausedMinutes: number; automatic: boolean };

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
  // a stage run again on its own (stages/auto-retry.ts) that went on without a person: the first block of its
  // ticket or finalization after it is not at that stage
  recovered_by_retry: boolean;
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
          `SELECT e.spec_id, e.type, e.to_state, e.reason, e.failure_source, e.job_id,
                  COALESCE((e.data->>'autoRetry')::boolean, false)
                    AND block.stage IS DISTINCT FROM e.data->>'stage' AS recovered_by_retry
           FROM events e
           LEFT JOIN LATERAL (
             SELECT COALESCE(b.data->>'step', j.payload->>'stage') AS stage
             FROM events b LEFT JOIN jobs j ON j.id = b.job_id
             WHERE (e.data->>'autoRetry')::boolean AND b.id > e.id AND b.type = e.type
               AND b.spec_id = e.spec_id AND b.ticket_id IS NOT DISTINCT FROM e.ticket_id
               AND b.repo_id IS NOT DISTINCT FROM e.repo_id AND b.to_state = 'blocked'
             ORDER BY b.id LIMIT 1
           ) block ON true
           WHERE e.spec_id = ANY($1::int[]) AND e.failure_source IS NOT NULL`,
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
  const pulls = await pullOutcomes(pool, projectId);
  const pullsByWeek = new Map<string, PullOutcome[]>();
  for (const pull of pulls) {
    if (!pull.ended_at) continue;
    const week = weekStartYmd(pull.ended_at);
    if (!weekSet.has(week)) continue;
    const list = pullsByWeek.get(week) ?? [];
    list.push(pull);
    pullsByWeek.set(week, list);
  }
  const touched = await touchedSpecs(
    pool,
    ended.rows
      .filter((row) => row.state === "merged" && row.ended_at)
      .map((row) => ({ id: row.id, endedAt: row.ended_at as Date })),
  );

  const pausesByWeek = await agentsPausesByWeek(pool, weekSet);

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
      success: weekSuccess(
        pullsByWeek.get(weekStart) ?? [],
        merged.map((row) => row.id),
        touched,
      ),
      agentsPauses: pausesByWeek.get(weekStart) ?? [],
    });
  }

  return { since: since ? ymdInZone(since) : null, weeks: out };
}

async function agentsPausesByWeek(
  pool: pg.Pool,
  weekSet: Set<string>,
): Promise<Map<string, AgentsPauseRow[]>> {
  const { rows } = await pool.query<{
    at: Date;
    paused_minutes: number;
    automatic: boolean;
  }>(
    `SELECT at, (data->>'pausedMinutes')::int AS paused_minutes,
            COALESCE((data->>'automatic')::boolean, false) AS automatic
     FROM events
     WHERE type = 'system' AND data->>'kind' = 'agents-resumed'
     ORDER BY id`,
  );
  const byWeek = new Map<string, AgentsPauseRow[]>();
  for (const row of rows) {
    const week = weekStartYmd(row.at);
    if (!weekSet.has(week)) continue;
    const list = byWeek.get(week) ?? [];
    list.push({ pausedMinutes: row.paused_minutes, automatic: row.automatic });
    byWeek.set(week, list);
  }
  return byWeek;
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
      event.recovered_by_retry ||
      (event.type === "job" &&
        (event.to_state === "failed" || event.reason === "lease-expired") &&
        event.reason &&
        (event.job_id === null || !humanJobs.has(event.job_id))),
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

type PullOutcome = {
  spec_id: number;
  state: string;
  ended_at: Date | null;
  platform_head: boolean | null;
};

async function pullOutcomes(
  pool: pg.Pool,
  projectId?: number,
): Promise<PullOutcome[]> {
  return (
    await pool.query<PullOutcome>(
      `SELECT p.spec_id, p.state,
              CASE
                WHEN p.state = 'merged' THEN COALESCE(
                  p.merged_at,
                  (SELECT max(e.at) FROM events e
                   WHERE e.spec_id = p.spec_id AND e.repo_id = p.repo_id
                     AND e.type = 'pull-request' AND e.to_state = 'merged')
                )
                WHEN p.state = 'closed' THEN (
                  SELECT max(e.at) FROM events e
                  WHERE e.spec_id = p.spec_id AND e.repo_id = p.repo_id
                    AND e.type = 'pull-request' AND e.to_state = 'closed'
                )
              END AS ended_at,
              (SELECT (e.data->>'platformHead')::boolean
               FROM events e
               WHERE e.spec_id = p.spec_id AND e.repo_id = p.repo_id
                 AND e.type = 'pull-request' AND e.to_state = 'merged'
                 AND e.data ? 'platformHead'
               ORDER BY e.id DESC LIMIT 1) AS platform_head
       FROM pull_requests p
       JOIN specs s ON s.id = p.spec_id
       WHERE p.state IN ('merged', 'closed')
         AND ($1::int IS NULL OR s.project_id = $1)`,
      [projectId ?? null],
    )
  ).rows;
}

async function touchedSpecs(
  pool: pg.Pool,
  merged: { id: number; endedAt: Date }[],
): Promise<Set<number>> {
  if (merged.length === 0) return new Set();
  const { rows } = await pool.query<{ spec_id: number }>(
    `SELECT DISTINCT e.spec_id
     FROM events e
     JOIN unnest($1::int[], $2::timestamptz[]) AS spec(id, ended_at)
       ON spec.id = e.spec_id
     JOIN LATERAL (
       SELECT min(c.at) AS confirm_at
       FROM events c
       WHERE c.spec_id = e.spec_id AND c.type = 'spec' AND c.to_state = 'running'
     ) c ON true
     WHERE e.type = 'action'
       AND (e.data->>'action') IS DISTINCT FROM 'confirm'
       AND e.at > c.confirm_at
       AND e.at <= spec.ended_at`,
    [merged.map((row) => row.id), merged.map((row) => row.endedAt)],
  );
  return new Set(rows.map((row) => row.spec_id));
}

function weekSuccess(
  pulls: PullOutcome[],
  mergedSpecIds: number[],
  touched: Set<number>,
): WeekMetrics["success"] {
  const mergedPulls = pulls.filter((pull) => pull.state === "merged");
  const closed = pulls.filter((pull) => pull.state === "closed").length;
  const decided = mergedPulls.length + closed;
  const knownHead = mergedPulls.filter((pull) => pull.platform_head !== null);
  const extraCommits = knownHead.filter((pull) => pull.platform_head === false);
  return {
    mergedPulls: mergedPulls.length,
    mergeRate: decided === 0 ? null : mergedPulls.length / decided,
    humanCommitsRate:
      knownHead.length === 0 ? null : extraCommits.length / knownHead.length,
    untouchedRate:
      mergedSpecIds.length === 0
        ? null
        : mergedSpecIds.filter((id) => !touched.has(id)).length /
          mergedSpecIds.length,
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
