import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, HelpCircle } from "lucide-react";
import type { Finalization, FinalizationState } from "@/api/types";
import { useSpecDetail, specPageHead } from "@/components/afk/spec-page";
import { Mono, Pill, ReasonBadge, RepoTag } from "@/components/afk/badges";
import { PrStatusLine } from "@/components/afk/spec-pr-panel";
import { SpecAcceptanceReport, CopyAcceptanceMarkdown } from "@/components/afk/spec-acceptance-report";
import { stageLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/specs/$id/delivery")({
  head: ({ params }) => specPageHead(params.id, "交付", "各仓库 PR、合并顺序、收尾运行与验收标准。"),
  component: Delivery,
});
const tone: Record<FinalizationState, "neutral" | "running" | "done" | "blocked" | "paused"> = { pending: "neutral", running: "running", done: "done", blocked: "blocked", waived: "paused" };
const order = ["final-e2e", "final-review", "final-fix", "final-merge"];
function FinalSteps({ steps }: { steps: Finalization[] }) {
  return <ol className="space-y-3">{steps.map(f => <li key={f.id} className="space-y-2"><div className="flex flex-wrap items-center gap-2"><Mono title={stageLabel[f.step]}>{f.step}</Mono><span className="text-xs text-muted-foreground">{stageLabel[f.step]}</span><Pill tone={tone[f.state]}>{f.state}</Pill>{f.runId && <Link to="/runs/$id" params={{ id: f.runId }} className="ml-auto font-mono text-xs text-primary hover:underline">{f.runDisplayId ?? f.runId}</Link>}</div>{f.blockedReason && <ReasonBadge reason={f.blockedReason} detail={f.blockedDetail} />}</li>)}</ol>;
}
function Delivery() {
  const data = useSpecDetail();
  if (!data) return null;
  const cross = data.finalizations.filter(f => !f.repo).sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
  return <div className="space-y-7"><p className="border-l-2 border-primary bg-primary/5 px-4 py-3 text-sm">按这个顺序合并，平台从不自动合并。</p>
    <div className="grid items-start gap-5 xl:grid-cols-2">{data.spec.repos.map(repo => {
      const position = data.mergeOrder.ordered.indexOf(repo.name);
      const broken = data.orderBroken.some(b => b.repo === repo.name || b.skipped.includes(repo.name));
      const steps = data.finalizations.filter(f => f.repo === repo.name).sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
      const criteria = data.acceptancePack?.repositories.find(r => r.repo === repo.name)?.criteria ?? data.tickets.filter(t => t.repo === repo.name && t.state !== "cancelled").flatMap(t => t.acceptanceCriteria);
      const prs = data.pullRequests.filter(p => p.repo === repo.name);
      return <article key={repo.name} aria-label={`交付 ${repo.name}`} className={cn("min-w-0 space-y-5 rounded-md border bg-card p-5", broken && "border-destructive")}>
        <header className="space-y-3"><RepoTag name={repo.name} /><p className={cn("text-xs", broken ? "text-destructive" : "text-muted-foreground")}>{position < 0 ? "不分先后" : `合并顺序 ${position + 1}/${data.mergeOrder.ordered.length}`}{broken && " · 合并顺序被打破"}</p></header>
        <section className="space-y-3"><h2 className="text-sm font-semibold">PR</h2>{prs.length ? prs.map(pr => <div key={pr.id} className="space-y-2"><PrStatusLine pr={pr} />{pr.waitsFor?.length ? <p className="break-all text-xs text-muted-foreground">等待 {pr.waitsFor.join("、")} 合并</p> : null}{pr.syncError && <p className="break-all text-xs text-destructive">读取失败：{pr.syncError}</p>}</div>) : <p className="text-xs text-muted-foreground">尚未创建 PR</p>}</section>
        <section className="border-t pt-4"><h2 className="mb-3 text-sm font-semibold">仓库收尾</h2>{steps.length ? <FinalSteps steps={steps} /> : <p className="text-xs text-muted-foreground">尚无仓库收尾步骤</p>}</section>
        <section className="border-t pt-4"><h2 className="mb-3 text-sm font-semibold">验收标准</h2>{criteria.length ? <ul className="space-y-3">{criteria.map((c, i) => <li key={`${c.id}-${i}`} className="flex gap-2 text-xs">{c.status === "verified" ? <CheckCircle2 className="size-4 shrink-0 text-primary" /> : <HelpCircle className="size-4 shrink-0 text-muted-foreground" />}<div><p className="leading-6">{c.text}</p><Mono className="text-[10px]">{c.status}</Mono>{c.reason && <p className="mt-1 text-muted-foreground">{c.reason}</p>}</div></li>)}</ul> : <p className="text-xs text-muted-foreground">尚无验收标准</p>}</section>
      </article>;
    })}</div>
    {cross.length > 0 && <section className="border-y py-5"><h2 className="mb-4 text-sm font-semibold">跨仓库收尾</h2><FinalSteps steps={cross} /></section>}
    {data.acceptancePack && <section><div className="mb-5 flex justify-end"><CopyAcceptanceMarkdown detail={data} /></div><SpecAcceptanceReport detail={data} /></section>}
  </div>;
}
