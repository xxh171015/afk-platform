import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, ArrowUpRight, CheckCircle2, ClipboardCheck, Inbox } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { blockedQuery, specQuery, specsQuery } from "@/api/queries";
import { Page } from "@/components/afk/app-shell";
import { Mono, Pill, StateBadge } from "@/components/afk/badges";
import { ErrorState, Skeleton, StaleNotice } from "@/components/afk/states";
import { RelativeTime } from "@/components/afk/time";
import { stageLabel } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { buildWorkbench, DEFAULT_STAGE_MEAN_MS } from "@/lib/view-map";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "工作台 · AFK 平台" },
    { name: "description", content: "AFK 工作台：待处理事项、正在运行的票、等待验收的需求与最近完成。" },
    { property: "og:title", content: "工作台 · AFK 平台" },
    { property: "og:description", content: "AFK 工作台：待处理事项、正在运行的票、等待验收的需求与最近完成。" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: Workbench,
});

function Quadrant({ title, icon, count, children }: { title: string; icon: ReactNode; count?: number | undefined; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 border-t">
    <h2 className="flex h-12 items-center gap-2 text-sm font-medium">
      {icon}{title}<span className="ml-auto font-mono text-xs text-muted-foreground tabular">{count ?? "—"}</span>
    </h2>
    {children}
  </section>;
}

function LoadingRows() {
  return <div aria-label="正在加载" className="space-y-4 py-3">{[0, 1, 2].map(n => <div key={n} className="space-y-2"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>)}</div>;
}

function Empty({ text }: { text: string }) {
  return <p className="flex min-h-32 items-center justify-center border-b border-dashed px-4 text-center text-sm text-muted-foreground">{text}</p>;
}

function ItemLink({ href, displayId, title, children }: { href: string; displayId: string; title: string; children?: ReactNode }) {
  const external = /^https?:\/\//.test(href);
  return <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    className="group block min-w-0 border-b px-2 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
    <div className="flex min-w-0 items-start gap-2 text-[13px]">
      <span className="max-w-[45%] shrink-0 break-all font-mono text-xs text-muted-foreground">{displayId}</span>
      <span className="min-w-0 flex-1 break-words font-medium">{title}</span>
      <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground group-hover:text-foreground" />
    </div>
    {children && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">{children}</div>}
  </a>;
}

function Workbench() {
  const specs = useQuery(specsQuery());
  const blocked = useQuery(blockedQuery());
  const details = useQueries({ queries: (specs.data?.specs ?? []).map(s => specQuery(s.id)) });
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const data = details.flatMap(d => d.data ? [d.data] : []);
  const ready = Boolean(specs.data && blocked.data && details.every(d => d.data) && now !== null);
  const missingError = (!specs.data && specs.error) || (!blocked.data && blocked.error) || details.find(d => !d.data && d.error)?.error;
  const staleError = (specs.data && specs.error) || (blocked.data && blocked.error) || details.find(d => d.data && d.error)?.error;
  const view = ready && blocked.data && now !== null ? buildWorkbench({
    specs: data.map(d => d.spec),
    tickets: data.flatMap(d => d.tickets),
    runs: data.flatMap(d => d.runs),
    pullRequests: data.flatMap(d => d.pullRequests),
    acceptancePacks: Object.fromEntries(data.flatMap(d => d.acceptancePack ? [[d.spec.id, d.acceptancePack]] : [])),
    blocked: blocked.data, now, stageMeans: DEFAULT_STAGE_MEAN_MS,
  }) : undefined;
  const retry = () => { void specs.refetch(); void blocked.refetch(); details.forEach(d => void d.refetch()); };

  return <Page title="工作台" subtitle={<span>项目 <Mono>shop</Mono></span>} actions={<StaleNotice error={staleError} />}>
    {missingError ? <ErrorState error={missingError} onRetry={retry} /> :
      <div className="grid grid-cols-2 items-start gap-x-8 gap-y-8">
        <Quadrant title="等你处理" icon={<Inbox className="size-4 text-destructive" />} count={view?.waitingCount}>
          {!view ? <LoadingRows /> : !view.waiting.length ? <Empty text={view.emptyCopy.waiting} /> : view.waiting.map(item =>
            <ItemLink key={`${item.kind}-${item.id}`} {...item} />)}
        </Quadrant>
        <Quadrant title="正在运行" icon={<Activity className="size-4 text-primary" />} count={view?.running.length}>
          {!view ? <LoadingRows /> : !view.running.length ? <Empty text={view.emptyCopy.running} /> : view.running.map(item =>
            <ItemLink key={item.ticketId} href={item.href} displayId={item.ticketDisplayId} title={item.title}>
              <Mono title={stageLabel[item.stage]}>{item.stage}</Mono><span>{stageLabel[item.stage]}</span>
              <span className="font-mono tabular">{formatDuration(item.elapsedMs)}</span>
              {item.slow && <Pill tone="paused" className="font-sans">偏慢</Pill>}
              <span>属于 <Mono>{item.specDisplayId}</Mono></span>
            </ItemLink>)}
        </Quadrant>
        <Quadrant title="等你验收" icon={<ClipboardCheck className="size-4 text-primary" />} count={view?.awaitingReview.length}>
          {!view ? <LoadingRows /> : !view.awaitingReview.length ? <Empty text={view.emptyCopy.awaitingReview} /> : view.awaitingReview.map(item =>
            <ItemLink key={item.specId} href={item.href} displayId={item.displayId} title={item.title}>
              <StateBadge kind="spec" state={item.state} /><span>PR <Mono>{item.prCount}</Mono></span>
              <span>验收标准 <Mono>{item.verifiedCriteria}/{item.totalCriteria}</Mono></span>
            </ItemLink>)}
        </Quadrant>
        <Quadrant title="最近完成" icon={<CheckCircle2 className="size-4 text-primary" />} count={view?.recentlyMerged.length}>
          {!view ? <LoadingRows /> : !view.recentlyMerged.length ? <Empty text={view.emptyCopy.recentlyMerged} /> : view.recentlyMerged.map(item =>
            <ItemLink key={item.specId} href={item.href} displayId={item.displayId} title={item.title}>
              <StateBadge kind="spec" state="merged" /><RelativeTime value={item.updatedAt} />
            </ItemLink>)}
        </Quadrant>
      </div>}
  </Page>;
}
