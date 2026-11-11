import type { Dirent } from "node:fs";
import { mkdir, readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  advanceDiskAlert,
  DEFAULT_DISK_STOP_GIB,
  DEFAULT_DISK_WARN_GIB,
  type DiskLevel,
  type DiskNoticed,
  diskGib,
  GIB,
} from "@afk/shared";
import type pg from "pg";
import { recordSystemEvent } from "./events/system.ts";

export interface DiskSample {
  freeBytes: number;
  dirBytes: number;
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      try {
        total += (await stat(path)).size;
      } catch {
        // Size is a snapshot: a file deleted mid-walk is already gone from disk.
      }
    }
  };
  await walk(root);
  return total;
}

export async function volumeFreeBytes(path: string): Promise<number> {
  await mkdir(path, { recursive: true }).catch(() => undefined);
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return 0;
  }
}

export async function sampleDisk(path: string): Promise<DiskSample> {
  return {
    freeBytes: await volumeFreeBytes(path),
    dirBytes: await directorySize(path),
  };
}

function thresholds() {
  const warnGib = diskGib("AFK_DISK_WARN_GIB", DEFAULT_DISK_WARN_GIB);
  const stopGib = diskGib("AFK_DISK_STOP_GIB", DEFAULT_DISK_STOP_GIB);
  return {
    warnGib,
    stopGib,
    warnBytes: warnGib * GIB,
    stopBytes: stopGib * GIB,
  };
}

interface WorkbenchStatus {
  logDirBytes: number;
  apiFreeBytes: number;
  diskLevel: DiskLevel;
  warnGib: number;
  stopGib: number;
  lastCleanup: {
    at: string | null;
    runs: number;
    orphans: number;
  };
  workers: Array<{
    id: string;
    reportedAt: string;
    freeBytes: number | null;
    cleaned: { sandboxLogs: number; salvage: number; snapshots: number };
  }>;
}

export async function claimsStopped(
  pool: Pick<pg.Pool, "query">,
  workerId: string,
  apiFreeBytes: number,
): Promise<boolean> {
  const stopBytes = thresholds().stopBytes;
  if (apiFreeBytes < stopBytes) return true;
  const row = await pool.query<{ free_bytes: string | null }>(
    "SELECT free_bytes FROM workers WHERE id = $1",
    [workerId],
  );
  const workerFree = row.rows[0]?.free_bytes;
  return workerFree != null && Number(workerFree) < stopBytes;
}

export async function refreshDiskStatus(
  pool: Pick<pg.Pool, "query">,
  sample: DiskSample,
): Promise<WorkbenchStatus> {
  const { warnGib, stopGib, warnBytes, stopBytes } = thresholds();
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
  const frees = [
    sample.freeBytes,
    ...workers.rows.flatMap((row) =>
      row.free_bytes === null ? [] : [Number(row.free_bytes)],
    ),
  ];
  const worst = Math.min(...frees);
  const current = await pool.query<{ disk_noticed: DiskNoticed }>(
    "SELECT disk_noticed FROM instance",
  );
  const next = advanceDiskAlert(
    current.rows[0]?.disk_noticed ?? "none",
    worst,
    warnBytes,
    stopBytes,
  );
  await pool.query(
    `UPDATE instance SET log_dir_bytes = $1, log_dir_free_bytes = $2, disk_noticed = $3`,
    [sample.dirBytes, sample.freeBytes, next.noticed],
  );
  for (const kind of next.notices) {
    await recordSystemEvent(
      pool,
      kind === "warn"
        ? { kind: "disk-warn", warnGib }
        : { kind: "disk-stop", stopGib },
    );
  }
  const instance = await pool.query<{
    logs_purged_at: Date | null;
    logs_purged_runs: number;
    logs_purged_orphans: number;
  }>(
    "SELECT logs_purged_at, logs_purged_runs, logs_purged_orphans FROM instance",
  );
  const row = instance.rows[0];
  return {
    logDirBytes: sample.dirBytes,
    apiFreeBytes: sample.freeBytes,
    diskLevel: next.level,
    warnGib,
    stopGib,
    lastCleanup: {
      at: row?.logs_purged_at?.toISOString() ?? null,
      runs: row?.logs_purged_runs ?? 0,
      orphans: row?.logs_purged_orphans ?? 0,
    },
    workers: workers.rows.map((worker) => ({
      id: worker.id,
      reportedAt: worker.reported_at.toISOString(),
      freeBytes: worker.free_bytes === null ? null : Number(worker.free_bytes),
      cleaned: {
        sandboxLogs: worker.cleaned_sandbox_logs,
        salvage: worker.cleaned_salvage,
        snapshots: worker.cleaned_snapshots,
      },
    })),
  };
}
