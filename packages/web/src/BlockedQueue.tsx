import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import {
  IdChip,
  Mono,
  ReasonBadge,
  RepoTag,
  StateBadge,
} from "./components/afk/badges.tsx";
import { CollapsibleCode, CopyCommand } from "./components/afk/code.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, Skeleton, StaleNotice } from "./components/afk/states.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Input } from "./components/ui/input.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { stageLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { LIST_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import {
  RetryNoteField,
  retryFinalBody,
  retryTicketBody,
} from "./RetryNote.tsx";
import { StructuredBriefView } from "./StructuredBriefView.tsx";
import { structuredBrief } from "./structured-brief.ts";
import { WaitingTicketEdit } from "./TicketEdit.tsx";
import { WORKBENCH_KEY } from "./Workbench.tsx";

export const BLOCKED_KEY = ["blocked"] as const;

function refreshAll(queryClient: QueryClient) {
  return Promise.all(
    [BLOCKED_KEY, WORKBENCH_KEY, ["specs"], ["spec"], ["ticket"]].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

type Queue = NonNullable<ReturnType<typeof useBlocked>["data"]>;

export function useBlocked() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  return useQuery({
    queryKey: BLOCKED_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/blocked");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

function useAction<Action>(run: (action: Action) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => refreshAll(queryClient),
  });
}

function Brief({
  reason,
  brief,
}: {
  reason: string | null;
  brief: Queue["tickets"][number]["brief"];
}) {
  if (!brief || !reason) return null;
  return (
    <StructuredBriefView
      brief={structuredBrief(reason, brief)}
      runId={brief.run.id}
      runDisplayId={brief.run.displayId}
    />
  );
}

function Problem({ error }: { error: unknown }) {
  return error ? (
    <span
      role="alert"
      className="inline-flex items-center gap-1 font-mono text-[11px] text-state-blocked"
    >
      <AlertCircle className="size-3.5 shrink-0" />
      {(error as Error).message}
    </span>
  ) : null;
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 className="animate-spin" /> : null;
}

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
  testId,
  children,
  actions,
}: {
  category: Category;
  title: ReactNode;
  sub: ReactNode;
  testId: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article
      data-testid={testId}
      className="relative overflow-hidden rounded-md border bg-card pl-[3px]"
    >
      <span
        className={cn("absolute inset-y-0 left-0 w-[3px]", barClass[category])}
        aria-hidden
      />
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="flex min-w-0 flex-wrap items-center gap-2 text-[14px] font-medium">
            {title}
          </h3>
          <span className="shrink-0 text-[11px] text-subtle-foreground">
            {categoryLabel[category]}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          {sub}
        </div>
        <div className="mt-3 space-y-2.5 text-[13px]">{children}</div>
        {actions ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            {actions}
          </div>
        ) : null}
      </div>
    </article>
  );
}

type TicketAction =
  | { kind: "retry"; mode: "continue" | "restart" }
  | { kind: "approve" }
  | { kind: "cancel"; cascade: boolean };

function TicketCard({ ticket }: { ticket: Queue["tickets"][number] }) {
  const api = useApi();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [note, setNote] = useState("");
  const id = ticket.id;
  const act = useAction(async (action: TicketAction) => {
    const { data, error } =
      action.kind === "retry"
        ? await api.POST("/tickets/{id}/retry", {
            params: { path: { id } },
            body: retryTicketBody(action.mode, note),
          })
        : action.kind === "approve"
          ? await api.POST("/tickets/{id}/approve-protected", {
              params: { path: { id } },
            })
          : await api.POST("/tickets/{id}/cancel", {
              params: { path: { id } },
              body: { cascade: action.cascade },
            });
    if (!data) throw new Error(describeError(error));
  });
  const busy = act.isPending;
  const canRetry = ticket.blockedReason !== "upstream-cancelled";

  return (
    <Card
      category="ticket"
      testId={`blocked-${ticket.displayId}`}
      title={
        <>
          <IdChip displayId={ticket.displayId} id={ticket.id} />
          <a href={paths.ticket(id)} className="truncate hover:underline">
            {ticket.title}
          </a>
          {ticket.blockedReason ? (
            <ReasonBadge reason={ticket.blockedReason} />
          ) : null}
        </>
      }
      sub={
        <>
          <IdChip displayId={ticket.specDisplayId} id={ticket.specId} />
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={ticket.repo} />
          <Mono className="text-[11px] text-muted-foreground">
            {ticket.type}
          </Mono>
        </>
      }
      actions={
        <>
          <WaitingTicketEdit ticketId={id} />
          {canRetry ? (
            <RetryNoteField
              id={`retry-note-${ticket.displayId}`}
              value={note}
              onChange={setNote}
            />
          ) : (
            <p className="w-full text-xs text-muted-foreground">
              它等的票已取消，重试只会永远等下去。取消这张，或导入替代票
            </p>
          )}
          {canRetry ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => act.mutate({ kind: "retry", mode: "continue" })}
              >
                <Spinner on={busy} />
                重试，保留已有工作
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmRestart(true)}
              >
                <RotateCcw />
                从头重试
              </Button>
            </>
          ) : null}
          {ticket.blockedReason === "protected-path-changed" ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => act.mutate({ kind: "approve" })}
            >
              <ShieldCheck />
              批准这些保护路径
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmCancel(true)}
          >
            取消…
          </Button>
          <Problem error={act.error} />
          <AlertDialog
            open={confirmRestart}
            onOpenChange={(open) => {
              if (!busy) setConfirmRestart(open);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  从头重试 {ticket.displayId}？
                </AlertDialogTitle>
                <AlertDialogDescription>
                  本次重试不会保留已有工作，将重新开始实现。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Problem error={act.error} />
                <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
                <Button
                  disabled={busy}
                  onClick={() =>
                    act.mutate(
                      { kind: "retry", mode: "restart" },
                      { onSuccess: () => setConfirmRestart(false) },
                    )
                  }
                >
                  <Spinner on={busy} />
                  确认从头重试
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={confirmCancel}
            onOpenChange={(open) => {
              if (busy) return;
              setConfirmCancel(open);
              if (!open) setCascade(false);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>取消 {ticket.displayId}？</AlertDialogTitle>
                <AlertDialogDescription>
                  取消不可撤销。依赖它的下游票会以 upstream-cancelled
                  停下，除非一并取消。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <label
                htmlFor="cascade-cancel"
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id="cascade-cancel"
                  checked={cascade}
                  onCheckedChange={(v) => setCascade(v === true)}
                />
                同时取消所有下游票
              </label>
              <AlertDialogFooter>
                <Problem error={act.error} />
                <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    act.mutate(
                      { kind: "cancel", cascade },
                      { onSuccess: () => setConfirmCancel(false) },
                    )
                  }
                >
                  <Spinner on={busy} />
                  永久取消 {ticket.displayId}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      <Brief reason={ticket.blockedReason} brief={ticket.brief} />
    </Card>
  );
}

const MAX_EXTRA_HOURS = 168;

function PausedSpec({ spec }: { spec: Queue["specs"][number] }) {
  const api = useApi();
  const [hours, setHours] = useState("1");
  const seconds = Math.round(Number(hours) * 3600);
  const valid =
    hours.trim() !== "" &&
    Number.isFinite(seconds) &&
    seconds >= 1 &&
    Number(hours) <= MAX_EXTRA_HOURS;
  const resume = useAction(async (extraSeconds: number) => {
    const { data, error } = await api.POST("/specs/{id}/resume", {
      params: { path: { id: spec.id } },
      body: { extraSeconds },
    });
    if (!data) throw new Error(describeError(error));
  });
  return (
    <Card
      category="paused"
      testId={`paused-${spec.displayId}`}
      title={
        <>
          <IdChip displayId={spec.displayId} id={spec.id} />
          <a href={paths.spec(spec.id)} className="truncate hover:underline">
            {spec.title}
          </a>
          <StateBadge kind="spec" state="paused" />
        </>
      }
      sub={<span>暂停的需求</span>}
      actions={
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) resume.mutate(seconds);
          }}
        >
          <label
            htmlFor={`${spec.displayId}-extra-hours`}
            className="flex items-center gap-2 text-[13px]"
          >
            追加
            <Input
              id={`${spec.displayId}-extra-hours`}
              type="number"
              min={0}
              max={MAX_EXTRA_HOURS}
              step={0.5}
              value={hours}
              aria-label={`${spec.displayId} 追加的 agent 小时`}
              onChange={(event) => setHours(event.target.value)}
              className="h-8 w-20 font-mono tabular"
            />
            小时 agent 时间
          </label>
          <Button type="submit" size="sm" disabled={resume.isPending || !valid}>
            <Spinner on={resume.isPending} />
            {!resume.isPending && <Play />}
            恢复
          </Button>
          <Problem error={resume.error} />
        </form>
      }
    >
      <p>{spec.reason}</p>
    </Card>
  );
}

function BlockedFinalization({
  item,
}: {
  item: Queue["finalizations"][number];
}) {
  const api = useApi();
  const [note, setNote] = useState("");
  const [confirmWaive, setConfirmWaive] = useState(false);
  const retry = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/final/retry", {
      params: { path: { id: item.specId } },
      body: retryFinalBody(note),
    });
    if (!data) throw new Error(describeError(error));
  });
  const waive = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/final/waive", {
      params: { path: { id: item.specId } },
    });
    if (!data) throw new Error(describeError(error));
  });
  const beforePullRequests = item.step === "final-e2e";
  const busy = retry.isPending || waive.isPending;
  return (
    <Card
      category="final"
      testId={`final-${item.specDisplayId}-${item.repo}`}
      title={
        <>
          <IdChip displayId={item.specDisplayId} id={item.specId} />
          <span>
            {beforePullRequests ? "开 PR 前的联调" : `${item.repo} 的总览审查`}
          </span>
          {item.blockedReason ? (
            <ReasonBadge reason={item.blockedReason} />
          ) : null}
        </>
      }
      sub={
        <>
          <a href={paths.spec(item.specId)} className="hover:underline">
            {item.specDisplayId}
          </a>
          <span className="text-subtle-foreground">·</span>
          <Mono title={stageLabel[item.step]}>{item.step}</Mono>
          {item.repo ? <RepoTag name={item.repo} /> : null}
        </>
      }
      actions={
        <>
          <RetryNoteField
            id={`retry-note-final-${item.specDisplayId}-${item.repo}`}
            value={note}
            onChange={setNote}
          />
          <Button size="sm" disabled={busy} onClick={() => retry.mutate()}>
            <Spinner on={retry.isPending} />
            {!retry.isPending && <Play />}
            再跑一次 {item.step}
          </Button>
          {beforePullRequests ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmWaive(true)}
            >
              仍然开 PR
            </Button>
          ) : null}
          <Problem error={retry.error ?? waive.error} />
          <AlertDialog
            open={confirmWaive}
            onOpenChange={(v) => {
              if (!busy) setConfirmWaive(v);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>跳过联调，仍然开 PR？</AlertDialogTitle>
                <AlertDialogDescription>
                  {item.specDisplayId} 会在联调没通过的情况下继续收尾并开
                  PR。验收包会在「联调」一节最前面写明这次失败，合并前请务必看到。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Problem error={waive.error} />
                <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
                <Button
                  disabled={busy}
                  onClick={() =>
                    waive.mutate(undefined, {
                      onSuccess: () => setConfirmWaive(false),
                    })
                  }
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
      <Brief reason={item.blockedReason} brief={item.brief} />
    </Card>
  );
}

function StuckPullRequest({ item }: { item: Queue["pullRequests"][number] }) {
  return (
    <Card
      category="pr"
      testId={`pull-${item.specDisplayId}-${item.repo}`}
      title={
        <>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[13px] hover:underline"
          >
            {item.repo} #{item.number}
            <ExternalLink className="size-3 text-muted-foreground" />
          </a>
          {item.state === "closed" ? (
            <span
              title="closed"
              className="inline-flex h-5 items-center rounded-sm border border-state-blocked/30 bg-state-blocked/8 px-1.5 text-[11px] text-state-blocked"
            >
              <span className="mr-1 font-mono">closed</span>关闭未合并
            </span>
          ) : null}
          {item.syncError ? (
            <span className="inline-flex h-5 items-center rounded-sm border border-state-paused/30 bg-state-paused/8 px-1.5 text-[11px] text-state-paused">
              读取失败
            </span>
          ) : null}
        </>
      }
      sub={
        <>
          <a href={paths.spec(item.specId)} className="hover:underline">
            {item.specDisplayId}
          </a>
          <span className="text-subtle-foreground">·</span>
          <RepoTag name={item.repo} />
        </>
      }
    >
      {item.syncError ? (
        <CollapsibleCode text={`读取失败：${item.syncError}`} />
      ) : null}
      <p className="text-muted-foreground">
        {item.state === "closed"
          ? "这个 PR 被关闭了，但没有合并。"
          : "平台读取这个 PR 失败，当前看到的状态可能不是最新的。"}
        平台从不操作
        PR，请你决定：到代码托管上重新打开它、返工这个需求，或取消它。
      </p>
      <CopyCommand command={`plat spec cancel ${item.specDisplayId}`} />
    </Card>
  );
}

function StuckCleanup({ item }: { item: Queue["cleanups"][number] }) {
  return (
    <Card
      category="cleanup"
      testId={`cleanup-${item.specDisplayId}`}
      title={
        <>
          <IdChip displayId={item.specDisplayId} id={item.specId} />
          <span>没清理完</span>
        </>
      }
      sub={
        <a href={paths.spec(item.specId)} className="hover:underline">
          {item.specDisplayId}
        </a>
      }
    >
      <CollapsibleCode text={item.error} />
      <p className="text-muted-foreground">
        代码托管上可能还残留着这个需求的分支或 PR。确认后用下面的命令重新清理：
      </p>
      <CopyCommand command={`plat spec cleanup ${item.specDisplayId}`} />
    </Card>
  );
}

function StuckReady({ item }: { item: Queue["readyFailures"][number] }) {
  return (
    <Card
      category="ready"
      testId={`ready-${item.specDisplayId}-${item.repo}`}
      title={
        <>
          <IdChip displayId={item.specDisplayId} id={item.specId} />
          <span>
            <Mono>{item.repo}</Mono> 的 draft PR 没能转为 ready
          </span>
        </>
      }
      sub={
        <>
          <a href={paths.spec(item.specId)} className="hover:underline">
            {item.specDisplayId}
          </a>
          <span className="text-subtle-foreground">·</span>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {item.repo} #{item.number}
          </a>
        </>
      }
    >
      <CollapsibleCode text={item.error} />
      <p className="text-muted-foreground">
        这个 PR 仍是 draft。等排在它前面的 PR 合并后，到代码托管上手动把它转为
        ready，平台下次同步时会看到。
      </p>
    </Card>
  );
}

function CalmIllustration() {
  return (
    <svg viewBox="0 0 160 110" className="h-28 w-40" aria-hidden>
      <g
        className="stroke-border-strong"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M10 92 H150" />
        <path d="M30 92 V60 H58 V92" />
        <path d="M70 92 V40 H98 V92" />
        <path d="M110 92 V68 H130 V92" />
        <path d="M84 40 V24" />
        <circle cx="84" cy="20" r="4" />
      </g>
      <circle
        cx="84"
        cy="20"
        r="2"
        className="fill-state-done animate-breathe"
      />
      <path
        d="M78 66 l5 5 l9 -10"
        fill="none"
        className="stroke-state-done"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const FILTERS = ["all", "tickets", "final", "pr", "cleanup", "paused"] as const;
type Filter = (typeof FILTERS)[number];

export function BlockedQueue() {
  const queue = useBlocked();
  const [type, setType] = useState<Filter>("all");
  const data = queue.data;
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
  counts.all =
    counts.tickets + counts.final + counts.pr + counts.cleanup + counts.paused;
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
      actions={<StaleNotice error={data ? queue.error : null} />}
    >
      {!data && !queue.isError ? <p className="sr-only">加载待处理…</p> : null}
      <div
        role="tablist"
        aria-label="按类别筛选"
        className="mb-4 inline-flex rounded-md border bg-surface p-0.5"
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={type === f}
            onClick={() => setType(f)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground",
              type === f && "bg-background text-foreground shadow-sm",
            )}
          >
            {filterLabel[f]}
            <span
              className={cn(
                "min-w-4 rounded-full px-1 font-mono text-[10.5px] tabular",
                data && counts[f] > 0
                  ? f === "all" || f === "tickets"
                    ? "bg-state-blocked/15 text-state-blocked"
                    : "bg-muted text-foreground"
                  : "text-subtle-foreground",
              )}
            >
              {data ? counts[f] : "·"}
            </span>
          </button>
        ))}
      </div>
      {queue.isError && !data ? (
        <ErrorState
          error={queue.error}
          prefix="无法加载待处理"
          onRetry={() => void queue.refetch()}
        />
      ) : !data ? (
        <div className="space-y-3">
          {["sk-a", "sk-b", "sk-c"].map((key) => (
            <div key={key} className="rounded-md border bg-card p-4">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-2 h-4 w-1/3" />
              <Skeleton className="mt-4 h-20 w-full" />
            </div>
          ))}
        </div>
      ) : counts[type] === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-16 text-center">
          <CalmIllustration />
          <p className="mt-4 text-sm font-medium">
            {type === "all" ? "没有在等你的事" : "这一类没有在等你的事"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            平台在自己跑，有需要你的时候这里会亮起来。
          </p>
          <p className="sr-only">没有在等你的事。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {show("tickets") &&
            data.tickets.map((ticket) => (
              <TicketCard
                key={`${ticket.id}-${ticket.blockedReason}`}
                ticket={ticket}
              />
            ))}
          {show("final") &&
            data.finalizations.map((item) => (
              <BlockedFinalization
                key={`${item.specId}-${item.repo}`}
                item={item}
              />
            ))}
          {show("pr") &&
            data.pullRequests.map((p) => (
              <StuckPullRequest key={`${p.specId}-${p.repo}`} item={p} />
            ))}
          {show("pr") &&
            data.readyFailures.map((r) => (
              <StuckReady key={`${r.specId}-${r.repo}`} item={r} />
            ))}
          {show("cleanup") &&
            data.cleanups.map((c) => <StuckCleanup key={c.specId} item={c} />)}
          {show("paused") &&
            data.specs.map((spec) => <PausedSpec key={spec.id} spec={spec} />)}
        </div>
      )}
    </Page>
  );
}
