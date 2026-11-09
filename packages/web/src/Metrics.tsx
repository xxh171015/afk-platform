import {
  FAILURE_SOURCE_LABELS,
  type FailureSource,
  LEAD_TIME_LABELS,
  type LeadTimeSegment,
  PLATFORM_FAILURE_RATE_LINE,
  pauseReasonLabel,
} from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, RowsSkeleton } from "./components/afk/states.tsx";
import { LEAD_TIME_BAR } from "./lead-time-bar.ts";
import { cn } from "./lib/utils.ts";
import { paths } from "./paths.ts";
import { blockedReasonLabel } from "./status.ts";
import { formatCompactDuration } from "./time.ts";

type Week = {
  weekStart: string;
  leadTime: {
    ended: number;
    medianMs: number | null;
    agentMs: number;
    gateMs: number;
    queuedMs: number;
    waitingMs: number;
    specs: {
      id: number;
      displayId: string;
      title: string;
      totalMs: number;
    }[];
  };
  attribution: {
    recovered: { source: FailureSource; reason: string; count: number }[];
    needsHuman: { source: FailureSource; reason: string; count: number }[];
  };
  failureRate: {
    ended: number;
    platform: number | null;
    external: number | null;
    jobPlatform: number | null;
  };
};

const LEAD_MS: Record<LeadTimeSegment, (week: Week) => number> = {
  agent: (week) => week.leadTime.agentMs,
  gate: (week) => week.leadTime.gateMs,
  queued: (week) => week.leadTime.queuedMs,
  waiting: (week) => week.leadTime.waitingMs,
};

function reasonLabel(reason: string): string {
  const pause = pauseReasonLabel(reason);
  if (pause !== reason) return pause;
  return blockedReasonLabel(reason);
}

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export function Metrics() {
  const api = useApi();
  const [projectId, setProjectId] = useState<string>("all");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects");
      if (!data) throw new Error(describeError(error));
      return data.projects;
    },
  });
  const metrics = useQuery({
    queryKey: ["metrics", projectId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        "/metrics",
        projectId === "all"
          ? {}
          : { params: { query: { projectId: Number(projectId) } } },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });

  if (metrics.isPending)
    return (
      <Page title="度量">
        <p className="sr-only">加载度量…</p>
        <RowsSkeleton rows={8} />
      </Page>
    );
  if (metrics.isError || !metrics.data)
    return (
      <Page title="度量">
        <ErrorState
          error={metrics.error ?? new Error("无法加载度量")}
          prefix="无法加载度量"
          onRetry={() => void metrics.refetch()}
        />
      </Page>
    );

  const weeks = metrics.data.weeks;
  return (
    <Page
      title="度量"
      subtitle={
        metrics.data.since
          ? `数据从 ${metrics.data.since} 起`
          : "还没有度量数据"
      }
      actions={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">项目</span>
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label="项目"
          >
            <option value="all">全部</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <section className="mb-8" data-testid="metrics-lead-time">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="size-4" />
          工期
        </h2>
        <p className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {LEAD_TIME_BAR.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1">
              <span className={cn("size-2 rounded-sm", seg.cls)} />
              {LEAD_TIME_LABELS[seg.key]}
            </span>
          ))}
        </p>
        <ul className="space-y-3">
          {weeks.map((week) => (
            <LeadWeek key={week.weekStart} week={week} />
          ))}
        </ul>
      </section>

      <section className="mb-8" data-testid="metrics-attribution">
        <h2 className="mb-3 text-sm font-semibold">失败归因</h2>
        <ul className="space-y-4">
          {weeks.map((week) => (
            <WeekAttribution key={week.weekStart} week={week} />
          ))}
        </ul>
      </section>

      <section data-testid="metrics-failure-rate">
        <h2 className="mb-3 text-sm font-semibold">平台故障率</h2>
        <FailureRateChart weeks={weeks} />
      </section>
    </Page>
  );
}

function LeadWeek({ week }: { week: Week }) {
  const total =
    week.leadTime.agentMs +
    week.leadTime.gateMs +
    week.leadTime.queuedMs +
    week.leadTime.waitingMs;
  return (
    <li>
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-mono tabular">{week.weekStart}</span>
        <span className="text-muted-foreground">
          {week.leadTime.ended} 个
          {week.leadTime.medianMs !== null
            ? ` · 中位 ${formatCompactDuration(week.leadTime.medianMs)}`
            : ""}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {total > 0
          ? LEAD_TIME_BAR.map((seg) => {
              const ms = LEAD_MS[seg.key](week);
              return ms > 0 ? (
                <div
                  key={seg.key}
                  className={cn("h-full", seg.cls)}
                  style={{ width: `${(ms / total) * 100}%` }}
                  title={`${LEAD_TIME_LABELS[seg.key]} ${formatCompactDuration(ms)}`}
                />
              ) : null;
            })
          : null}
      </div>
      {week.leadTime.specs.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {week.leadTime.specs.map((spec) => (
            <li key={spec.id}>
              <a
                href={paths.spec(spec.id)}
                className="text-primary hover:underline"
              >
                {spec.displayId} {spec.title}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">无</p>
      )}
    </li>
  );
}

function WeekAttribution({ week }: { week: Week }) {
  const empty =
    week.attribution.needsHuman.length === 0 &&
    week.attribution.recovered.length === 0;
  return (
    <li>
      <div className="mb-1 font-mono text-xs tabular">{week.weekStart}</div>
      {empty ? (
        <p className="text-sm text-muted-foreground">无</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <AttributionTable
            title="要人处理"
            rows={week.attribution.needsHuman}
          />
          <AttributionTable
            title="自动恢复"
            rows={week.attribution.recovered}
          />
        </div>
      )}
    </li>
  );
}

function AttributionTable({
  title,
  rows,
}: {
  title: string;
  rows: { source: FailureSource; reason: string; count: number }[];
}) {
  const merged = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.source}:${row.reason}`;
    const acc = merged.get(key) ?? { ...row, count: 0 };
    acc.count += row.count;
    merged.set(key, acc);
  }
  const list = [...merged.values()].sort((a, b) => b.count - a.count);
  return (
    <div>
      <h3 className="mb-2 text-xs text-muted-foreground">{title}</h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">无</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {list.map((row) => (
              <tr key={`${row.source}:${row.reason}`}>
                <td className="py-1 pr-2">
                  {FAILURE_SOURCE_LABELS[row.source]}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">
                  {reasonLabel(row.reason)}
                </td>
                <td className="py-1 text-right font-mono tabular">
                  {row.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FailureRateChart({ weeks }: { weeks: Week[] }) {
  const max = Math.max(
    0.1,
    ...weeks.flatMap((week) => [
      week.failureRate.platform ?? 0,
      week.failureRate.external ?? 0,
      week.failureRate.jobPlatform ?? 0,
    ]),
  );
  const lineY = 100 - (PLATFORM_FAILURE_RATE_LINE / max) * 100;
  const bar = (value: number | null, cls: string) => (
    <div
      className={cn("w-1/3", cls)}
      style={{ height: `${Math.min(100, ((value ?? 0) / max) * 100)}%` }}
    />
  );
  return (
    <div>
      <div
        className="relative h-40 w-full rounded-md border bg-card"
        data-testid="failure-rate-chart"
      >
        <div
          className="absolute inset-x-0 border-t border-dashed border-state-blocked"
          style={{ top: `${lineY}%` }}
          data-testid="failure-rate-line"
          title="3%"
        />
        <div className="absolute inset-0 flex items-end gap-1 px-2 pb-1">
          {weeks.map((week) => (
            <div
              key={week.weekStart}
              className="flex h-full flex-1 items-end justify-center gap-px"
              title={`${week.weekStart} 平台 ${pct(week.failureRate.platform)} 外部 ${pct(week.failureRate.external)} 作业 ${pct(week.failureRate.jobPlatform)}`}
            >
              {bar(week.failureRate.platform, "bg-state-blocked")}
              {bar(week.failureRate.external, "bg-state-paused")}
              {bar(week.failureRate.jobPlatform, "bg-state-neutral")}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        虚线 3% · 平台 · 外部服务 · 作业失败率
      </p>
    </div>
  );
}
