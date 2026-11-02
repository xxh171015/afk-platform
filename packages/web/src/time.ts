// Relative Chinese units for clocks on the page; the hover title is absolute UTC.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const then = new Date(iso).getTime();
  const delta = now.getTime() - then;
  if (!Number.isFinite(then)) return iso;
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.round(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.round(delta / HOUR)} 小时前`;
  return `${Math.round(delta / DAY)} 天前`;
}

export function formatElapsed(ms: number): string {
  if (ms < MINUTE) return "不到 1 分钟";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} 分钟`;
  return `${Math.round(ms / HOUR)} 小时`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.floor(seconds);
  if (whole < 3600)
    return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor(whole / 60) % 60).padStart(2, "0")}m`;
}

export function formatSeconds(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms / 1000)} s`;
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}
