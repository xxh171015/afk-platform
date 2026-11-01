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

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}
