import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { describeError, useApi } from "./api.tsx";
import { Mono, Pill } from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, Skeleton, StaleNotice } from "./components/afk/states.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { pullAbbrev } from "./host-copy.ts";
import { specTypeLabel } from "./lib/labels.ts";
import { LIST_POLL_MS } from "./live.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { formatElapsed } from "./time.ts";

export const REVIEW_QUEUE_KEY = ["review"] as const;

export const EMPTY_REVIEW_QUEUE = "没有要审的需求。";

const GROUPS = [
  { key: "waitingForYou", title: "等你审" },
  { key: "inProgress", title: "审到一半" },
  { key: "inRework", title: "返工中" },
  { key: "readyToMerge", title: "看完待合并" },
] as const;

export function reviewBadgeCount(queue: {
  waitingForYou: readonly unknown[];
  inProgress: readonly unknown[];
}): number {
  return queue.waitingForYou.length + queue.inProgress.length;
}

export function specReviewPath(specId: number | string): string {
  return `/specs/${specId}/review`;
}

export function useReviewQueue() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  return useQuery({
    queryKey: REVIEW_QUEUE_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/review-queue");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

type Queue = NonNullable<ReturnType<typeof useReviewQueue>["data"]>;
type Row = Queue["waitingForYou"][number];

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

function progressOf(row: Row): string {
  if (row.viewedCount === null || row.filesCount === null) return "未计算";
  return `${row.viewedCount}/${row.filesCount}`;
}

function waitedOf(row: Row, now: Date): string {
  const started = new Date(row.waitingSince).getTime();
  if (!Number.isFinite(started)) return "";
  return `等了 ${formatElapsed(Math.max(0, now.getTime() - started))}`;
}

function QueueRow({ row, now }: { row: Row; now: Date }) {
  const pr = pullAbbrev(row.hostKind);
  return (
    <a
      href={specReviewPath(row.spec.id)}
      data-testid={`review-row-${row.spec.displayId}`}
      className="group block min-w-0 border-b px-2 py-3 transition-colors last:border-b-0 hover:bg-accent/50"
    >
      <div className="flex min-w-0 items-start gap-2 text-[13px]">
        <span className="max-w-[45%] shrink-0 break-all font-mono text-xs text-muted-foreground">
          {row.spec.displayId}
        </span>
        <span className="min-w-0 flex-1 break-words font-medium">
          {row.spec.title}
        </span>
        <StatusBadge kind="spec" code={row.spec.state} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <span>{row.spec.project}</span>
        <span>{specTypeLabel[row.spec.type] ?? row.spec.type}</span>
        <span>
          {row.repos.join("、") || "—"} · {row.pullRequestCount} 个 {pr}
        </span>
        <span>{waitedOf(row, now)}</span>
        <Mono>
          +{row.additions} / −{row.deletions}
        </Mono>
        <span>已看 {progressOf(row)}</span>
        {row.ci === "failure" ? <span>CI 失败</span> : null}
        {row.ci === "pending" ? <span>CI 等待</span> : null}
        {row.conflictsWithDefault ? <span>冲突</span> : null}
        {row.autoMergeLine ? <span>{row.autoMergeLine}</span> : null}
        {row.riskTags.map((tag) => (
          <Pill key={tag} tone="paused" className="font-sans" dot={false}>
            {tag}
          </Pill>
        ))}
      </div>
    </a>
  );
}

export function ReviewQueue() {
  const queue = useReviewQueue();
  const now = new Date();
  const data = queue.data;

  if (queue.isError && !data) {
    return (
      <Page title="待审">
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      </Page>
    );
  }

  const total = data
    ? GROUPS.reduce((sum, group) => sum + data[group.key].length, 0)
    : 0;

  return (
    <Page
      title="待审"
      subtitle="等人验收、正在返工、或看完等合并的需求。不是待处理。"
      actions={<StaleNotice error={data ? queue.error : null} />}
    >
      {!data ? (
        <LoadingRows />
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">{EMPTY_REVIEW_QUEUE}</p>
      ) : (
        <div className="space-y-8">
          {GROUPS.map((group) => {
            const rows = data[group.key];
            if (rows.length === 0) return null;
            return (
              <section
                key={group.key}
                aria-label={group.title}
                data-testid={`review-group-${group.title}`}
              >
                <h2 className="mb-2 text-[13px] font-medium">
                  {group.title}
                  <span className="ml-2 text-muted-foreground tabular">
                    {rows.length}
                  </span>
                </h2>
                <div className="overflow-hidden rounded-lg border bg-card px-2">
                  {rows.map((row) => (
                    <QueueRow key={row.spec.id} row={row} now={now} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Page>
  );
}
