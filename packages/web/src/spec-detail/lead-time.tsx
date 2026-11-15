import { LEAD_TIME_LABELS, type LeadTimeSegment } from "@afk/shared";
import { LEAD_TIME_BAR } from "../lead-time-bar.ts";
import { cn } from "../lib/utils.ts";
import { formatCompactDuration } from "../time.ts";

export function LeadTimeBar({
  leadTime,
}: {
  leadTime: {
    agentMs: number;
    gateMs: number;
    queuedMs: number;
    waitingMs: number;
    totalMs: number;
  };
}) {
  const ms: Record<LeadTimeSegment, number> = {
    agent: leadTime.agentMs,
    gate: leadTime.gateMs,
    queued: leadTime.queuedMs,
    waiting: leadTime.waitingMs,
  };
  const total = Math.max(leadTime.totalMs, 1);
  return (
    <div className="sm:col-span-2" data-testid="lead-time">
      <dt className="text-xs text-muted-foreground">工期</dt>
      <dd className="mt-1">
        <div
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`工期 ${formatCompactDuration(leadTime.totalMs)}`}
        >
          {LEAD_TIME_BAR.map((seg) =>
            ms[seg.key] > 0 ? (
              <div
                key={seg.key}
                className={cn("h-full", seg.cls)}
                style={{ width: `${(ms[seg.key] / total) * 100}%` }}
                title={`${LEAD_TIME_LABELS[seg.key]} ${formatCompactDuration(ms[seg.key])}`}
              />
            ) : null,
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatCompactDuration(leadTime.totalMs)}
          {" · "}
          {LEAD_TIME_BAR.map(
            (seg) =>
              `${LEAD_TIME_LABELS[seg.key]} ${formatCompactDuration(ms[seg.key])}`,
          ).join(" · ")}
        </p>
      </dd>
    </div>
  );
}
