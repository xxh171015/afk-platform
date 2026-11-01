import { Fragment } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Clock3, ExternalLink, XCircle } from "lucide-react";
import type { PullRequest, SpecDetailResponse } from "@/api/types";
import { prWaitsFor } from "@/lib/acceptance-report";
import { prCiLabel, prReviewLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Mono, Pill, RepoTag } from "./badges";
import { EmptyState } from "./states";

export function PrStatusLine({ pr }: { pr: PullRequest }) {
  const CiIcon = { success: CheckCircle2, failure: XCircle, pending: Clock3, none: Circle }[pr.ci];
  return <div className="flex flex-wrap items-center gap-2 text-xs"><a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-primary hover:underline">#{pr.number}<ExternalLink className="size-3" /></a><Pill tone={pr.state === "merged" ? "done" : pr.state === "closed" ? "blocked" : "review"}>{pr.state}{pr.state === "closed" && <span className="font-sans">关闭未合并</span>}</Pill><Pill tone={pr.draft ? "draft" : "neutral"}>{pr.draft ? "draft" : "ready"}</Pill><span className="flex items-center gap-1" title={prCiLabel[pr.ci]}><CiIcon className={cn("size-3.5", pr.ci === "failure" ? "text-destructive" : "text-muted-foreground")} /><Mono>ci: {pr.ci}</Mono></span><Mono title={prReviewLabel[pr.review]}>review: {pr.review}</Mono></div>;
}
export function OrderBrokenWarnings({ detail }: { detail: SpecDetailResponse }) {
  return <>{detail.orderBroken.map(b => <p key={b.repo} role="alert" className="flex items-start gap-2 text-[13px] text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span className="break-words">合并顺序被打破：<Mono className="break-all">{b.repo}</Mono> 在 <Mono className="break-all">{b.skipped.join("、")}</Mono> 之前被合并了</span></p>)}</>;
}
export function SpecPrPanel({ detail }: { detail: SpecDetailResponse }) {
  const skipped = new Set(detail.orderBroken.flatMap(b => b.skipped));
  return <div className="space-y-7"><p className="border-l-2 border-primary bg-primary/5 px-4 py-3 text-[13px] font-medium">按这个顺序合并，平台从不自动合并。</p>
    <section><h2 className="mb-4 text-sm font-semibold">契约合并顺序</h2>{detail.mergeOrder.ordered.length ? <div className="overflow-x-auto pb-2"><ol className="flex w-max min-w-full items-center gap-3" aria-label="PR 合并顺序">{detail.mergeOrder.ordered.map((repo, i) => <Fragment key={repo}>{i > 0 && <ArrowRight className="size-5 shrink-0 text-muted-foreground" />}<li className={cn("min-w-56 rounded-md border bg-surface px-4 py-3", skipped.has(repo) && "border-destructive bg-destructive/5")} data-skipped={skipped.has(repo)}><div className="mb-2 flex items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span><RepoTag name={repo} /></div><p className={cn("text-xs", skipped.has(repo) ? "text-destructive" : "text-muted-foreground")}>{skipped.has(repo) ? "这一环被跳过" : detail.pullRequests.some(p => p.repo === repo && p.state === "merged") ? "已合并" : i === 0 ? "先合并 · 提供契约" : "等前置仓库合并"}</p></li></Fragment>)}</ol></div> : <p className="text-[13px] text-muted-foreground">没有必须按顺序合并的仓库</p>}<div className="mt-3 space-y-2"><OrderBrokenWarnings detail={detail} /></div></section>
    {detail.mergeOrder.unordered.length > 0 && <section className="border-y py-4"><p className="mb-3 text-xs text-muted-foreground">这些仓库之间没有契约关系，不分先后</p><div className="flex flex-wrap gap-3">{detail.mergeOrder.unordered.map(r => <RepoTag key={r} name={r} />)}</div></section>}
    <section><h2 className="mb-4 text-sm font-semibold">Pull requests <Mono>{detail.pullRequests.length}</Mono></h2>{detail.pullRequests.length ? <div className="grid items-start gap-4 lg:grid-cols-2">{detail.pullRequests.map(pr => <article key={pr.id} className={cn("min-w-0 space-y-4 rounded-md border bg-card p-5", pr.syncError && "border-destructive")}><RepoTag name={pr.repo} /><p className="text-sm font-medium">{pr.title}</p><PrStatusLine pr={pr} /><div className="border-t pt-3 text-xs text-muted-foreground">{prWaitsFor(pr, detail).length ? <p className="break-words">等待：<Mono className="break-all">{prWaitsFor(pr, detail).join("、")}</Mono> 合并</p> : <p>{pr.state === "merged" ? "该 PR 已合并" : "没有前置仓库等待"}</p>}</div>{pr.syncError && <p role="alert" className="break-all text-xs text-destructive">读取失败：{pr.syncError}</p>}</article>)}</div> : <EmptyState title="尚未创建 PR" />}</section>
  </div>;
}