// Disk remaining-space alerts (docs/specs/m3-platform.md「日志、保留与磁盘」). Thresholds are bytes; env
// overrides are whole GiB. A notice fires when a threshold is crossed downward, not again until we recover
// above it and drop below once more.

export const GIB = 1024 ** 3;
export const DEFAULT_DISK_WARN_GIB = 10;
export const DEFAULT_DISK_STOP_GIB = 5;
export const DEFAULT_DISK_WARN_BYTES = DEFAULT_DISK_WARN_GIB * GIB;
export const DEFAULT_DISK_STOP_BYTES = DEFAULT_DISK_STOP_GIB * GIB;

export type DiskLevel = "ok" | "warn" | "stop";
export const DISK_NOTICED = ["none", "warn", "stop"] as const;
export type DiskNoticed = (typeof DISK_NOTICED)[number];

export function diskGib(
  name: string,
  fallback: number,
  env = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function diskLevel(
  freeBytes: number,
  warnBytes = DEFAULT_DISK_WARN_BYTES,
  stopBytes = DEFAULT_DISK_STOP_BYTES,
): DiskLevel {
  if (freeBytes < stopBytes) return "stop";
  if (freeBytes < warnBytes) return "warn";
  return "ok";
}

export function advanceDiskAlert(
  noticed: DiskNoticed,
  freeBytes: number,
  warnBytes = DEFAULT_DISK_WARN_BYTES,
  stopBytes = DEFAULT_DISK_STOP_BYTES,
): { level: DiskLevel; noticed: DiskNoticed; notices: Array<"warn" | "stop"> } {
  const level = diskLevel(freeBytes, warnBytes, stopBytes);
  if (level === "ok") return { level, noticed: "none", notices: [] };
  if (level === "warn") {
    return {
      level,
      noticed: "warn",
      notices: noticed === "none" ? ["warn"] : [],
    };
  }
  const notices: Array<"warn" | "stop"> = [];
  if (noticed === "none") notices.push("warn");
  if (noticed !== "stop") notices.push("stop");
  return { level, noticed: "stop", notices };
}

export function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function formatDiskBytes(bytes: number): string {
  if (bytes < GIB) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return formatGib(bytes);
}
