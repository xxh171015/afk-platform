import { Link } from "@tanstack/react-router";
import type { StructuredBrief as Brief } from "@/lib/view-map";
import { stageLabel } from "@/lib/labels";
import { Mono } from "./badges";
import { CollapsibleCode } from "./code";

export function StructuredBrief({ brief, runId, runDisplayId }: { brief: Brief; runId?: string | undefined; runDisplayId?: string | undefined }) {
  const { evidence } = brief;
  const stepMeaning = stageLabel[brief.step as keyof typeof stageLabel];
  return <section aria-label="为什么卡住" className="min-w-0 space-y-3 text-[13px]">
    <h2 className="text-sm font-semibold">为什么卡住</h2>
    <p className="leading-6">{brief.summary}</p>
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">失败步骤 <Mono title={stepMeaning}>{brief.step}</Mono>{stepMeaning && <span>{stepMeaning}</span>}</p>
    <div className="space-y-3 border-l border-border pl-3">
      {evidence.failingTests && <div><h3 className="mb-1 text-xs font-medium">失败测试</h3><ul className="space-y-1">{evidence.failingTests.map((test, i) => <li key={i} className="break-words font-mono text-xs">{test}</li>)}</ul></div>}
      {evidence.command && <div><h3 className="mb-1 text-xs font-medium">命令</h3><pre className="whitespace-pre-wrap break-words font-mono text-xs">{evidence.command}</pre></div>}
      {evidence.lastLogLines && <div><h3 className="mb-1 text-xs font-medium">最后日志</h3><CollapsibleCode text={evidence.lastLogLines} /></div>}
      {evidence.conflictFiles && <div><h3 className="mb-1 text-xs font-medium">冲突文件</h3><ul className="space-y-1">{evidence.conflictFiles.map(file => <li key={file} className="break-all font-mono text-xs">{file}</li>)}</ul></div>}
      {evidence.findingsCount !== undefined && <p className="text-xs">意见条数：{evidence.findingsCount}</p>}
      {runId && <Link to="/runs/$id" params={{ id: runId }} className="inline-flex gap-2 text-xs text-primary hover:underline"><span>查看运行证据</span><Mono>{runDisplayId ?? runId}</Mono></Link>}
    </div>
    <p className="leading-6 text-muted-foreground"><span className="font-medium text-foreground">推荐动作：</span>{brief.recommendedAction}</p>
  </section>;
}