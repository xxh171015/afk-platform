import { formatDiskBytes, formatGib } from "@afk/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { describeError, useApi } from "./api.tsx";
import { Mono, Pill } from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, RowsSkeleton, StaleNotice } from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { useEvents, useResourcePoll } from "./EventsProvider.tsx";
import { useNow } from "./hooks/use-now.ts";
import { jobTypeLabel, stageLabel } from "./lib/labels.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { formatAbsoluteTime, formatDuration } from "./time.ts";
import { WORKBENCH_KEY } from "./Workbench.tsx";

export const RUNTIME_KEY = ["runtime"] as const;

type RuntimeJob = {
  id: number;
  type: string;
  state: "running" | "queued";
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lockKey: string | null;
  notBefore: string | null;
  label: string;
  stage: string | null;
  specId: number | null;
  specDisplayId: string | null;
  ticketId: number | null;
  ticketDisplayId: string | null;
  runId: number | null;
};

function stageText(stage: string | null, type: string): string {
  if (stage && stageLabel[stage]) return stageLabel[stage];
  return jobTypeLabel[type] ?? type;
}

function LeaseRemaining({
  leaseExpiresAt,
  now,
}: {
  leaseExpiresAt: string;
  now: number;
}) {
  const ms = new Date(leaseExpiresAt).getTime() - now;
  if (ms <= 0) {
    return <span className="text-state-blocked">租约已到期</span>;
  }
  return <span>{formatDuration(ms)} 后到期</span>;
}

function JobLinks({ job }: { job: RuntimeJob }) {
  return (
    <span className="flex flex-wrap gap-2">
      {job.runId !== null ? (
        <a
          href={paths.run(job.runId)}
          className="font-mono text-xs text-primary hover:underline"
        >
          R-{job.runId}
        </a>
      ) : null}
      {job.ticketId !== null ? (
        <a
          href={paths.ticket(job.ticketId)}
          className="font-mono text-xs text-primary hover:underline"
        >
          {job.ticketDisplayId}
        </a>
      ) : null}
      {job.specId !== null ? (
        <a
          href={paths.spec(job.specId)}
          className="font-mono text-xs text-primary hover:underline"
        >
          {job.specDisplayId}
        </a>
      ) : null}
    </span>
  );
}

function JobTable({
  jobs,
  showLease,
  now,
}: {
  jobs: RuntimeJob[];
  showLease: boolean;
  now: number;
}) {
  if (jobs.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">没有作业</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-2 py-2 font-medium">作业</th>
            <th className="px-2 py-2 font-medium">类型</th>
            <th className="px-2 py-2 font-medium">阶段</th>
            {showLease ? (
              <th className="px-2 py-2 font-medium">Worker</th>
            ) : null}
            {showLease ? (
              <th className="px-2 py-2 font-medium">租约</th>
            ) : (
              <th className="px-2 py-2 font-medium">最早领取</th>
            )}
            <th className="px-2 py-2 font-medium">链接</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b align-top hover:bg-accent/30">
              <td className="max-w-[280px] px-2 py-2.5">
                <div className="font-medium">{job.label}</div>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                  #{job.id} · attempt {job.attempt}
                  {job.lockKey ? ` · lock ${job.lockKey}` : null}
                </div>
              </td>
              <td className="px-2 py-2.5">
                <Mono>{job.type}</Mono>
              </td>
              <td className="px-2 py-2.5">{stageText(job.stage, job.type)}</td>
              {showLease ? (
                <td className="px-2 py-2.5 font-mono text-xs">
                  {job.leaseOwner ?? "—"}
                </td>
              ) : null}
              <td className="px-2 py-2.5 text-xs text-muted-foreground">
                {showLease && job.leaseExpiresAt ? (
                  <LeaseRemaining
                    leaseExpiresAt={job.leaseExpiresAt}
                    now={now}
                  />
                ) : job.notBefore ? (
                  <>
                    等到 <RelativeTime iso={job.notBefore} />
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-2 py-2.5">
                <JobLinks job={job} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        {title}
        {count !== undefined ? (
          <span className="ml-auto font-mono text-xs font-normal text-muted-foreground tabular">
            {count}
          </span>
        ) : null}
      </h2>
      <div className="px-2 py-1">{children}</div>
    </section>
  );
}

export function Runtime() {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  const live = useEvents();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: RUNTIME_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/runtime");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const hasRunning = (view.data?.jobs.running.length ?? 0) > 0;
  const now = useNow(hasRunning, 1000);

  const resume = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/agents/resume");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RUNTIME_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKBENCH_KEY });
    },
  });

  const heldById = useMemo(() => {
    const map = new Map<number, RuntimeJob>();
    for (const job of view.data?.jobs.running ?? []) {
      map.set(job.id, job);
    }
    return map;
  }, [view.data?.jobs.running]);

  if (view.isPending) {
    return (
      <Page title="运行实例">
        <p className="sr-only">加载运行状态…</p>
        <RowsSkeleton rows={10} />
      </Page>
    );
  }

  if (view.isError && !view.data) {
    return (
      <Page title="运行实例">
        <ErrorState
          error={view.error}
          onRetry={() => void view.refetch()}
        />
      </Page>
    );
  }

  const data = view.data;
  if (!data) return null;

  const { status } = data;
  const diskTone =
    status.diskLevel === "stop"
      ? "text-state-blocked"
      : status.diskLevel === "warn"
        ? "text-state-paused"
        : "text-muted-foreground";

  return (
    <Page
      title="运行实例"
      subtitle="作业队列、worker 与平台部署状态。持租列表在 SSE 断开时每 3 秒刷新；租约倒计时本地每秒更新。"
      actions={<StaleNotice error={view.error} />}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Pill tone="neutral">
          实例 <Mono>{data.instance.id}</Mono>
        </Pill>
        <Pill tone="running">
          持租 {data.summary.running} · 排队 {data.summary.queued}
        </Pill>
        <Pill tone="neutral" dot={false}>
          实时连接 {live?.connected ? "SSE 已连接" : "轮询中"}
        </Pill>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Section title="平台状态">
          <dl className="space-y-2 px-2 py-3 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">日志目录</dt>
              <dd className="font-mono tabular">
                {formatDiskBytes(status.logDirBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">API 剩余空间</dt>
              <dd className={`font-mono tabular ${diskTone}`}>
                {formatGib(status.apiFreeBytes)}
                {status.diskLevel !== "ok"
                  ? `（低于 ${status.diskLevel === "stop" ? status.stopGib : status.warnGib} GiB）`
                  : null}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">最近清理</dt>
              <dd>
                {status.lastCleanup.at
                  ? `${status.lastCleanup.runs} 个 Run · ${status.lastCleanup.orphans} 个孤儿目录`
                  : "尚未清理"}
              </dd>
            </div>
            {status.agentsPaused ? (
              <div className="mt-3 rounded-md border border-state-blocked/30 bg-state-blocked/10 px-3 py-2">
                <p className="text-state-blocked">
                  Agent 已暂停（自{" "}
                  {formatAbsoluteTime(status.agentsPaused.since)}）
                </p>
                <p
                  className="mt-1 truncate text-xs opacity-80"
                  title={status.agentsPaused.reason}
                >
                  {status.agentsPaused.reason}
                </p>
                {status.agentsPaused.nextProbeAt ? (
                  <p className="mt-1 text-xs">
                    下次探活{" "}
                    {formatAbsoluteTime(status.agentsPaused.nextProbeAt)}
                  </p>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className="mt-2"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate()}
                >
                  恢复 Agent
                </Button>
              </div>
            ) : null}
          </dl>
        </Section>

        <Section title="Worker" count={data.workers.length}>
          {data.workers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有 worker 上报
            </p>
          ) : (
            <ul className="divide-y px-2 py-1">
              {data.workers.map((worker) => {
                const held =
                  worker.heldJobId !== null
                    ? heldById.get(worker.heldJobId)
                    : undefined;
                return (
                  <li
                    key={worker.id}
                    className="flex flex-wrap items-start justify-between gap-2 py-3 text-[13px]"
                  >
                    <div>
                      <span className="font-mono font-medium">{worker.id}</span>
                      <p className="mt-1 text-xs text-muted-foreground">
                        剩余{" "}
                        {worker.freeBytes === null
                          ? "未知"
                          : formatGib(worker.freeBytes)}
                        {" · 上报 "}
                        <RelativeTime iso={worker.reportedAt} />
                      </p>
                      <p className="text-xs text-muted-foreground">
                        清理 sandbox-logs {worker.cleaned.sandboxLogs}、salvage{" "}
                        {worker.cleaned.salvage}、snapshots{" "}
                        {worker.cleaned.snapshots}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      {held ? (
                        <>
                          <span className="text-muted-foreground">持租 </span>
                          <span className="font-mono">#{held.id}</span>
                          <p className="mt-0.5 max-w-[240px] truncate">
                            {held.label}
                          </p>
                        </>
                      ) : (
                        <span className="text-muted-foreground">空闲</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="持租作业" count={data.jobs.running.length}>
          <JobTable jobs={data.jobs.running} showLease now={now} />
        </Section>
        <Section title="排队作业" count={data.summary.queued}>
          {data.summary.queued > data.jobs.queued.length ? (
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              仅显示最早 {data.jobs.queued.length} 条（共 {data.summary.queued}{" "}
              条）
            </p>
          ) : null}
          <JobTable jobs={data.jobs.queued} showLease={false} now={now} />
        </Section>
      </div>
    </Page>
  );
}