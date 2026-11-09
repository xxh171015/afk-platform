import { leadTime, runLeadSegment, type Span } from "@afk/shared";
import type pg from "pg";

// Maps a spec's runs and job-queue events onto the four lead-time segments
// (docs/specs/m3-platform.md「工期四段与度量页」). Cancelled specs and ones not yet confirmed have none.

export async function specLeadTime(pool: pg.Pool, specId: number, now: Date) {
  const spec = (
    await pool.query<{ state: string }>(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    )
  ).rows[0];
  if (!spec || spec.state === "cancelled") return null;
  const confirmAt = await confirmAtOf(pool, specId);
  if (confirmAt === null) return null;
  const endAt = await endAtOf(pool, specId, spec.state, now);
  const runs = await pool.query<{
    stage: string;
    result: string | null;
    agent: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT stage, result, agent, started_at, finished_at
     FROM runs WHERE spec_id = $1 AND started_at IS NOT NULL`,
    [specId],
  );
  const agent: Span[] = [];
  const gate: Span[] = [];
  for (const run of runs.rows) {
    const kind = runLeadSegment(run.stage, run.result, run.agent !== null);
    if (!kind) continue;
    const span = {
      startMs: run.started_at.getTime(),
      endMs: run.finished_at?.getTime() ?? null,
    };
    if (kind === "agent") agent.push(span);
    else if (kind === "gate") gate.push(span);
  }
  const jobEvents = await pool.query<{
    job_id: number | null;
    at: Date;
    to_state: string | null;
  }>(
    `SELECT job_id, at, to_state FROM events
     WHERE spec_id = $1 AND type = 'job' ORDER BY at, id`,
    [specId],
  );
  return leadTime({
    confirmAt,
    endAt,
    agent,
    gate,
    queued: [
      ...queuedSpans(jobEvents.rows),
      ...(await slotWaits(pool, specId, confirmAt, endAt)),
    ],
  });
}

async function confirmAtOf(
  pool: pg.Pool,
  specId: number,
): Promise<number | null> {
  const confirmed = (
    await pool.query<{ at: Date }>(
      `SELECT at FROM events
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'running'
       ORDER BY id ASC LIMIT 1`,
      [specId],
    )
  ).rows[0];
  if (confirmed) return confirmed.at.getTime();
  const firstRun = (
    await pool.query<{ started_at: Date }>(
      `SELECT started_at FROM runs
       WHERE spec_id = $1 AND started_at IS NOT NULL
       ORDER BY started_at ASC LIMIT 1`,
      [specId],
    )
  ).rows[0];
  return firstRun ? firstRun.started_at.getTime() : null;
}

async function endAtOf(
  pool: pg.Pool,
  specId: number,
  state: string,
  now: Date,
): Promise<number> {
  if (state !== "merged") return now.getTime();
  const merged = (
    await pool.query<{ at: Date | null }>(
      "SELECT max(merged_at) AS at FROM pull_requests WHERE spec_id = $1",
      [specId],
    )
  ).rows[0];
  if (merged?.at) return merged.at.getTime();
  const event = (
    await pool.query<{ at: Date }>(
      `SELECT at FROM events
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'merged'
       ORDER BY id DESC LIMIT 1`,
      [specId],
    )
  ).rows[0];
  return event ? event.at.getTime() : now.getTime();
}

function queuedSpans(
  events: readonly {
    job_id: number | null;
    at: Date;
    to_state: string | null;
  }[],
): Span[] {
  const byJob = new Map<
    number,
    { job_id: number | null; at: Date; to_state: string | null }[]
  >();
  for (const event of events) {
    if (event.job_id === null) continue;
    const list = byJob.get(event.job_id) ?? [];
    list.push(event);
    byJob.set(event.job_id, list);
  }
  const spans: Span[] = [];
  for (const rows of byJob.values()) {
    let queuedAt: number | null = null;
    for (const row of rows) {
      if (row.to_state === "queued") queuedAt = row.at.getTime();
      else if (queuedAt !== null) {
        spans.push({ startMs: queuedAt, endMs: row.at.getTime() });
        queuedAt = null;
      }
    }
    if (queuedAt !== null) spans.push({ startMs: queuedAt, endMs: null });
  }
  return spans;
}

// A ticket whose edges are satisfied but that has no job yet is waiting for a 名额, which is 排队
// (docs/specs/m3-platform.md「工期四段与度量页」). Tickets still waiting on a blocker are 等人.
async function slotWaits(
  pool: pg.Pool,
  specId: number,
  confirmAt: number,
  endAt: number,
): Promise<Span[]> {
  const rows = await pool.query<{
    state: string;
    created_at: Date;
    blockers: number;
    ready_at: Date | null;
    queued_at: Date | null;
  }>(
    `SELECT t.state, t.created_at,
            (SELECT count(*)::int FROM edges e WHERE e.to_ticket_id = t.id) AS blockers,
            (SELECT max(ev.at) FROM events ev
               JOIN edges e ON e.from_ticket_id = ev.ticket_id
              WHERE e.to_ticket_id = t.id AND ev.type = 'ticket' AND ev.to_state = 'done') AS ready_at,
            (SELECT min(ev.at) FROM events ev
              WHERE ev.ticket_id = t.id AND ev.type = 'ticket'
                AND ev.from_state = 'pending' AND ev.to_state = 'queued') AS queued_at
     FROM tickets t WHERE t.spec_id = $1 AND t.state <> 'cancelled'`,
    [specId],
  );
  const spans: Span[] = [];
  for (const row of rows.rows) {
    const readyMs = row.ready_at?.getTime();
    const startMs =
      row.blockers > 0
        ? (readyMs ?? null)
        : Math.max(confirmAt, row.created_at.getTime());
    if (startMs === null) continue;
    const endMs =
      row.queued_at?.getTime() ?? (row.state === "pending" ? endAt : null);
    if (endMs === null || endMs <= startMs) continue;
    spans.push({ startMs, endMs });
  }
  return spans;
}
