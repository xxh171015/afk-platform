import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { specQuery, specsQuery } from "@/api/queries";
import type { SpecState, SpecSummary } from "@/api/types";
import { Page } from "@/components/afk/app-shell";
import { IdChip, RepoTag, StateBadge } from "@/components/afk/badges";
import { CopyCommand } from "@/components/afk/code";
import { SegmentedProgress } from "@/components/afk/progress-bar";
import { EmptyState, ErrorState, RowsSkeleton, Skeleton, StaleNotice } from "@/components/afk/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { specStateLabel, specTypeLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/specs/")({
  head: () => ({
    meta: [
      { title: "需求 · AFK 平台" },
      { name: "description", content: "项目 shop 下所有需求及其进度。" },
      { property: "og:title", content: "需求 · AFK 平台" },
      { property: "og:description", content: "项目 shop 下所有需求及其进度。" },
      { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Specs,
});

/** 状态排序用的固定顺序：活跃在前，终态在后 */
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

const GRID = "grid-cols-[auto_minmax(0,1fr)_90px_110px_auto_200px_minmax(0,150px)]";

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

function progressRatio(s: SpecSummary) {
  return s.progress.total === 0 ? 0 : s.progress.done / s.progress.total;
}

function Specs() {
  const navigate = useNavigate();
  const { data, error, refetch } = useQuery(specsQuery());
  const all = useMemo(() => data?.specs ?? [], [data]);

  // 每个 Spec 的仓库来自详情（与总览页同一取数方式）
  const details = useQueries({ queries: all.map((s) => specQuery(s.id)) });
  const repoOf = (id: string): string[] | undefined => {
    const query = details[all.findIndex(s => s.id === id)];
    const d = query?.data;
    if (!d && query?.error) return [];
    return d ? [...new Set(d.tickets.map((t) => t.repo))].sort() : undefined;
  };

  const [states, setStates] = useState<Set<SpecState>>(new Set());
  const [project, setProject] = useState<string>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "state", dir: "asc" });

  const stateCounts = useMemo(() => {
    const m = new Map<SpecState, number>();
    for (const s of all) m.set(s.state, (m.get(s.state) ?? 0) + 1);
    return m;
  }, [all]);
  const projects = useMemo(() => [...new Set(all.map((s) => s.project))].sort(), [all]);

  const toggleState = (st: SpecState) =>
    setStates((prev) => {
      const next = new Set(prev);
      if (next.has(st)) next.delete(st);
      else next.add(st);
      return next;
    });

  const onSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = all.filter(
      (s) =>
        (states.size === 0 || states.has(s.state)) &&
        (project === "all" || s.project === project) &&
        (needle === "" || s.title.toLowerCase().includes(needle) || s.displayId.toLowerCase().includes(needle)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "state") {
        const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
        return d !== 0 ? d * dir : a.displayId.localeCompare(b.displayId);
      }
      const d = progressRatio(a) - progressRatio(b);
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
      actions={<StaleNotice error={data ? error ?? details.find(d => d.data && d.error)?.error : null} />}
    >
      {error && !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data ? (
        <RowsSkeleton rows={8} />
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
          {details.some(d => d.error && !d.data) && <ErrorState error={details.find(d => d.error && !d.data)?.error} onRetry={() => { details.filter(d => d.error).forEach(d => void d.refetch()); }} />}
          {/* 筛选栏 */}
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
              <SelectTrigger className="h-7 w-auto gap-1.5 text-[12px]" aria-label="按项目筛选">
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
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="按状态筛选">
              {STATE_ORDER.filter((st) => stateCounts.has(st)).map((st) => {
                const on = states.has(st);
                return (
                  <button
                    key={st}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleState(st)}
                    title={specStateLabel[st]}
                    className={cn(
                      "inline-flex h-6 items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[11px] transition-colors",
                      on
                        ? "border-border-strong bg-accent text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {st}
                    <span className="tabular text-subtle-foreground">{stateCounts.get(st)}</span>
                  </button>
                );
              })}
            </div>
            {filtering && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={clearFilters}>
                <X /> 清除筛选
              </Button>
            )}
          </div>

          {/* 表格 */}
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
            <div className="overflow-x-auto rounded-md border bg-card text-[13px]"><div className="min-w-[960px]">
              {/* 表头 */}
              <div
                className={cn(
                  "grid items-center gap-3 border-b bg-surface px-3 py-2 text-[11px] font-medium text-muted-foreground",
                  GRID,
                )}
              >
                <span>编号</span>
                <span>标题</span>
                <span>项目</span>
                <span>类型</span>
                <SortHeader label="状态" k="state" sort={sort} onSort={onSort} />
                <SortHeader label="进度" k="progress" sort={sort} onSort={onSort} />
                <span className="text-right">涉及仓库</span>
              </div>
              <div className="divide-y">
                {filtered.map((s) => {
                  const repos = repoOf(s.id);
                  return (
                    <div
                      key={s.id}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate({ to: "/specs/$id", params: { id: s.id } })}
                      onKeyDown={(e) => e.key === "Enter" && navigate({ to: "/specs/$id", params: { id: s.id } })}
                      className={cn("grid cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent/50", GRID)}
                    >
                      <span onClick={(e) => e.stopPropagation()}>
                        <IdChip displayId={s.displayId} id={s.id} />
                      </span>
                      <span className="truncate" title={s.title}>
                        {s.title}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">{s.project}</span>
                      <span className="font-mono text-[11px] text-muted-foreground" title={specTypeLabel[s.type]}>
                        {s.type}
                      </span>
                      <StateBadge kind="spec" state={s.state} />
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <SegmentedProgress progress={s.progress} />
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">
                          {s.progress.done}/{s.progress.total}
                        </span>
                        {s.progress.blocked > 0 && (
                          <span className="shrink-0 font-mono text-[11px] text-state-blocked tabular">
                            {s.progress.blocked} 张 blocked
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {repos ? repos.map((r) => <RepoTag key={r} name={r} short />) : <Skeleton className="h-5 w-20" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div></div>
          )}
        </div>
      )}
    </Page>
  );
}
