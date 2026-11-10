import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";
import type { LogStore } from "./log-store.ts";

// Run logs of a spec that has been merged or cancelled this many days are deleted; the Run rows stay.
// $AFK_LOG_RETENTION_DAYS overrides the default (docs/specs/m3-platform.md「日志、保留与磁盘」).
export const DEFAULT_LOG_RETENTION_DAYS = 90;

export function logRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AFK_LOG_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_LOG_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LOG_RETENTION_DAYS;
}

const isNotFound = (error: unknown) =>
  (error as { code?: string }).code === "ENOENT";

const ORPHAN_RUN_DIR = /^run-\d+$/;

// Directories named run-<n> at the logs root, left from before logs lived under an instance id. Does not
// walk into instance subdirectories and does not touch files or other names.
async function removeOrphanRunDirs(root: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let n = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !ORPHAN_RUN_DIR.test(entry.name)) continue;
    await rm(resolve(root, entry.name), { recursive: true, force: true });
    n++;
  }
  return n;
}

export async function retainLogs(options: {
  pool: pg.Pool;
  logs: LogStore;
  now: Date;
  retentionDays?: number;
  logDir?: string;
  orphanRoot?: string;
}): Promise<{ purgedRuns: number; purgedOrphans: number }> {
  let purgedOrphans = 0;
  if (
    options.orphanRoot &&
    (!options.logDir || resolve(options.orphanRoot) !== resolve(options.logDir))
  ) {
    purgedOrphans = await removeOrphanRunDirs(options.orphanRoot);
  }

  const days = options.retentionDays ?? logRetentionDays();
  const expired = await options.pool.query<{ id: number }>(
    `WITH ended AS (
       SELECT s.id,
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
       WHERE s.state IN ('merged', 'cancelled') AND s.logs_purged_at IS NULL
     )
     SELECT id FROM ended
      WHERE ended_at IS NOT NULL
        AND ended_at + make_interval(days => $2::int) <= $1::timestamptz`,
    [options.now, days],
  );

  let purgedRuns = 0;
  for (const spec of expired.rows) {
    const runs = await options.pool.query<{ id: number }>(
      "SELECT id FROM runs WHERE spec_id = $1",
      [spec.id],
    );
    for (const run of runs.rows) {
      if (await options.logs.remove(run.id)) purgedRuns++;
    }
    await options.pool.query(
      "UPDATE specs SET logs_purged_at = $2 WHERE id = $1 AND logs_purged_at IS NULL",
      [spec.id, options.now],
    );
  }

  await options.pool.query(
    `UPDATE instance SET logs_purged_at = $1, logs_purged_runs = $2, logs_purged_orphans = $3`,
    [options.now, purgedRuns, purgedOrphans],
  );

  return { purgedRuns, purgedOrphans };
}
