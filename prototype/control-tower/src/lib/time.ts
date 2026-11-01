import { formatDistanceStrict } from "date-fns";
import { zhCN } from "date-fns/locale";

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.floor(seconds);
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor(whole / 60) % 60).padStart(2, "0")}m`;
}

export function relativeTime(value: string, now: Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return formatDistanceStrict(date, now, { locale: zhCN, addSuffix: true });
}

export function absoluteTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : "—";
}