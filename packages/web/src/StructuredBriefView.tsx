import type { StructuredBrief } from "@afk/shared";
import { Mono } from "./components/afk/badges.tsx";
import { CollapsibleCode, CopyCommand } from "./components/afk/code.tsx";
import { stageLabel } from "./lib/labels.ts";
import { paths } from "./paths.ts";

export function StructuredBriefView({
  brief,
  run,
}: {
  brief: StructuredBrief;
  run?: { id: number; displayId: string } | null;
}) {
  const { evidence } = brief;
  const stepMeaning = brief.step ? stageLabel[brief.step] : undefined;
  return (
    <section
      aria-label="为什么卡住"
      className="min-w-0 space-y-3 text-[13px]"
      role="note"
    >
      <h2 className="text-sm font-semibold">为什么卡住</h2>
      <p className="leading-6">{brief.summary}</p>
      {brief.step ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          失败步骤 <Mono title={stepMeaning}>{brief.step}</Mono>
          {stepMeaning ? <span>{stepMeaning}</span> : null}
        </p>
      ) : null}
      <div className="space-y-3 border-l border-border pl-3">
        {evidence.failingTests ? (
          <div>
            <h3 className="mb-1 text-xs font-medium">失败测试</h3>
            <ul className="space-y-1">
              {evidence.failingTests.map((test) => (
                <li key={test} className="break-words font-mono text-xs">
                  {test}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {evidence.command ? (
          <div>
            <h3 className="mb-1 text-xs font-medium">命令</h3>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {evidence.command}
            </pre>
          </div>
        ) : null}
        {evidence.lastLogLines ? (
          <div>
            <h3 className="mb-1 text-xs font-medium">最后日志</h3>
            <CollapsibleCode text={evidence.lastLogLines} />
          </div>
        ) : null}
        {evidence.conflictFiles ? (
          <div>
            <h3 className="mb-1 text-xs font-medium">冲突文件</h3>
            <ul className="space-y-1">
              {evidence.conflictFiles.map((file) => (
                <li key={file} className="break-all font-mono text-xs">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {evidence.findingsCount !== undefined ? (
          <p className="text-xs">意见条数：{evidence.findingsCount}</p>
        ) : null}
        {run ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">查看运行证据</span>
            <a
              href={paths.run(run.id)}
              className="text-primary hover:underline"
            >
              {run.displayId}
            </a>
          </p>
        ) : null}
      </div>
      <p className="leading-6 text-muted-foreground">
        <span className="font-medium text-foreground">推荐动作：</span>
        {brief.recommendedAction}
      </p>
      {brief.commands.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">可复制的命令</h3>
          <ul className="space-y-2">
            {brief.commands.map((item) => (
              <li key={item.command} className="space-y-1">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <CopyCommand command={item.command} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {brief.ticketDraft ? (
        <div>
          <h3 className="mb-1 text-xs font-medium">契约票草稿</h3>
          <CollapsibleCode text={brief.ticketDraft} />
        </div>
      ) : null}
    </section>
  );
}
