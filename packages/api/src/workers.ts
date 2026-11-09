import type pg from "pg";

// The workbench status area shows how much the last worker sweep deleted. The worker posts the counts; this
// writes the one row for that worker, replacing the previous report.

export interface WorkerCleanupReport {
  sandboxLogs: number;
  salvage: number;
  snapshots: number;
}

export async function recordWorkerCleanup(
  pool: Pick<pg.Pool, "query">,
  workerId: string,
  cleaned: WorkerCleanupReport,
  now: Date = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, reported_at, cleaned_sandbox_logs, cleaned_salvage, cleaned_snapshots)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       reported_at = EXCLUDED.reported_at,
       cleaned_sandbox_logs = EXCLUDED.cleaned_sandbox_logs,
       cleaned_salvage = EXCLUDED.cleaned_salvage,
       cleaned_snapshots = EXCLUDED.cleaned_snapshots`,
    [workerId, now, cleaned.sandboxLogs, cleaned.salvage, cleaned.snapshots],
  );
}
