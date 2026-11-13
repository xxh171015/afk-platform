import { generatedConflictShare } from "@afk/shared";
import type pg from "pg";

// Counts #286 can compute from a spec's events (US58): push refusals, takeovers, orphans.

export type SpecEventMetrics = {
  branchMoved: number;
  hostPermission: number;
  manualTakeover: number;
  platformTakeover: number;
  orphans: number;
  generatedOnlyConflictShare: number | undefined;
};

export async function specEventMetrics(
  pool: pg.Pool | pg.PoolClient,
  specId: number,
): Promise<SpecEventMetrics> {
  const events = await pool.query<{
    branch_moved: string;
    host_permission: string;
    manual_takeover: string;
    platform_takeover: string;
    orphans: string;
  }>(
    `SELECT
       count(*) FILTER (
         WHERE reason = 'branch-moved' OR data->>'reason' = 'branch-moved'
       )::text AS branch_moved,
       count(*) FILTER (
         WHERE data->>'pushError' = 'host-permission'
       )::text AS host_permission,
       count(*) FILTER (
         WHERE type = 'action' AND data->>'action' = 'takeover'
           AND data->>'reason' IS NULL
       )::text AS manual_takeover,
       count(*) FILTER (
         WHERE type = 'action' AND data->>'action' = 'takeover'
           AND data->>'reason' IS NOT NULL
       )::text AS platform_takeover,
       count(*) FILTER (WHERE data ? 'orphanSha')::text AS orphans
     FROM events WHERE spec_id = $1`,
    [specId],
  );
  const merges = await pool.query<{ generated: boolean }>(
    `SELECT (output->>'generatedOnlyConflict')::boolean AS generated
     FROM runs
     WHERE spec_id = $1 AND stage IN ('merge', 'final-merge', 'update-branch')
       AND output ? 'generatedOnlyConflict'`,
    [specId],
  );
  const row = events.rows[0];
  return {
    branchMoved: Number(row?.branch_moved ?? 0),
    hostPermission: Number(row?.host_permission ?? 0),
    manualTakeover: Number(row?.manual_takeover ?? 0),
    platformTakeover: Number(row?.platform_takeover ?? 0),
    orphans: Number(row?.orphans ?? 0),
    generatedOnlyConflictShare: generatedConflictShare(
      merges.rows.map((item) => ({ generatedOnlyConflict: item.generated })),
    ),
  };
}
