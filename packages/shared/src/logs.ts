import { ymdInZone } from "./metrics.ts";

// What one upload of run log text may hold; the API refuses more, so a worker cuts what it sends into pieces of this size.
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024;

export function purgedLogMessage(purgedAt: Date | string): string {
  const at = typeof purgedAt === "string" ? new Date(purgedAt) : purgedAt;
  return `日志已于 ${ymdInZone(at)} 按保留策略清理`;
}
