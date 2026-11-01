import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useConfirmSpec } from "@/api/queries";
import { useSpecDetail, specPageHead } from "@/components/afk/spec-page";
import { SpecDependencyGraph } from "@/components/afk/spec-dependency-graph";
import { IdChip, Mono, ReasonBadge, RepoTag } from "@/components/afk/badges";
import { EmptyState } from "@/components/afk/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogFooter } from "@/components/ui/dialog";

export const Route = createFileRoute("/specs/$id/")({
  head: ({ params }) => specPageHead(params.id, "概览", "需求关键进度、放大依赖图、导入告警与受阻票。"),
  component: SpecOverviewPage,
});
function SpecOverviewPage() {
  const data = useSpecDetail();
  const confirm = useConfirmSpec();
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const blocked = data.tickets.filter(t => t.state === "blocked");
  return <div className="space-y-7">
    <dl className="grid grid-cols-3 gap-5 border-b pb-5">{[["票进度", `${data.spec.progress.done}/${data.spec.progress.total}`], ["受阻票", blocked.length], ["PR", data.pullRequests.length]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 font-mono text-2xl">{value}</dd></div>)}</dl>
    {data.spec.state === "draft" && <section className="flex flex-wrap items-center justify-between gap-4 border-y py-4"><div><h2 className="mb-2 text-sm font-semibold">确认拆分</h2><p className="text-xs text-muted-foreground"><Mono>{data.tickets.length}</Mono> 张票 · <Mono>{data.edges.length}</Mono> 条边</p><div className="mt-2 flex gap-2">{data.spec.repos.map(r => <RepoTag key={r.name} name={r.name} />)}</div></div><Button disabled={!data.tickets.length || confirm.isPending} onClick={() => setOpen(true)}>确认拆分，开始执行 <ArrowRight /></Button></section>}
    <Dialog open={open} onOpenChange={v => { if (!confirm.isPending) setOpen(v); }}><DialogContent><DialogTitle>确认 {data.spec.displayId} 的拆分？</DialogTitle><DialogDescription>确认后平台会开始调度 {data.tickets.length} 张票，agent 将按依赖顺序执行。请确认已检查导入告警和票的改动范围。</DialogDescription>{confirm.error && <p role="alert" className="text-xs text-destructive">{confirm.error instanceof Error ? confirm.error.message : "确认失败"}</p>}<DialogFooter><Button variant="outline" disabled={confirm.isPending} onClick={() => setOpen(false)}>返回检查</Button><Button disabled={!data.tickets.length || confirm.isPending} onClick={() => confirm.mutate(data.spec.id, { onSuccess: () => setOpen(false) })}>{confirm.isPending && <Loader2 className="animate-spin" />}确认并开始调度</Button></DialogFooter></DialogContent></Dialog>
    <section><h2 className="mb-4 text-sm font-semibold">依赖图</h2><SpecDependencyGraph detail={data} state="" repo="" mode="highlight" expanded /></section>
    <section><h2 className="mb-3 text-sm font-semibold">导入告警 · {data.importWarnings.length}</h2>{data.importWarnings.length ? <div className="divide-y border-y">{data.importWarnings.map(w => <div key={w.id} className="py-3"><p className="text-sm">{w.message}</p><div className="mt-2 flex flex-wrap gap-2">{w.ticketIds.map(id => <IdChip key={id} id={id} displayId={data.tickets.find(t => t.id === id)?.displayId ?? id} />)}{w.paths.map(path => <Mono key={path}>{path}</Mono>)}</div></div>)}</div> : <p className="text-xs text-muted-foreground">没有导入告警</p>}</section>
    <section><h2 className="mb-3 text-sm font-semibold">卡住的票 · {blocked.length}</h2>{blocked.length ? <div className="divide-y border-y">{blocked.map(t => <div key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm"><IdChip id={t.id} displayId={t.displayId} /><Link to="/tickets/$id" params={{ id: t.id }} className="flex-1 hover:underline">{t.title}</Link>{t.blockedReason && <ReasonBadge reason={t.blockedReason} />}</div>)}</div> : <EmptyState title="没有卡住的票" />}</section>
  </div>;
}
