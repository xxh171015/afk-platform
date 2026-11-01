import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describeError, useApi } from "./api.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { LIST_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { formatElapsed } from "./time.ts";
import { waitingCount } from "./waiting.ts";

export const EMPTY_WAITING =
  "没有事等你。票卡住、收尾停住或 PR 需要人看时会出现在这里。";
export const EMPTY_RUNNING =
  "现在没有在跑的需求。确认拆分后，阶段和耗时会出现在这里。";
export const EMPTY_REVIEW = "还没有可以验收的需求。PR 开齐后会出现在这里。";
export const EMPTY_COMPLETED = "还没有合并完的需求。";

export const WORKBENCH_KEY = ["workbench"] as const;

// Home of the control tower: four quadrants instead of a spec table
// (docs/specs/experience-platform.md「工作台与导航」).

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
  empty,
  children,
  count,
}: {
  title: string;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      data-testid={`quadrant-${title}`}
    >
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {count === 0 ? (
        <p className="note">{empty}</p>
      ) : (
        <ul className="grid gap-3">{children}</ul>
      )}
    </section>
  );
}

export function Workbench() {
  const board = useWorkbench();
  if (board.isPending) {
    return (
      <div aria-busy="true">
        <p className="note">加载工作台…</p>
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  if (board.isError && !board.data) {
    return (
      <p className="error" role="alert">
        无法加载工作台: {board.error.message}
      </p>
    );
  }
  const data = board.data;
  if (!data) return null;

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">工作台</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <Quadrant
          title="等你处理"
          empty={EMPTY_WAITING}
          count={waitingCount(data.waiting)}
        >
          {data.waiting.tickets.map((ticket) => (
            <li key={`t-${ticket.id}`}>
              <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
              {ticket.title}{" "}
              <StatusBadge
                kind="blocked"
                code={ticket.blockedReason ?? "blocked"}
              />
            </li>
          ))}
          {data.waiting.finalizations.map((item) => (
            <li key={`f-${item.specId}-${item.repo}`}>
              <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
              {item.step}{" "}
              <StatusBadge
                kind="blocked"
                code={item.blockedReason ?? "blocked"}
              />
            </li>
          ))}
          {data.waiting.pullRequests.map((item) => (
            <li key={`p-${item.specId}-${item.repo}`}>
              <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
              {item.repo} #{item.number}
            </li>
          ))}
          {data.waiting.cleanups.map((item) => (
            <li key={`c-${item.specId}`}>
              <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
              清理失败
            </li>
          ))}
          {data.waiting.readyFailures.map((item) => (
            <li key={`r-${item.specId}-${item.repo}`}>
              <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
              {item.repo} #{item.number} 未能转 ready
            </li>
          ))}
          {data.waiting.specs.map((spec) => (
            <li key={`s-${spec.id}`}>
              <a href={paths.spec(spec.id)}>{spec.displayId}</a> {spec.title}{" "}
              <StatusBadge kind="spec" code="paused" />
            </li>
          ))}
        </Quadrant>

        <Quadrant
          title="正在运行"
          empty={EMPTY_RUNNING}
          count={data.running.length}
        >
          {data.running.map((row) => (
            <li
              key={row.spec.id}
              className="rounded-md border border-border p-3"
            >
              <p>
                <a href={paths.spec(row.spec.id)}>{row.spec.displayId}</a>{" "}
                {row.spec.title}{" "}
                <StatusBadge kind="spec" code={row.spec.state} />
              </p>
              <ul className="mt-2 grid gap-1">
                {row.tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
                    {ticket.title}
                    {ticket.stage ? ` · ${ticket.stage}` : ""}
                    {ticket.elapsedMs !== null
                      ? ` · 已运行 ${formatElapsed(ticket.elapsedMs)}`
                      : ""}
                    {ticket.slow ? (
                      <span
                        className="badge"
                        title="current stage is slower than the project mean"
                      >
                        {" "}
                        偏慢
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </Quadrant>

        <Quadrant
          title="等你验收"
          empty={EMPTY_REVIEW}
          count={data.awaitingAcceptance.length}
        >
          {data.awaitingAcceptance.map((row) => (
            <li key={row.spec.id}>
              <a href={paths.spec(row.spec.id)}>{row.spec.displayId}</a>{" "}
              {row.spec.title} <StatusBadge kind="spec" code={row.spec.state} />{" "}
              · {row.pullRequestCount} 个 PR · 验收标准 {row.verifiedCriteria}/
              {row.totalCriteria}
            </li>
          ))}
        </Quadrant>

        <Quadrant
          title="最近完成"
          empty={EMPTY_COMPLETED}
          count={data.recentlyCompleted.length}
        >
          {data.recentlyCompleted.map((row) => (
            <li key={row.spec.id}>
              <a href={paths.spec(row.spec.id)}>{row.spec.displayId}</a>{" "}
              {row.spec.title} <StatusBadge kind="spec" code={row.spec.state} />{" "}
              <RelativeTime iso={row.completedAt} />
            </li>
          ))}
        </Quadrant>
      </div>
    </div>
  );
}
