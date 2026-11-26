import type { HostKind } from "@afk/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { RepoTag, ShaChip } from "../components/afk/badges.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { pullAbbrev } from "../host-copy.ts";
import { commitHtmlUrl, treeHtmlUrl } from "../host-links.ts";
import { stageLabel } from "../lib/labels.ts";
import { specExcerpt } from "../markdown-body.ts";
import { paths } from "../paths.ts";
import { RelativeTime } from "../RelativeTime.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { ticketProgress } from "../spec-flow.ts";
import { TIMELINE_LABELS, timelineLabel } from "../spec-timeline.ts";
import { peekTicketClick } from "../TicketDetail.tsx";
import { TraceSection } from "../TraceSection.tsx";
import { formatTokens } from "../token-usage.ts";
import { DependencyGraph } from "./dependency-graph.tsx";
import { LeadTimeBar } from "./lead-time.tsx";
import type { SpecView } from "./view.ts";

export function Overview({
  spec,
  tickets,
  edges,
  blocked,
  prechecks,
  canConfirm,
  confirming,
  confirmError,
  onConfirm,
  onLeavePlanningChanges,
  onOpen,
  pullRequests,
  timeline,
  currentStep,
  hostKind,
  potentialConflicts,
  leadTime,
  usageByStage,
  links,
}: {
  spec: SpecView["spec"];
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  blocked: SpecView["tickets"];
  prechecks: { code: string; level: string; message: string }[];
  canConfirm: boolean;
  confirming: boolean;
  confirmError: string | null;
  onConfirm: () => void;
  onLeavePlanningChanges: () => void;
  onOpen: (id: number) => void;
  pullRequests: SpecView["pullRequests"];
  timeline: SpecView["timeline"];
  currentStep: string;
  hostKind: HostKind;
  potentialConflicts: NonNullable<SpecView["potentialConflicts"]>;
  leadTime: SpecView["leadTime"];
  usageByStage: NonNullable<SpecView["usageByStage"]>;
  links: NonNullable<SpecView["links"]>;
}) {
  const progress = ticketProgress(tickets);
  const repos = spec.repos ?? [];
  const planningRepo = repos.find((repo) => repo.name === spec.planningRepo);
  const excerpt = specExcerpt(spec.body);
  const lastEvent = timeline.at(-1);
  const byRepo = new Map<string, { done: number; total: number }>();
  for (const ticket of tickets) {
    const row = byRepo.get(ticket.repo) ?? { done: 0, total: 0 };
    if (ticket.state !== "cancelled") row.total += 1;
    if (ticket.state === "done") row.done += 1;
    byRepo.set(ticket.repo, row);
  }
  const draft = spec.state === "draft";
  const docsWarn = prechecks.find(
    (item) => item.code === "page-confirm-without-planning-docs",
  );
  const namedLocalChanges = Boolean(
    docsWarn?.message.includes("这些规划文档改动"),
  );
  const [confirmDocs, setConfirmDocs] = useState(false);
  return (
    <>
      {draft ? (
        <div
          id="flow-confirm"
          className="confirm mb-5 flex scroll-mt-6 flex-wrap items-center gap-3"
        >
          <Button
            type="button"
            onClick={() => {
              if (docsWarn) setConfirmDocs(true);
              else onConfirm();
            }}
            disabled={!canConfirm || confirming}
          >
            {confirming ? "确认中…" : "确认拆分"}
          </Button>
          {namedLocalChanges ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onLeavePlanningChanges()}
              disabled={!canConfirm || confirming}
            >
              不带这些改动，照样确认
            </Button>
          ) : null}
          <AlertDialog
            open={confirmDocs}
            onOpenChange={(open) => {
              if (!confirming) setConfirmDocs(open);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确认拆分会丢掉规划文档</AlertDialogTitle>
                <AlertDialogDescription>
                  {docsWarn?.message ??
                    "页面确认时不会带上本地的规划文档改动。"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={confirming}>
                  返回
                </AlertDialogCancel>
                <Button
                  disabled={confirming}
                  onClick={() => {
                    onConfirm();
                    setConfirmDocs(false);
                  }}
                >
                  仍然确认
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {tickets.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              先导入票（plat tickets import）。
            </span>
          ) : null}
          {confirmError ? (
            <p className="text-sm text-state-blocked" role="alert">
              {confirmError}
            </p>
          ) : null}
        </div>
      ) : null}

      <dl
        id="flow-draft"
        className="mb-6 grid scroll-mt-6 gap-x-6 gap-y-3 text-sm sm:grid-cols-2"
      >
        <div>
          <dt className="text-xs text-muted-foreground">仓库</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {repos.length === 0 ? (
              <span className="text-muted-foreground">尚未导入票</span>
            ) : (
              repos.map((repo) => (
                <RepoTag key={repo.name} name={repo.name} url={repo.url} />
              ))
            )}
          </dd>
        </div>
        <div data-testid="spec-refs">
          <dt className="text-xs text-muted-foreground">参考仓库</dt>
          <dd className="mt-1 flex flex-col gap-1">
            {(spec.refs ?? []).length === 0 ? (
              <span className="text-muted-foreground">无</span>
            ) : (
              (spec.refs ?? []).map((ref) => (
                <span
                  key={ref.repoId}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="font-mono text-[11px]">{ref.name}</span>
                  {ref.sha ? (
                    <ShaChip
                      sha={ref.sha}
                      href={commitHtmlUrl(ref.url, ref.sha)}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      确认时钉住
                    </span>
                  )}
                </span>
              ))
            )}
          </dd>
        </div>
        <div
          id={draft ? undefined : "flow-confirm"}
          className={draft ? undefined : "scroll-mt-6"}
        >
          <dt className="text-xs text-muted-foreground">当前步骤</dt>
          <dd className="mt-1">
            {currentStep}
            <span
              className="ml-2 text-muted-foreground"
              data-testid="spec-stats"
            >
              票 {progress.done}/{progress.total}
              {blocked.length > 0 ? ` · 卡住 ${blocked.length}` : ""}
            </span>
          </dd>
        </div>
        {leadTime ? <LeadTimeBar leadTime={leadTime} /> : null}
        {usageByStage.length > 0 ? (
          <div className="sm:col-span-2" data-testid="usage-by-stage">
            <dt className="text-xs text-muted-foreground">用量</dt>
            <dd className="mt-1 max-w-full overflow-x-auto">
              <table className="w-max min-w-[16rem] overflow-hidden rounded-md border bg-card text-left text-xs">
                <thead className="border-b bg-surface text-[11px] text-muted-foreground">
                  <tr>
                    <th className="whitespace-nowrap py-2 pl-3 pr-6 font-medium">
                      阶段
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      输入
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      输出
                    </th>
                    <th className="whitespace-nowrap py-2 pl-3 pr-3 text-right font-medium tabular-nums">
                      缓存读
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {usageByStage.map((row) => (
                    <tr key={row.stage}>
                      <td className="whitespace-nowrap py-2 pl-3 pr-6">
                        {stageLabel[row.stage] ?? row.stage}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                        {formatTokens(row.inputTokens)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                        {formatTokens(row.outputTokens)}
                      </td>
                      <td className="whitespace-nowrap py-2 pl-3 pr-3 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {formatTokens(row.cacheReadTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </dd>
          </div>
        ) : null}
        {spec.planningSha ? (
          <div>
            <dt className="text-xs text-muted-foreground">规划提交</dt>
            <dd className="mt-1">
              <ShaChip
                sha={spec.planningSha}
                href={
                  planningRepo
                    ? commitHtmlUrl(planningRepo.url, spec.planningSha)
                    : null
                }
              />
              {spec.planningRepo ? (
                <span className="ml-2 text-muted-foreground">
                  {spec.planningRepo}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {spec.sourceSpec ? (
          <div data-testid="source-spec">
            <dt className="text-xs text-muted-foreground">原需求</dt>
            <dd className="mt-1">
              <a
                href={paths.spec(spec.sourceSpec.id)}
                className="text-primary hover:underline"
              >
                {spec.sourceSpec.displayId}
              </a>{" "}
              {spec.sourceSpec.title}
            </dd>
          </div>
        ) : null}
        {potentialConflicts.length > 0 ? (
          <div>
            <dt className="text-xs text-muted-foreground">潜在冲突</dt>
            <dd className="mt-1">
              <ul
                className="warnings text-state-paused"
                data-testid="potential-conflicts"
              >
                {potentialConflicts.map((conflict) => (
                  <li key={`${conflict.specId}:${conflict.repoId}`}>
                    {`和 ${conflict.displayId} ${conflict.title} 在 ${conflict.repo} 有潜在冲突：${conflict.files.join("、")}；后合并的一方在更新集成分支时处理`}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {(spec.integrationBranches ?? []).length > 0 ? (
          <div>
            <dt className="text-xs text-muted-foreground">集成分支</dt>
            <dd className="mt-1 flex flex-col gap-1 font-mono text-[11px]">
              {(spec.integrationBranches ?? []).map((branch) => {
                const href = branch.url
                  ? treeHtmlUrl(branch.url, branch.branch)
                  : null;
                return (
                  <span key={`${branch.repoId}-${branch.branch}`}>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {branch.branch}
                      </a>
                    ) : (
                      branch.branch
                    )}
                    {branch.name ? (
                      <span className="ml-2 text-muted-foreground">
                        {branch.name}
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </dd>
          </div>
        ) : null}
        {byRepo.size > 0 ? (
          <div>
            <dt className="text-xs text-muted-foreground">按仓库</dt>
            <dd className="mt-1 text-xs text-muted-foreground">
              {[...byRepo.entries()]
                .map(([repo, row]) => `${repo} ${row.done}/${row.total}`)
                .join(" · ")}
            </dd>
          </div>
        ) : null}
        {pullRequests.length > 0 ? (
          <div>
            <dt className="text-xs text-muted-foreground">
              {pullAbbrev(hostKind)}
            </dt>
            <dd className="mt-1 flex flex-col gap-1">
              {pullRequests.map((pr) => (
                <a
                  key={`${pr.repo}-${pr.number}`}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {pr.repo} #{pr.number}
                  <ExternalLink className="size-3" />
                  <StatusBadge kind="pr" code={pr.state} />
                </a>
              ))}
            </dd>
          </div>
        ) : null}
        {lastEvent ? (
          <div>
            <dt className="text-xs text-muted-foreground">最近事件</dt>
            <dd className="mt-1 text-xs">
              {lastEvent.kind in TIMELINE_LABELS
                ? timelineLabel(
                    lastEvent.kind as keyof typeof TIMELINE_LABELS,
                    hostKind,
                  )
                : lastEvent.kind}
              {lastEvent.at ? (
                <>
                  {" · "}
                  <RelativeTime iso={lastEvent.at} />
                </>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {(spec.bugs ?? []).length > 0 ? (
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-semibold">指向它的 bug 需求</h3>
          <ul data-testid="spec-bugs" className="space-y-1 text-sm">
            {(spec.bugs ?? []).map((bug) => (
              <li key={bug.id}>
                <a
                  href={paths.spec(bug.id)}
                  className="text-primary hover:underline"
                >
                  {bug.displayId}
                </a>{" "}
                {bug.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {links.length > 0 ? (
        <TraceSection
          links={links}
          repos={repos}
          ticketTitles={
            new Map(
              tickets.map(
                (ticket) => [ticket.displayId, ticket.title] as const,
              ),
            )
          }
        />
      ) : null}

      {excerpt ? (
        <p className="mb-6 text-sm text-muted-foreground">
          {excerpt}{" "}
          <a
            href={paths.specDescription(spec.id)}
            className="text-primary hover:underline"
          >
            需求说明
          </a>
        </p>
      ) : null}

      {blocked.length > 0 ? (
        <>
          <h3 className="mb-2 text-sm font-semibold">卡住的票</h3>
          <ul className="tickets mb-5">
            {blocked.map((ticket) => (
              <li key={ticket.id}>
                <StatusBadge kind="ticket" code={ticket.state} />{" "}
                <a
                  href={paths.ticket(ticket.id)}
                  onClick={(event) => peekTicketClick(event, ticket.id, onOpen)}
                >
                  {ticket.displayId}
                </a>{" "}
                {ticket.title}
                {ticket.blockedReason ? (
                  <>
                    {" — "}
                    <StatusBadge kind="blocked" code={ticket.blockedReason} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {draft ? (
        <>
          <h3 className="mb-2 text-sm font-semibold">确认前预检</h3>
          {prechecks.length === 0 ? (
            <p className="note">没有黄项</p>
          ) : (
            <ul className="warnings mb-5" data-testid="prechecks">
              {prechecks.map((item) => (
                <li
                  key={`${item.code}:${item.message}`}
                  data-level={item.level}
                  className={
                    item.level === "yellow" ? "text-state-paused" : undefined
                  }
                >
                  {item.message}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <h3 className="mb-3 text-sm font-semibold">依赖图</h3>
      {tickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有导入票。</p>
      ) : (
        <DependencyGraph tickets={tickets} edges={edges} onOpen={onOpen} />
      )}
    </>
  );
}
