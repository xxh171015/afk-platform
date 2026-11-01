import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { ticketQuery } from "@/api/queries";
import type { SpecDetailResponse } from "@/api/types";
import { IdChip, Mono, ReasonBadge, RepoTag, StateBadge } from "./badges";
import { EmptyState, ErrorState, RowsSkeleton, StaleNotice } from "./states";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { stageLabel } from "@/lib/labels";
import { formatDuration } from "@/lib/time";

export function runDuration(start: string, end: string | null) {
  if (!end) return "运行中";
  return formatDuration(Date.parse(end) - Date.parse(start));
}
export function SpecTicketDrawer({ id, detail, onClose }: { id: string | null; detail: SpecDetailResponse; onClose: () => void }) {
  const query = useQuery({ ...ticketQuery(id ?? ""), enabled: Boolean(id) });
  const ticket = detail.tickets.find(t => t.id === id);
  const data = query.data;
  const latest = data?.runs[0];
  return <Sheet open={Boolean(id)} onOpenChange={open => { if (!open) onClose(); }}><SheetContent className="flex w-full max-w-none flex-col sm:max-w-none xl:max-w-[480px]">
    <SheetHeader className="pr-6"><SheetTitle className="flex flex-wrap items-center gap-2">{ticket && <IdChip id={ticket.id} displayId={ticket.displayId} />}{ticket?.title ?? "票摘要"}</SheetTitle><SheetDescription>票摘要</SheetDescription></SheetHeader>
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto text-[13px]">
      <StaleNotice error={data ? query.error : null} />
      {ticket && <><div className="flex flex-wrap gap-2"><StateBadge kind="ticket" state={ticket.state} /><RepoTag name={ticket.repo} /><Mono>v{ticket.contentVersion}</Mono>{ticket.blockedReason && <ReasonBadge reason={ticket.blockedReason} />}</div><p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{ticket.body}</p></>}
      {!data && !query.error && <RowsSkeleton rows={5} />}
      {!data && query.error && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
      {data && <>{(["upstream", "downstream"] as const).map(key => <section key={key}><h3 className="mb-2 font-medium">{key === "upstream" ? "上游" : "下游"} <Mono>{data[key].length}</Mono></h3>{data[key].length ? <div className="space-y-2">{data[key].map(t => <div key={t.id} className="flex flex-wrap items-center gap-2"><IdChip id={t.id} displayId={t.displayId} /><span className="min-w-0 flex-1">{t.title}</span><StateBadge kind="ticket" state={t.state} /><Mono>{t.kind}</Mono></div>)}</div> : <p className="text-muted-foreground">无{key === "upstream" ? "上游依赖" : "下游票"}</p>}</section>)}
      <section><h3 className="mb-2 font-medium">最近一次 Run</h3>{latest ? <div className="space-y-2 border-l-2 pl-3"><div className="flex flex-wrap gap-2"><IdChip id={latest.id} displayId={latest.displayId} /><Mono title={stageLabel[latest.stage]}>{latest.stage}</Mono><Mono>{latest.state}</Mono></div><p className="text-muted-foreground">{latest.summary}</p><p className="text-xs text-muted-foreground">{runDuration(latest.startedAt, latest.finishedAt)}</p></div> : <p className="text-muted-foreground">尚无运行记录</p>}</section>
      <section><h3 className="mb-2 font-medium">验收标准</h3>{data.ticket.acceptanceCriteria.length ? <ul className="space-y-3">{data.ticket.acceptanceCriteria.map(c => <li key={c.id}><p>{c.text}</p><Mono>{c.status}</Mono>{c.reason && <p className="mt-1 text-xs text-muted-foreground">{c.reason}</p>}</li>)}</ul> : <EmptyState title="尚未填写验收标准" />}</section></>}
    </div>
    {ticket && <Button asChild className="w-full"><Link to="/tickets/$id" params={{ id: ticket.id }}>打开票详情 <ArrowUpRight /></Link></Button>}
  </SheetContent></Sheet>;
}