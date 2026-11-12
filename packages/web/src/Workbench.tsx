import { formatDiskBytes, formatGib } from "@afk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ClipboardCheck,
  Inbox,
} from "lucide-react";
import type { ReactNode } from "react";
import { describeError, useApi } from "./api.tsx";
import { Mono, Pill } from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, Skeleton, StaleNotice } from "./components/afk/states.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { feishuClosedMessage } from "./feishu-status.ts";
import { hostKindOfRepos, pullAbbrev } from "./host-copy.ts";
import { stageLabel } from "./lib/labels.ts";
import { LIST_POLL_MS } from "./live.ts";
import { Onboarding, useProjectList } from "./Onboarding.tsx";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { formatElapsed } from "./time.ts";
import { waitingCount } from "./waiting.ts";

export const EMPTY_WAITING = "没有在等你的事。平台在自己跑。";
export const EMPTY_WAITING_SETUP = "没有在等你的事。先接入一个项目。";
export const EMPTY_RUNNING = "没有正在运行的票。";
export const EMPTY_REVIEW = "没有等你验收的需求。";
export const EMPTY_COMPLETED = "还没有已合并的需求。";

export const WORKBENCH_KEY = ["workbench"] as const;

export function useWorkbench() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  return useQuery({
    queryKey: WORKBENCH_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/workbench");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

function Quadrant({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid={`quadrant-${title}`}
      className="min-w-0 border-t"
    >
      <h2 className="flex h-12 items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular">
          {count ?? "—"}
        </span>
      </h2>
      {children}
    </section>
  );
}

function LoadingRows() {
  return (
    <div role="status" aria-label="正在加载" className="space-y-4 py-3">
      {[0, 1, 2].map((n) => (
        <div key={n} className="space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="flex min-h-32 items-center justify-center border-b border-dashed px-4 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}

function ItemLink({
  href,
  displayId,
  title,
  children,
}: {
  href: string;
  displayId: string;
  title: string;
  children?: ReactNode;
}) {
  const external = /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="group block min-w-0 border-b px-2 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 items-start gap-2 text-[13px]">
        <span className="max-w-[45%] shrink-0 break-all font-mono text-xs text-muted-foreground">
          {displayId}
        </span>
        <span className="min-w-0 flex-1 break-words font-medium">{title}</span>
        <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground group-hover:text-foreground" />
      </div>
      {children ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          {children}
        </div>
      ) : null}
    </a>
  );
}

export function Workbench() {
  const board = useWorkbench();
  const projects = useProjectList();
  const data = board.data;

  if (board.isError && !board.data) {
    return (
      <Page title="工作台">
        <ErrorState
          error={board.error}
          prefix="无法加载工作台"
          onRetry={() => void board.refetch()}
        />
      </Page>
    );
  }

  return (
    <Page
      title="工作台"
      actions={<StaleNotice error={data ? board.error : null} />}
    >
      {data ? <Onboarding feishu={data.status?.feishu} /> : null}
      {!data ? (
        <div className="grid grid-cols-2 items-start gap-x-8 gap-y-8">
          <p className="sr-only">加载工作台…</p>
          <Quadrant
            title="等你处理"
            icon={<Inbox className="size-4 text-destructive" />}
          >
            <LoadingRows />
          </Quadrant>
          <Quadrant
            title="正在运行"
            icon={<Activity className="size-4 text-primary" />}
          >
            <LoadingRows />
          </Quadrant>
          <Quadrant
            title="等你验收"
            icon={<ClipboardCheck className="size-4 text-primary" />}
          >
            <LoadingRows />
          </Quadrant>
          <Quadrant
            title="最近完成"
            icon={<CheckCircle2 className="size-4 text-primary" />}
          >
            <LoadingRows />
          </Quadrant>
        </div>
      ) : (
        <div className="grid grid-cols-2 items-start gap-x-8 gap-y-8">
          <Quadrant
            title="等你处理"
            icon={<Inbox className="size-4 text-destructive" />}
            count={waitingCount(data.waiting)}
          >
            {waitingCount(data.waiting) === 0 ? (
              <Empty
                text={
                  projects.data?.length === 0
                    ? EMPTY_WAITING_SETUP
                    : EMPTY_WAITING
                }
              />
            ) : (
              <>
                {data.waiting.tickets.map((ticket) => (
                  <ItemLink
                    key={`t-${ticket.id}`}
                    href={paths.ticket(ticket.id)}
                    displayId={ticket.displayId}
                    title={ticket.title}
                  >
                    <StatusBadge
                      kind="blocked"
                      code={ticket.blockedReason ?? "blocked"}
                    />
                  </ItemLink>
                ))}
                {data.waiting.finalizations.map((item) => (
                  <ItemLink
                    key={`f-${item.id}-${item.step}`}
                    href={paths.specDelivery(item.specId)}
                    displayId={item.specDisplayId}
                    title={item.step}
                  >
                    <StatusBadge
                      kind="blocked"
                      code={item.blockedReason ?? "blocked"}
                    />
                  </ItemLink>
                ))}
                {data.waiting.pullRequests.map((item) => (
                  <ItemLink
                    key={`p-${item.specId}-${item.repo}`}
                    href={paths.spec(item.specId)}
                    displayId={item.specDisplayId}
                    title={`${item.repo} #${item.number}`}
                  />
                ))}
                {data.waiting.cleanups.map((item) => (
                  <ItemLink
                    key={`c-${item.specId}`}
                    href={paths.spec(item.specId)}
                    displayId={item.specDisplayId}
                    title="清理失败"
                  />
                ))}
                {data.waiting.readyFailures.map((item) => (
                  <ItemLink
                    key={`r-${item.specId}-${item.repo}`}
                    href={paths.spec(item.specId)}
                    displayId={item.specDisplayId}
                    title={`${item.repo} #${item.number} 未能转 ready`}
                  />
                ))}
                {(data.waiting.planning ?? []).map((item) => (
                  <ItemLink
                    key={`planning-${item.specId}`}
                    href={paths.spec(item.specId)}
                    displayId={item.specDisplayId}
                    title="规划文档未能提交"
                  />
                ))}
                {data.waiting.specs.map((spec) => (
                  <ItemLink
                    key={`s-${spec.id}`}
                    href={paths.spec(spec.id)}
                    displayId={spec.displayId}
                    title={spec.title}
                  >
                    <StatusBadge kind="spec" code="paused" />
                  </ItemLink>
                ))}
                {(data.waiting.locates ?? []).map((item) => (
                  <ItemLink
                    key={`locate-${item.specId}`}
                    href={paths.spec(item.specId)}
                    displayId={item.specDisplayId}
                    title={item.title}
                  >
                    <StatusBadge
                      kind="blocked"
                      code={item.reason ?? "bug-unlocated"}
                    />
                  </ItemLink>
                ))}
              </>
            )}
          </Quadrant>

          <Quadrant
            title="正在运行"
            icon={<Activity className="size-4 text-primary" />}
            count={data.running.reduce((n, row) => n + row.tickets.length, 0)}
          >
            {data.running.length === 0 ? (
              <Empty text={EMPTY_RUNNING} />
            ) : (
              data.running.flatMap((row) =>
                row.tickets.map((ticket) => (
                  <ItemLink
                    key={ticket.id}
                    href={paths.ticket(ticket.id)}
                    displayId={ticket.displayId}
                    title={ticket.title}
                  >
                    {ticket.stage ? (
                      <>
                        <Mono title={stageLabel[ticket.stage]}>
                          {ticket.stage}
                        </Mono>
                        <span>{stageLabel[ticket.stage] ?? ticket.stage}</span>
                      </>
                    ) : null}
                    {ticket.elapsedMs !== null ? (
                      <span className="font-mono tabular">
                        已运行 {formatElapsed(ticket.elapsedMs)}
                      </span>
                    ) : null}
                    {ticket.slow ? (
                      <Pill tone="paused" className="font-sans">
                        偏慢
                      </Pill>
                    ) : null}
                    <span>
                      属于 <Mono>{row.spec.displayId}</Mono>
                    </span>
                  </ItemLink>
                )),
              )
            )}
          </Quadrant>

          <Quadrant
            title="等你验收"
            icon={<ClipboardCheck className="size-4 text-primary" />}
            count={data.awaitingAcceptance.length}
          >
            {data.awaitingAcceptance.length === 0 ? (
              <Empty text={EMPTY_REVIEW} />
            ) : (
              data.awaitingAcceptance.map((row) => (
                <ItemLink
                  key={row.spec.id}
                  href={paths.specDelivery(row.spec.id)}
                  displayId={row.spec.displayId}
                  title={row.spec.title}
                >
                  <StatusBadge kind="spec" code={row.spec.state} />
                  <span>
                    {row.pullRequestCount} 个{" "}
                    {pullAbbrev(hostKindOfRepos(row.spec.repos))}
                  </span>
                  <span>
                    验收标准{" "}
                    <Mono>{`${row.verifiedCriteria}/${row.totalCriteria}`}</Mono>
                  </span>
                </ItemLink>
              ))
            )}
          </Quadrant>

          <Quadrant
            title="最近完成"
            icon={<CheckCircle2 className="size-4 text-primary" />}
            count={data.recentlyCompleted.length}
          >
            {data.recentlyCompleted.length === 0 ? (
              <Empty text={EMPTY_COMPLETED} />
            ) : (
              data.recentlyCompleted.map((row) => (
                <ItemLink
                  key={row.spec.id}
                  href={paths.spec(row.spec.id)}
                  displayId={row.spec.displayId}
                  title={row.spec.title}
                >
                  <StatusBadge kind="spec" code={row.spec.state} />
                  <RelativeTime iso={row.completedAt} />
                </ItemLink>
              ))
            )}
          </Quadrant>
        </div>
      )}
      {data?.status ? (
        <StatusArea
          status={data.status}
          settingsProjectId={projects.data?.[0]?.id ?? null}
        />
      ) : null}
    </Page>
  );
}

function StatusArea({
  status,
  settingsProjectId,
}: {
  status: {
    logDirBytes: number;
    apiFreeBytes: number;
    lastCleanup: { at: string | null; runs: number; orphans: number };
    feishu?: {
      open: boolean;
      closedReason: "missing" | "permissions" | "invalid" | null;
    };
    workers: Array<{
      id: string;
      reportedAt: string;
      freeBytes: number | null;
      cleaned: { sandboxLogs: number; salvage: number; snapshots: number };
    }>;
  };
  settingsProjectId: number | null;
}) {
  const feishuClosed = status.feishu
    ? feishuClosedMessage(status.feishu)
    : null;
  return (
    <footer
      data-testid="workbench-status"
      className="mt-8 space-y-1 border-t pt-3 text-xs text-muted-foreground"
    >
      <p>
        日志目录 {formatDiskBytes(status.logDirBytes)} · API 剩余{" "}
        {formatGib(status.apiFreeBytes)}
      </p>
      {status.workers.length === 0 ? (
        <p>还没有 worker 上报</p>
      ) : (
        status.workers.map((worker) => (
          <p key={worker.id}>
            worker {worker.id} 剩余{" "}
            {worker.freeBytes === null ? "未知" : formatGib(worker.freeBytes)}
            {" · 上报 "}
            <RelativeTime iso={worker.reportedAt} />
            {` · 上次清理 sandbox-logs ${worker.cleaned.sandboxLogs}、salvage ${worker.cleaned.salvage}、snapshots ${worker.cleaned.snapshots}`}
          </p>
        ))
      )}
      <p>
        {status.lastCleanup.at
          ? `最近清理删了 ${status.lastCleanup.runs} 个 Run 日志、${status.lastCleanup.orphans} 个孤儿目录`
          : "还没有做过日志清理"}
      </p>
      {feishuClosed ? (
        <p>
          {settingsProjectId !== null ? (
            <a
              href={paths.project(settingsProjectId)}
              className="text-primary hover:underline"
            >
              {feishuClosed}
            </a>
          ) : (
            feishuClosed
          )}
        </p>
      ) : null}
    </footer>
  );
}
