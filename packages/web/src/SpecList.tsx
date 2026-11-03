import type { SpecState } from "@afk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { IdChip, RepoTag, StateBadge } from "./components/afk/badges.tsx";
import { CopyCommand } from "./components/afk/code.tsx";
import { Page } from "./components/afk/page.tsx";
import { SegmentedProgress } from "./components/afk/progress-bar.tsx";
import {
  EmptyState,
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { repoLabel } from "./host-links.ts";
import { specTypeLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { LIST_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { specStateLabel } from "./status.ts";

const STATE_ORDER: SpecState[] = [
  "running",
  "reworking",
  "finalizing",
  "planned",
  "awaiting-review",
  "partially-merged",
  "paused",
  "draft",
  "merged",
  "cancelled",
];

type SortKey = "state" | "progress";
interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

const GRID =
  "grid-cols-[4.5rem_minmax(0,16rem)_9rem_5.5rem_7rem_minmax(0,1fr)_8rem_8rem]";

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: Sort;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn(
        "inline-flex items-center gap-1 hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-40" />
      )}
    </button>
  );
}

export function SpecList() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  const specs = useQuery({
    queryKey: ["specs"],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs");
      if (!data) throw new Error(describeError(error));
      return data.specs;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const all = useMemo(() => specs.data ?? [], [specs.data]);

  const [states, setStates] = useState<Set<SpecState>>(new Set());
  const [project, setProject] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "state", dir: "asc" });

  const stateCounts = useMemo(() => {
    const m = new Map<SpecState, number>();
    for (const s of all) m.set(s.state, (m.get(s.state) ?? 0) + 1);
    return m;
  }, [all]);
  const projects = useMemo(() => {
    const names = new Set<string>();
    for (const s of all) {
      for (const repo of s.repos ?? []) names.add(repoLabel(repo).label);
    }
    return [...names].sort();
  }, [all]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = all.filter(
      (s) =>
        (states.size === 0 || states.has(s.state)) &&
        (project === "all" ||
          (s.repos ?? []).some((repo) => repoLabel(repo).label === project)) &&
        (needle === "" ||
          s.title.toLowerCase().includes(needle) ||
          s.displayId.toLowerCase().includes(needle)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "state") {
        const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
        return d !== 0 ? d * dir : a.displayId.localeCompare(b.displayId);
      }
      const ratio = (s: (typeof all)[number]) =>
        s.progress.total === 0 ? 0 : s.progress.done / s.progress.total;
      const d = ratio(a) - ratio(b);
      if (d !== 0) return d * dir;
      const bd = a.progress.blocked - b.progress.blocked;
      return bd !== 0 ? bd * dir : a.displayId.localeCompare(b.displayId);
    });
  }, [all, states, project, q, sort]);

  const filtering = states.size > 0 || project !== "all" || q.trim() !== "";
  const clearFilters = () => {
    setStates(new Set());
    setProject("all");
    setQ("");
  };

  return (
    <Page
      title="需求"
      subtitle="需求由 CLI 创建和管理：plat spec create"
      actions={<StaleNotice error={specs.data ? specs.error : null} />}
    >
      {specs.isError && !specs.data ? (
        <ErrorState
          error={specs.error}
          prefix="无法加载需求"
          onRetry={() => void specs.refetch()}
        />
      ) : !specs.data ? (
        <>
          <p className="sr-only">加载需求…</p>
          <RowsSkeleton rows={8} />
        </>
      ) : all.length === 0 ? (
        <EmptyState
          title="还没有需求"
          description={
            <span className="flex flex-col items-center gap-3">
              需求是从 CLI 创建的，页面上不提供新建。
              <CopyCommand command="plat spec create" />
            </span>
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索标题或编号…"
                className="h-7 w-52 pl-7 text-[12px]"
                aria-label="搜索标题或编号"
              />
            </div>
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger
                className="h-7 w-auto gap-1.5 text-[12px]"
                aria-label="按项目筛选"
              >
                <SelectValue placeholder="项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <fieldset
              className="flex flex-wrap items-center gap-1 border-0 p-0"
              aria-label="按状态筛选"
            >
              {STATE_ORDER.filter((st) => stateCounts.has(st)).map((st) => {
                const on = states.has(st);
                return (
                  <button
                    key={st}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setStates((prev) => {
                        const next = new Set(prev);
                        if (next.has(st)) next.delete(st);
                        else next.add(st);
                        return next;
                      })
                    }
                    title={st}
                    className={cn(
                      "inline-flex h-6 items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[11px] transition-colors",
                      on
                        ? "border-border-strong bg-accent text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {specStateLabel(st)}
                    <span className="tabular text-subtle-foreground">
                      {stateCounts.get(st)}
                    </span>
                  </button>
                );
              })}
            </fieldset>
            {filtering ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[12px]"
                onClick={clearFilters}
              >
                <X /> 清除筛选
              </Button>
            ) : null}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title="没有符合筛选的需求"
              description={
                <Button size="sm" variant="outline" onClick={clearFilters}>
                  <X /> 清除筛选
                </Button>
              }
            />
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: keep CSS grid + role=table
            <div
              className="overflow-x-auto rounded-md border bg-card text-[13px]"
              role="table"
            >
              <div className="min-w-[1200px]">
                {/* biome-ignore lint/a11y/useSemanticElements: keep CSS grid + role=row */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: header is not a control */}
                <div
                  role="row"
                  className={cn(
                    "grid items-center gap-3 border-b bg-surface px-3 py-2 text-[11px] font-medium text-muted-foreground",
                    GRID,
                  )}
                >
                  <span>编号</span>
                  <span>标题</span>
                  <span>项目</span>
                  <span>类型</span>
                  <SortHeader
                    label="状态"
                    k="state"
                    sort={sort}
                    onSort={(key) =>
                      setSort((prev) =>
                        prev.key === key
                          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                          : { key, dir: "asc" },
                      )
                    }
                  />
                  <SortHeader
                    label="进度"
                    k="progress"
                    sort={sort}
                    onSort={(key) =>
                      setSort((prev) =>
                        prev.key === key
                          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                          : { key, dir: "asc" },
                      )
                    }
                  />
                  <span>开始</span>
                  <span>结束</span>
                </div>
                <div className="divide-y">
                  {filtered.map((s) => {
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: keep CSS grid + role=row
                      // biome-ignore lint/a11y/useFocusableInteractive: row contains the spec link
                      <div
                        key={s.id}
                        role="row"
                        className={cn(
                          "grid items-center gap-3 px-3 py-2.5 hover:bg-accent/50",
                          GRID,
                        )}
                      >
                        <span className="min-w-0">
                          <IdChip displayId={s.displayId} id={s.id} />
                        </span>
                        <a
                          href={paths.spec(s.id)}
                          className="min-w-0 truncate hover:underline"
                          title={s.title}
                        >
                          {s.title}
                        </a>
                        <div className="min-w-0 overflow-hidden">
                          <div className="flex w-full min-w-0 flex-nowrap gap-1 overflow-hidden">
                            {(s.repos ?? []).length === 0 ? (
                              <span className="truncate text-[11px] text-muted-foreground">
                                尚未导入票
                              </span>
                            ) : (
                              (s.repos ?? []).map((repo) => (
                                <RepoTag
                                  key={repo.name}
                                  name={repo.name}
                                  url={repo.url}
                                  className="min-w-0"
                                />
                              ))
                            )}
                          </div>
                        </div>
                        <span
                          className="truncate font-mono text-[11px] whitespace-nowrap text-muted-foreground"
                          title={specTypeLabel[s.type]}
                        >
                          {s.type}
                        </span>
                        <div className="min-w-0">
                          <StateBadge kind="spec" state={s.state} />
                        </div>
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <SegmentedProgress
                            progress={s.progress}
                            className="min-w-0"
                          />
                          <span
                            className="min-w-0 truncate font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular"
                            title={`${s.progress.done}/${s.progress.total} 已完成${
                              s.progress.blocked > 0
                                ? `，${s.progress.blocked} 张卡住`
                                : ""
                            }`}
                          >
                            {s.progress.done}/{s.progress.total} 已完成
                            {s.progress.blocked > 0
                              ? `，${s.progress.blocked} 张卡住`
                              : ""}
                          </span>
                        </div>
                        <span className="min-w-0 truncate whitespace-nowrap text-[12px] text-muted-foreground">
                          <RelativeTime iso={s.startedAt} />
                        </span>
                        <span className="min-w-0 truncate whitespace-nowrap text-[12px] text-muted-foreground">
                          {s.endedAt ? <RelativeTime iso={s.endedAt} /> : "—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
