const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TIME_ZONE = "Asia/Shanghai";

function shanghaiParts(
  iso: string,
  extra: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormatPart[] | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...extra,
  }).formatToParts(date);
}

const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
  parts.find((item) => item.type === type)?.value ?? "";

export function formatShanghaiTime(iso: string): string {
  const parts = shanghaiParts(iso);
  if (!parts) return iso;
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${part(parts, "hour")}:${part(parts, "minute")}`;
}

export function formatShanghaiDay(iso: string): string {
  const parts = shanghaiParts(iso);
  if (!parts) return iso;
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

export function formatAbsoluteTime(iso: string): string {
  const parts = shanghaiParts(iso, { second: "2-digit" });
  if (!parts) return iso;
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`;
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

export function formatCompactDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

export function formatSeconds(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms / 1000)} s`;
}
