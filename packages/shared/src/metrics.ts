// Weekly buckets for the metrics page (docs/specs/m3-platform.md「工期四段与度量页」).
// Weeks are Monday–Sunday in Asia/Shanghai, the same calendar the rest of the page shows.

export const METRICS_WEEKS = 12;
export const PLATFORM_FAILURE_RATE_LINE = 0.03;
export const METRICS_TIME_ZONE = "Asia/Shanghai";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdInZone(at: Date, timeZone = METRICS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function weekdayInZone(at: Date, timeZone = METRICS_TIME_ZONE): number {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

// Monday of the week that contains `at`, as YYYY-MM-DD in Asia/Shanghai.
export function weekStartYmd(at: Date): string {
  const ymd = ymdInZone(at);
  const [year, month, day] = ymd.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const wd = weekdayInZone(at);
  const back = wd === 0 ? 6 : wd - 1;
  const monday = new Date(Date.UTC(year, month - 1, day - back));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

export function lastWeekStarts(now: Date, count = METRICS_WEEKS): string[] {
  const thisWeek = weekStartYmd(now);
  const [year, month, day] = thisWeek.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const monday = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(monday - (count - 1 - i) * 7 * 86_400_000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  });
}

export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const even = sorted.length % 2 === 0;
  const left = sorted[even ? mid - 1 : mid];
  const right = sorted[mid];
  if (left === undefined || right === undefined) return null;
  return even ? Math.round((left + right) / 2) : right;
}
