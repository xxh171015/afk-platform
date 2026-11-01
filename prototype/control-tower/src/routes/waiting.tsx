import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ExternalLink, Loader2, RotateCcw, ShieldCheck, Play } from "lucide-react";
import { useState, type ReactNode } from "react";

import { blockedQuery, specsQuery, useResumeSpec, useRetryFinal, useWaiveFinal } from "@/api/queries";
import type { Cleanup, Finalization, PullRequest, ReadyFailure, SpecSummary, Ticket } from "@/api/types";
import { Page } from "@/components/afk/app-shell";
import { IdChip, Mono, ReasonBadge, RepoTag, StateBadge } from "@/components/afk/badges";
import { CollapsibleCode, CopyCommand } from "@/components/afk/code";
import { ErrorState, Skeleton, StaleNotice } from "@/components/afk/states";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { BlockedTicketActions } from "@/components/afk/blocked-ticket-actions";
import { Input } from "@/components/ui/input";
import { structuredBrief, ticketToBriefInput } from "@/lib/view-map";
import { blockedReasonGuide } from "@/lib/blocked-reasons";
import { StructuredBrief } from "@/components/afk/structured-brief";
import { prCiLabel, stageLabel } from "@/lib/labels";
import { MAX_RESUME_HOURS, parseResumeHours, RESUME_STEP_HOURS } from "@/lib/resume-hours";
import { cn } from "@/lib/utils";

const FILTERS = ["all", "tickets", "final", "pr", "cleanup", "paused"] as const;
type Filter = (typeof FILTERS)[number];

export const Route = createFileRoute("/waiting")({
  validateSearch: (s: Record<string, unknown>): { type?: Filter } =>
    FILTERS.includes(s["type"] as Filter) && s["type"] !== "all" ? { type: s["type"] as Filter } : {},
  head: () => ({
    meta: [
      { title: "待处理 · AFK 平台" },
      { name: "description", content: "所有需要人工处理的受阻票、收尾步骤、PR、清理失败与暂停的需求。" },
      { property: "og:title", content: "待处理 · AFK 平台" },
      { property: "og:description", content: "所有需要人工处理的受阻票、收尾步骤、PR、清理失败与暂停的需求。" },
      { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Waiting,
});

/* ---------------- 通用卡片 ---------------- */

type Category = "ticket" | "final" | "pr" | "ready" | "cleanup" | "paused";

const barClass: Record<Category, string> = {
  ticket: "bg-state-blocked",
  final: "bg-state-merging",
  pr: "bg-state-review",
  ready: "bg-state-queued",
  cleanup: "bg-state-neutral",
  paused: "bg-state-paused",
};
const categoryLabel: Record<Category, string> = {
  ticket: "blocked 票",
  final: "停下的收尾",
  pr: "需要看的 PR",
  ready: "没能转为 ready",
  cleanup: "没清理完",
  paused: "暂停的需求",
};

function Card({
  category,
  title,
  sub,
  leaving,
  children,
  actions,
}: {
  category: Category;
  title: ReactNode;
  sub: ReactNode;
  leaving?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-md border bg-card pl-[3px] transition-all duration-500",
        leaving && "pointer-events-none -translate-y-1 scale-[0.99] opacity-0",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", barClass[category])} aria-hidden />
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="flex min-w-0 flex-wrap items-center gap-2 text-[14px] font-medium">{title}</h3>
          <span className="shrink-0 text-[11px] text-subtle-foreground">{categoryLabel[category]}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">{sub}</div>
        <div className="mt-3 space-y-2.5 text-[13px]">{children}</div>
        {actions && <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">{actions}</div>}
      </div>
    </article>
  );
}

function SpecLink({ id, displayId, title }: { id: string; displayId: string; title: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <IdChip displayId={displayId} id={id} />
      {title && (
        <Link to="/specs/$id" params={{ id }} className="truncate hover:text-foreground hover:underline">
          {title}
        </Link>
      )}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle-foreground">{children}</div>;
}

function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <span role="alert" className="inline-flex items-center gap-1 font-mono text-[11px] text-state-blocked">
      <AlertCircle className="size-3.5 shrink-0" />
      {error instanceof Error ? error.message : String(error)}
    </span>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 className="animate-spin" /> : null;
}

/* ---------------- 1. Blocked 票 ---------------- */

function TicketCard({ t, specTitle }: { t: Ticket; specTitle: string | undefined }) {
  const [leaving, setLeaving] = useState(false);
  const reason = t.blockedReason;
  const briefInput = ticketToBriefInput(t);

  return (
    <Card
      category="ticket"
      leaving={leaving}
      title={
        <>
          <IdChip displayId={t.displayId} id={t.id} />
          <Link to="/tickets/$id" params={{ id: t.id }} className="truncate hover:underline">
            {t.title}
          </Link>
          {reason && <ReasonBadge reason={reason} />}
        </>
      }
      sub={
        <>
          <SpecLink id={t.specId} displayId={t.specDisplayId} title={specTitle} />
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={t.repo} />
          <Mono className="text-[11px] text-muted-foreground">{t.type}</Mono>
        </>
      }
      actions={<BlockedTicketActions ticket={t} onSuccess={() => setLeaving(true)} />}
    >
      {briefInput && <StructuredBrief brief={structuredBrief(briefInput)} runId={t.blockedRun?.id} runDisplayId={t.blockedRun?.displayId} />}
    </Card>
  );
}


/* ---------------- 2. 停下的收尾 ---------------- */

function FinalCard({ f, specTitle }: { f: Finalization; specTitle: string | undefined }) {
  const retry = useRetryFinal();
  const waive = useWaiveFinal();
  const [confirmWaive, setConfirmWaive] = useState(false);
  const isE2e = f.step === "final-e2e";
  const title = isE2e ? "开 PR 前的联调" : `${f.repo ?? "全部仓库"} 的总览审查`;
  const busy = retry.isPending || waive.isPending;

  return (
    <Card
      category="final"
      leaving={retry.isSuccess || waive.isSuccess}
      title={
        <>
          <IdChip displayId={f.specDisplayId} id={f.specId} />
          <span>{title}</span>
          {f.blockedReason && <ReasonBadge reason={f.blockedReason} />}
        </>
      }
      sub={
        <>
          <SpecLink id={f.specId} displayId={f.specDisplayId} title={specTitle} />
          <span className="text-subtle-foreground">·</span>
          <Mono title={stageLabel[f.step]}>{f.step}</Mono>
          {f.repo && <RepoTag name={f.repo} />}
        </>
      }
      actions={
        <>
          <Button size="sm" disabled={busy} onClick={() => retry.mutate(f.specId)}>
            <Spinner on={retry.isPending} />
            {!retry.isPending && <Play />}
            再跑一次 <span className="font-mono">{f.step}</span>
          </Button>
          {isE2e && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmWaive(true)}>
              <Spinner on={waive.isPending} />
              仍然开 PR
            </Button>
          )}
          <ActionError error={retry.error ?? waive.error} />
          <AlertDialog open={confirmWaive} onOpenChange={v => { if (!busy) setConfirmWaive(v); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>跳过联调，仍然开 PR？</AlertDialogTitle>
                <AlertDialogDescription>
                  {f.specDisplayId} 会在联调没通过的情况下继续收尾并开 PR。验收包会在「联调」一节最前面写明这次失败，合并前请务必看到。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <ActionError error={waive.error} />
                <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
                <Button
                  disabled={busy}
                  onClick={() => {
                    waive.mutate(f.specId, { onSuccess: () => setConfirmWaive(false) });
                  }}
                >
                  <Spinner on={waive.isPending} />
                  仍然开 PR
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      {f.blockedReason && (
        <div className="rounded-md bg-surface px-3 py-2">
          <p>{blockedReasonGuide[f.blockedReason].explain}</p>
          <p className="mt-0.5 text-muted-foreground">
            <span className="text-foreground/80">建议：</span>
            {blockedReasonGuide[f.blockedReason].suggest}
          </p>
        </div>
      )}
      <div>
        <Label>简报</Label>
        {f.runId && f.runDisplayId && (
          <p className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Mono>{f.step}</Mono> 以 <Mono className="text-state-blocked">failed</Mono> 结束，在 <IdChip displayId={f.runDisplayId} id={f.runId} />
          </p>
        )}
        {f.blockedDetail && <CollapsibleCode text={f.blockedDetail} />}
      </div>
    </Card>
  );
}

/* ---------------- 3. PR / 5. ready 失败 ---------------- */

function PrLink({ pr }: { pr: { url: string; repo: string; number: number } }) {
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[13px] hover:underline">
      {pr.repo}#{pr.number}
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function PrCard({ pr, specTitle }: { pr: PullRequest; specTitle: string | undefined }) {
  return (
    <Card
      category="pr"
      title={
        <>
          <PrLink pr={pr} />
          <span className="truncate">{pr.title}</span>
          {pr.state === "closed" && (
            <span className="inline-flex h-5 items-center rounded-sm border border-state-blocked/30 bg-state-blocked/8 px-1.5 text-[11px] text-state-blocked">
              <span className="mr-1 font-mono">closed</span>关闭未合并
            </span>
          )}
          {pr.syncError && (
            <span className="inline-flex h-5 items-center rounded-sm border border-state-paused/30 bg-state-paused/8 px-1.5 text-[11px] text-state-paused">
              <span className="mr-1 font-mono">syncError</span>读取失败
            </span>
          )}
        </>
      }
      sub={
        <>
          <SpecLink id={pr.specId} displayId={pr.specDisplayId} title={specTitle} />
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={pr.repo} />
          <Mono className="text-[11px] text-muted-foreground">{pr.headBranch}</Mono>
          <span className="text-subtle-foreground">→</span>
          <Mono className="text-[11px] text-muted-foreground">{pr.baseBranch}</Mono>
          {pr.draft && <Mono className="text-[11px]">draft</Mono>}
          <span className="font-mono text-[11px]" title={prCiLabel[pr.ci]}>ci:{pr.ci}</span>
        </>
      }
    >
      {pr.syncError && <CollapsibleCode text={pr.syncError} />}
      <p className="text-muted-foreground">
        {pr.state === "closed"
          ? "这个 PR 被关闭了，但没有合并。"
          : "平台读取这个 PR 失败，当前看到的状态可能不是最新的。"}
        平台从不操作 PR，请你决定：到代码托管上重新打开它、返工这个需求，或取消它。
      </p>
      <CopyCommand command={`plat spec cancel ${pr.specDisplayId}`} />
    </Card>
  );
}

function ReadyCard({ r, specTitle }: { r: ReadyFailure; specTitle: string | undefined }) {
  return (
    <Card
      category="ready"
      title={
        <>
          <IdChip displayId={r.specDisplayId} id={r.specId} />
          <span><Mono>{r.repo}</Mono> 的 draft PR 没能转为 ready</span>
        </>
      }
      sub={
        <>
          <SpecLink id={r.specId} displayId={r.specDisplayId} title={specTitle} />
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={r.repo} />
          <Mono className="text-[11px] text-muted-foreground">{r.step}</Mono>
        </>
      }
    >
      <CollapsibleCode text={r.error} />
      <p className="text-muted-foreground">
        这个 PR 仍是 draft。等排在它前面的 PR 合并后，到代码托管上手动把它转为 ready，平台下次同步时会看到。
      </p>
    </Card>
  );
}

/* ---------------- 4. 清理 ---------------- */

function CleanupCard({ c, specTitle }: { c: Cleanup; specTitle: string | undefined }) {
  return (
    <Card
      category="cleanup"
      title={
        <>
          <IdChip displayId={c.specDisplayId} id={c.specId} />
          <span>没清理完的 <Mono>{c.kind}</Mono></span>
          <Mono className="text-muted-foreground">{c.target}</Mono>
        </>
      }
      sub={
        <>
          <SpecLink id={c.specId} displayId={c.specDisplayId} title={specTitle} />
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={c.repo} />
        </>
      }
    >
      <CollapsibleCode text={c.error} />
      <p className="text-muted-foreground">代码托管上可能还残留着这个需求的分支或 PR。确认后用下面的命令重新清理：</p>
      <CopyCommand command={`plat spec cleanup ${c.specDisplayId}`} />
    </Card>
  );
}

/* ---------------- 6. 暂停的需求 ---------------- */

const pauseReasonLabel: Record<string, string> = {
  "time-budget-exceeded": "agent 时间预算用完",
};

function PausedCard({ s }: { s: SpecSummary }) {
  const resume = useResumeSpec();
  const [hours, setHours] = useState("4");
  const parsed = parseResumeHours(hours);

  return (
    <Card
      category="paused"
      leaving={resume.isSuccess}
      title={
        <>
          <IdChip displayId={s.displayId} id={s.id} />
          <Link to="/specs/$id" params={{ id: s.id }} className="truncate hover:underline">
            {s.title}
          </Link>
          <StateBadge kind="spec" state="paused" showLabel />
        </>
      }
      sub={
        <>
          <span>项目 {s.project}</span>
          <span className="text-subtle-foreground">·</span>
          <span className="font-mono tabular">{s.progress.done}/{s.progress.total} done</span>
        </>
      }
      actions={
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.ok) resume.mutate({ id: s.id, extraSeconds: parsed.seconds });
          }}
        >
          <label className="flex items-center gap-2 text-[13px]">
            追加
            <Input
              type="number"
              inputMode="decimal"
              min={RESUME_STEP_HOURS}
              max={MAX_RESUME_HOURS}
              step={RESUME_STEP_HOURS}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-invalid={!parsed.ok}
              className={cn("h-8 w-20 font-mono tabular", !parsed.ok && "border-state-blocked/60")}
            />
            小时 agent 时间
          </label>
          <div className="flex gap-1">
            {[1, 4, 24].map((h) => (
              <Button key={h} type="button" size="sm" variant="outline" className="h-8 px-2 font-mono" onClick={() => setHours(String(h))}>
                {h}h
              </Button>
            ))}
          </div>
          <Button type="submit" size="sm" disabled={!parsed.ok || resume.isPending}>
            <Spinner on={resume.isPending} />
            {!resume.isPending && <Play />}
            恢复
          </Button>
          {!parsed.ok && <span className="text-[12px] text-state-blocked">{parsed.error}</span>}
          {parsed.ok && <span className="font-mono text-[11px] text-subtle-foreground">extraSeconds={parsed.seconds}</span>}
          <ActionError error={resume.error} />
        </form>
      }
    >
      <p>
        暂停原因：
        {s.pauseReason ? (
          <>
            <Mono>{s.pauseReason}</Mono>
            {pauseReasonLabel[s.pauseReason] && <span className="ml-1.5 text-muted-foreground">（{pauseReasonLabel[s.pauseReason]}）</span>}
          </>
        ) : (
          <span className="text-muted-foreground">未注明</span>
        )}
      </p>
    </Card>
  );
}

/* ---------------- 空状态 ---------------- */

function CalmIllustration() {
  return (
    <svg viewBox="0 0 160 110" className="h-28 w-40" aria-hidden>
      <g className="stroke-border-strong" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M10 92 H150" />
        <path d="M30 92 V60 H58 V92" />
        <path d="M70 92 V40 H98 V92" />
        <path d="M110 92 V68 H130 V92" />
        <path d="M84 40 V24" />
        <circle cx="84" cy="20" r="4" />
      </g>
      <circle cx="84" cy="20" r="2" className="fill-state-done animate-breathe" />
      <g className="stroke-subtle-foreground" strokeWidth="1" strokeLinecap="round" opacity="0.5">
        <path d="M120 22 q6 -4 12 0" fill="none" />
        <path d="M134 32 q4 -3 8 0" fill="none" />
      </g>
      <path d="M78 66 l5 5 l9 -10" fill="none" className="stroke-state-done" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Calm({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-16 text-center">
      <CalmIllustration />
      <p className="mt-4 text-sm font-medium">{filtered ? "这一类没有在等你的事" : "没有在等你的事"}</p>
      <p className="mt-1 text-xs text-muted-foreground">平台在自己跑，有需要你的时候这里会亮起来。</p>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

function Waiting() {
  const { type = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: "/waiting" });
  const { data, error, refetch } = useQuery(blockedQuery());
  const specs = useQuery(specsQuery());
  const titleOf = (id: string) => specs.data?.specs.find((s) => s.id === id)?.title;

  const counts: Record<Filter, number> = data
    ? {
        tickets: data.tickets.length,
        final: data.finalizations.length,
        pr: data.pullRequests.length + data.readyFailures.length,
        cleanup: data.cleanups.length,
        paused: data.specs.length,
        all: 0,
      }
    : { all: 0, tickets: 0, final: 0, pr: 0, cleanup: 0, paused: 0 };
  counts.all = counts.tickets + counts.final + counts.pr + counts.cleanup + counts.paused;

  const filterLabel: Record<Filter, string> = {
    all: "全部",
    tickets: "blocked 票",
    final: "收尾",
    pr: "PR",
    cleanup: "清理",
    paused: "暂停的需求",
  };
  const show = (f: Filter) => type === "all" || type === f;

  return (
    <Page
      title="待处理"
      subtitle="平台停下来等人的所有事。处理完的卡片会自动消失。"
      actions={<StaleNotice error={data ? error ?? specs.error : null} />}
    >
      <div role="tablist" aria-label="按类别筛选" className="mb-4 inline-flex rounded-md border bg-surface p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={type === f}
            onClick={() => navigate({ search: f === "all" ? {} : { type: f } })}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground",
              type === f && "bg-background text-foreground shadow-sm",
            )}
          >
            {filterLabel[f]}
            <span
              className={cn(
                "min-w-4 rounded-full px-1 font-mono text-[10.5px] tabular",
                data && counts[f] > 0 ? (f === "all" || f === "tickets" ? "bg-state-blocked/15 text-state-blocked" : "bg-muted text-foreground") : "text-subtle-foreground",
              )}
            >
              {data ? counts[f] : "·"}
            </span>
          </button>
        ))}
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-md border bg-card p-4">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-2 h-4 w-1/3" />
              <Skeleton className="mt-4 h-20 w-full" />
            </div>
          ))}
        </div>
      ) : counts[type] === 0 ? (
        <Calm filtered={type !== "all"} />
      ) : (
        <div className="space-y-3">
          {show("tickets") && data.tickets.map((t) => <TicketCard key={t.id} t={t} specTitle={titleOf(t.specId)} />)}
          {show("final") && data.finalizations.map((f) => <FinalCard key={f.id} f={f} specTitle={titleOf(f.specId)} />)}
          {show("pr") && data.pullRequests.map((p) => <PrCard key={p.id} pr={p} specTitle={titleOf(p.specId)} />)}
          {show("pr") && data.readyFailures.map((r) => <ReadyCard key={r.id} r={r} specTitle={titleOf(r.specId)} />)}
          {show("cleanup") && data.cleanups.map((c) => <CleanupCard key={c.id} c={c} specTitle={titleOf(c.specId)} />)}
          {show("paused") && data.specs.map((s) => <PausedCard key={s.id} s={s} />)}
        </div>
      )}
    </Page>
  );
}
