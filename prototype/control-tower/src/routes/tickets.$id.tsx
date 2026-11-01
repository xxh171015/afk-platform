import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiError } from "@/api/types";
import { ticketQuery } from "@/api/queries";
import { Page } from "@/components/afk/app-shell";
import { IdChip, Mono, ReasonBadge, RepoTag, StateBadge } from "@/components/afk/badges";
import { EmptyState, ErrorState, RowsSkeleton, StaleNotice } from "@/components/afk/states";
import { BlockedTicketActions } from "@/components/afk/blocked-ticket-actions";
import { TicketRuns, TicketSidebar, TicketResults } from "@/components/afk/ticket-detail-panels";
import { StructuredBrief } from "@/components/afk/structured-brief";
import { structuredBrief, ticketToBriefInput } from "@/lib/view-map";
import { ticketTypeLabel } from "@/lib/labels";
import { useRecentVisit } from "@/hooks/use-search";

export const Route = createFileRoute("/tickets/$id")({
  validateSearch: (s: Record<string, unknown>): { run?: string } => typeof s["run"] === "string" ? { run: s["run"] } : {},
  head: ({ params }) => ({ meta: [
    { title: `票 ${params.id} · AFK 平台` },
    { name: "description", content: "票详情：流水线、分片日志、版本对比、门禁与上下游。" },
    { property: "og:title", content: `票 ${params.id} · AFK 平台` },
    { property: "og:description", content: "票详情：流水线、分片日志、版本对比、门禁与上下游。" },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: TicketDetail,
});
function TicketDetail() {
  const { id } = Route.useParams(); const search = Route.useSearch(); const navigate = Route.useNavigate();
  const { data, error, refetch } = useQuery(ticketQuery(id));
  const visitedRun = data?.runs.find(r => r.id === search.run);
  useRecentVisit(visitedRun && data ? { kind: "run", id: visitedRun.id, displayId: visitedRun.displayId, title: `${visitedRun.stage} · ${data.ticket.title}`, ticketId: data.ticket.id } : data ? { kind: "ticket", id: data.ticket.id, displayId: data.ticket.displayId, title: data.ticket.title } : undefined);
  if (error && !data) {
    if (error instanceof ApiError && error.status === 404) return <Page title="票不存在"><EmptyState title={`找不到 ${id}`} /></Page>;
    return <Page title="票"><ErrorState error={error} onRetry={() => refetch()} /></Page>;
  }
  if (!data) return <Page title="票"><RowsSkeleton rows={8} /></Page>;
  const t = data.ticket;
  const selected = data.runs.find(r => r.id === search.run) ?? data.runs[0];
  const onSelect = (run: string) => { void navigate({ to: "/runs/$id", params: { id: run } }); };
  const briefInput = ticketToBriefInput(t, { findingsCount: data.findings.filter(f => f.resolution === "unhandled").length });
  return <Page title={<span className="flex flex-wrap items-center gap-2"><IdChip id={t.id} displayId={t.displayId} /><span>{t.title}</span><StateBadge kind="ticket" state={t.state} showLabel /></span>} subtitle={<span className="flex flex-wrap items-center gap-2"><Mono title={ticketTypeLabel[t.type]}>{t.type}</Mono><span>{ticketTypeLabel[t.type]}</span><RepoTag name={t.repo} /><Mono>v{t.contentVersion}</Mono></span>}>
    <nav aria-label="所属需求" className="mb-5 text-xs text-muted-foreground"><Link to="/specs/$id" params={{ id: t.specId }} className="hover:text-primary">← 返回所属需求 <Mono>{t.specDisplayId}</Mono></Link></nav><StaleNotice error={error} />
    {t.state === "blocked" && briefInput && <section className="mb-6 space-y-3 border-l-2 border-destructive bg-destructive/5 p-4"><ReasonBadge reason={briefInput.reason} /><StructuredBrief brief={structuredBrief(briefInput)} runId={t.blockedRun?.id} runDisplayId={t.blockedRun?.displayId} /><BlockedTicketActions key={t.id} ticket={t} /></section>}
    <div className="grid min-w-0 gap-7 lg:grid-cols-[minmax(0,1fr)_250px]"><div className="min-w-0 space-y-7"><p className="whitespace-pre-wrap text-[13px] leading-7 text-muted-foreground">{t.body}</p>
      <TicketRuns data={data} selected={selected?.id ?? ""} onSelect={onSelect} /><TicketResults data={data} />
    </div><TicketSidebar key={t.id} data={data} /></div>
  </Page>;
}
