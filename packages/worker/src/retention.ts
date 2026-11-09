import { join } from "node:path";
import { pruneSnapshots, SNAPSHOT_MAX_AGE_MS } from "./snapshots.ts";

// sandbox-logs, salvage and snapshots under the worker home, deleted after their retention (14 / 30 / 7 days,
// $AFK_*_RETENTION_DAYS to change). Same rule as pruneSnapshots: a name unused that long is gone.

const DAY_MS = 24 * 60 * 60 * 1000;

function days(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function retainWorkerFiles(options: {
  home: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): { sandboxLogs: number; salvage: number; snapshots: number } {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  return {
    sandboxLogs: pruneSnapshots(
      join(options.home, "sandbox-logs"),
      days("AFK_SANDBOX_LOG_RETENTION_DAYS", 14, env) * DAY_MS,
      now,
    ).length,
    salvage: pruneSnapshots(
      join(options.home, "salvage"),
      days("AFK_SALVAGE_RETENTION_DAYS", 30, env) * DAY_MS,
      now,
    ).length,
    snapshots: pruneSnapshots(
      join(options.home, "snapshots"),
      days("AFK_SNAPSHOT_RETENTION_DAYS", SNAPSHOT_MAX_AGE_MS / DAY_MS, env) *
        DAY_MS,
      now,
    ).length,
  };
}
