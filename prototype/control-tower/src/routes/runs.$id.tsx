import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { runQuery } from "@/api/queries";
import { ApiError } from "@/api/types";
import { Page } from "@/components/afk/app-shell";
import { Mono, ShaChip } from "@/components/afk/badges";
import { EmptyState, ErrorState, RowsSkeleton, StaleNotice } from "@/components/afk/states";
import { RunLogViewer } from "@/components/afk/run-log-viewer";
import { JsonTree } from "@/components/afk/json-tree";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { stageLabel } from "@/lib/labels";
import { formatDuration } from "@/lib/time";
import { useRecentVisit } from "@/hooks/use-search";

export const Route = createFileRoute("/runs/$id")({
  head: ({ params }) => ({ meta: [
    { title: `Run ${params.id} · AFK 平台` },
    { name: "description", content: "运行详情：动作日志、提示词、结构化输出、提交和运行元信息。" },
    { property: "og:title", content: `Run ${params.id} · AFK 平台` },
    { property: "og:description", content: "运行详情：动作日志、提示词、结构化输出、提交和运行元信息。" },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: RunDetail,
});

function RunDetail() {
  const { id } = Route.useParams();
  const { data, error, refetch } = useQuery(runQuery(id));
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useRecentVisit(data ? { kind: "run", id: data.run.id, displayId: data.run.displayId, title: `${stageLabel[data.run.stage]} · ${data.ticket?.title ?? data.spec.title}`, ticketId: data.ticket?.id ?? null, specId: data.spec.id } : undefined);
  if (!data) return <Page title="Run">{error ? error instanceof ApiError && error.status === 404 ? <EmptyState title="运行不存在" /> : <ErrorState error={error} onRetry={() => refetch()} /> : <RowsSkeleton rows={8} />}</Page>;
  const { run } = data;
  const result = { succeeded: "成功", failed: "失败", running: "运行中", cancelled: "已取消" }[run.state];
  const duration = formatDuration(run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : now === null ? null : Math.max(0, now - Date.parse(run.startedAt)));
  return <Page title={`${run.displayId} · ${data.ticket?.displayId ?? data.spec.displayId} · ${stageLabel[run.stage]} · 第 ${run.attempt} 次 · ${result} · ${duration}`} actions={<StaleNotice error={error} />}>
    <div className="mb-5 flex flex-wrap gap-5 text-sm">{data.ticket && <Link to="/tickets/$id" params={{ id: data.ticket.id }} className="text-primary hover:underline">{data.ticket.displayId} · {data.ticket.title}</Link>}<Link to="/specs/$id" params={{ id: data.spec.id }} className="text-primary hover:underline">{data.spec.displayId} · {data.spec.title}</Link></div>
    <dl className="mb-7 flex flex-wrap gap-x-6 gap-y-4 border-y py-4 text-xs">
      <div className="flex items-center gap-2"><dt className="text-muted-foreground">模型</dt><dd><Mono>{run.model ?? "—"}</Mono></dd></div>
      <div className="flex items-center gap-2"><dt className="text-muted-foreground">skills SHA</dt><dd><ShaChip sha={run.skillsSha ?? null} /></dd></div>
      <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">契约 SHA</dt><dd className="flex flex-wrap gap-2">{run.contractRefs?.length ? run.contractRefs.map(c => <span key={c.repo} className="flex items-center gap-2"><Mono>{c.repo}</Mono><ShaChip sha={c.sha} /></span>) : "—"}</dd></div>
      <div className="flex items-center gap-2"><dt className="text-muted-foreground">refs SHA</dt><dd><ShaChip sha={run.refsSha ?? null} /></dd></div>
    </dl>
    <RunLogViewer key={run.id} run={run} />
    <Tabs defaultValue="prompt" className="mt-7"><TabsList><TabsTrigger value="prompt">提示词</TabsTrigger><TabsTrigger value="output">结构化输出</TabsTrigger><TabsTrigger value="commits">提交</TabsTrigger></TabsList>
      <TabsContent value="prompt"><pre className="whitespace-pre-wrap break-words py-4 font-sans text-sm leading-7">{data.prompt}</pre></TabsContent>
      <TabsContent value="output"><div className="overflow-x-auto py-4"><JsonTree value={data.output} /></div></TabsContent>
      <TabsContent value="commits">{data.commits.length ? <ul className="divide-y">{data.commits.map((commit, i) => <li key={`${commit.sha}-${i}`} className="flex items-start gap-3 py-4 text-sm"><ShaChip sha={commit.sha} /><span>{commit.message}</span></li>)}</ul> : <EmptyState title="没有提交记录" />}</TabsContent>
    </Tabs>
  </Page>;
}