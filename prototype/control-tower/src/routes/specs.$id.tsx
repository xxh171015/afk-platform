import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { specQuery } from "@/api/queries";
import { Page } from "@/components/afk/app-shell";
import { IdChip, Mono, StateBadge } from "@/components/afk/badges";
import { EmptyState, ErrorState, RowsSkeleton, StaleNotice } from "@/components/afk/states";
import { SegmentedProgress } from "@/components/afk/progress-bar";
import { OrderBrokenWarnings } from "@/components/afk/spec-pr-panel";
import { specPageHead } from "@/components/afk/spec-page";
import { useRecentVisit } from "@/hooks/use-search";
import { PIPELINE_STEPS, specEtaCopy, specPipeline } from "@/lib/view-map";
import { specTypeLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/specs/$id")({
  validateSearch: (s: Record<string, unknown>): { tab?: string } => typeof s["tab"] === "string" ? { tab: s["tab"] } : {},
  beforeLoad: ({ params, search }) => {
    if (search.tab === "acceptance" || search.tab === "final") throw redirect({ to: "/specs/$id/delivery", params, search: {}, replace: true });
    if (search.tab === "graph" || search.tab === "tickets") throw redirect({ to: "/specs/$id/tickets", params, search: {}, replace: true });
    if (search.tab) throw redirect({ to: "/specs/$id", params, search: {}, replace: true });
  },
  head: ({ params }) => specPageHead(params.id, "需求", "需求六步流程、票进度、交付与时间线。"),
  component: SpecLayout,
});

function SpecLayout() {
  const { id } = Route.useParams();
  const { data, error, refetch } = useQuery(specQuery(id));
  useRecentVisit(data ? { kind: "spec", id: data.spec.id, displayId: data.spec.displayId, title: data.spec.title } : undefined);
  const pipeline = data ? specPipeline({ state: data.spec.state, pullRequests: data.pullRequests, anomalyFrom: data.spec.anomalyFrom ?? null }) : undefined;
  const tabs = [
    ["/specs/$id", "概览"], ["/specs/$id/description", "需求说明"],
    ["/specs/$id/tickets", "票与依赖"], ["/specs/$id/delivery", "交付"], ["/specs/$id/timeline", "时间线"],
  ] as const;
  return <Page title={data ? <span className="flex flex-wrap items-center gap-3"><IdChip id={data.spec.id} displayId={data.spec.displayId} /><span>{data.spec.title}</span><StateBadge kind="spec" state={data.spec.state} /></span> : "需求"}
    subtitle={data ? <span className="flex items-center gap-3"><Mono title={specTypeLabel[data.spec.type]}>{data.spec.type}</Mono><span>{specTypeLabel[data.spec.type]}</span><span>项目 <Mono>{data.spec.project}</Mono></span></span> : undefined}>
    {!data ? error ? <ErrorState error={error} onRetry={() => refetch()} /> : <RowsSkeleton rows={8} /> : pipeline && <>
      <StaleNotice error={error} />
      {pipeline.banner && <div role="status" className="mb-5 flex flex-wrap items-center gap-2 border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-sm"><AlertTriangle className="size-4 text-destructive" /><strong>{pipeline.banner.label}</strong>{data.spec.pauseReason && <Mono>{data.spec.pauseReason}</Mono>}{pipeline.banner.kind === "paused" && <Link to="/waiting" className="ml-auto text-primary underline">前往待处理</Link>}</div>}
      <ol aria-label="需求流程" className="mb-5 flex items-center border-b pb-5">
        {PIPELINE_STEPS.map((step, index) => {
          const complete = pipeline.allComplete || index < pipeline.currentIndex;
          const current = !pipeline.allComplete && index === pipeline.currentIndex;
          return <li key={step} aria-current={current ? "step" : undefined} data-complete={complete} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
            <div className={cn("flex shrink-0 items-center gap-2 text-xs", current ? "font-semibold text-primary" : complete ? "text-primary" : "text-muted-foreground")}>
              <span className={cn("grid size-6 place-items-center rounded-full border font-mono text-[11px]", current ? "border-primary bg-primary text-primary-foreground" : complete ? "border-primary/40" : "border-border-strong")}>{complete ? <Check className="size-3.5" /> : index + 1}</span>{step}
            </div>{index < 5 && <span className="mx-1 h-px min-w-2 flex-1 bg-border" />}
          </li>;
        })}
      </ol>
      <div className="mb-6 flex flex-wrap items-center gap-4 text-xs"><span>票进度 <Mono>{data.spec.progress.done}/{data.spec.progress.total}</Mono></span><SegmentedProgress progress={data.spec.progress} className="max-w-60 flex-1" />{data.spec.etaMinutes != null && <span className="text-muted-foreground">{specEtaCopy(data.spec.etaMinutes)}</span>}</div>
      <div className="mb-3 space-y-2"><OrderBrokenWarnings detail={data} /></div>
      <nav aria-label="需求页面" className="mb-6 flex gap-5 overflow-x-auto border-b">
        {tabs.map(([to, label]) => <Link key={to} to={to} params={{ id }} search={{}} activeOptions={{ exact: true }} activeProps={{ className: "border-primary text-foreground" }} inactiveProps={{ className: "border-transparent text-muted-foreground" }} className="shrink-0 border-b-2 px-1 py-3 text-[13px] hover:text-foreground">{label}</Link>)}
      </nav>
    </>}
    <Outlet />
  </Page>;
}
