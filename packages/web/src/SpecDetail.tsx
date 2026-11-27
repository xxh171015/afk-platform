import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { IdChip, Mono, RepoTag } from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { SegmentedProgress } from "./components/afk/progress-bar.tsx";
import {
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import { hostKindOfRepos, pullAbbrev } from "./host-copy.ts";
import { specTypeLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { SpecBody } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { ReviewPage } from "./ReviewPage.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { Delivery } from "./spec-detail/delivery.tsx";
import { Overview } from "./spec-detail/overview.tsx";
import { TicketsPage } from "./spec-detail/tickets.tsx";
import { TimelinePage } from "./spec-detail/timeline.tsx";
import { list, useSpecView } from "./spec-detail/view.ts";
import {
  currentFlowStep,
  FLOW_STEPS,
  flowBanner,
  flowStepCaption,
  flowStepComplete,
  flowStepHref,
  flowStepIndex,
  flowStepLabel,
  flowStepLocation,
  flowStepReached,
  ticketProgress,
} from "./spec-flow.ts";
import { visibleTimeline } from "./spec-timeline.ts";
import { TicketSheet } from "./TicketDetail.tsx";
import { formatShanghaiTime } from "./time.ts";

// One spec: the dependency graph with a node per ticket coloured by its state, the yellow prechecks before
// confirm, and the button that confirms the split so that the platform starts working on it.

export type SpecSection =
  | "overview"
  | "description"
  | "tickets"
  | "delivery"
  | "review"
  | "timeline";

const SECTIONS: {
  id: SpecSection;
  label: string;
  href: (id: number) => string;
  needsPulls?: boolean;
}[] = [
  { id: "overview", label: "概览", href: paths.spec },
  { id: "description", label: "需求说明", href: paths.specDescription },
  { id: "tickets", label: "票与依赖", href: paths.specTickets },
  { id: "delivery", label: "交付", href: paths.specDelivery },
  { id: "review", label: "审查", href: paths.specReview, needsPulls: true },
  { id: "timeline", label: "时间线", href: paths.specTimeline },
];

export function SpecDetail({
  specId,
  section = "overview",
  hash = "",
}: {
  specId: number;
  section?: SpecSection;
  hash?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const view = useSpecView(specId);
  const confirm = useMutation({
    mutationFn: async (leavePlanningChanges?: boolean) => {
      const { data, error } = await api.POST("/specs/{specId}/confirm", {
        params: { path: { specId } },
        ...(leavePlanningChanges
          ? { body: { leavePlanningChanges: true } }
          : {}),
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["spec", specId] });
      void queryClient.invalidateQueries({ queryKey: ["specs"] });
    },
  });

  const [openTicket, setOpenTicket] = useState<number | null>(null);
  useEffect(() => {
    if (view.isPending) return;
    const id = hash.replace(/^#/, "");
    if (!id) return;
    document
      .getElementById(id)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [hash, view.isPending]);
  if (view.isPending)
    return (
      <Page title="需求">
        <p className="sr-only">加载这份需求…</p>
        <RowsSkeleton rows={8} />
      </Page>
    );
  if (view.isError && !view.data)
    return (
      <Page title="需求">
        <ErrorState
          error={view.error}
          prefix="无法加载这份需求"
          onRetry={() => void view.refetch()}
        />
      </Page>
    );
  const data = view.data;
  if (!data) return null;
  const {
    spec,
    tickets,
    edges,
    finalizations,
    pullRequests,
    mergeOrder,
    orderBroken,
    acceptancePack,
    timeline: timelineEvents,
    timelineLegacy,
    finalRuns,
    potentialConflicts,
    leadTime,
    usageByStage,
    links,
    autoMerge,
  } = data;
  const timeline = visibleTimeline(timelineEvents);

  const canConfirm = spec.state === "draft" && tickets.length > 0;
  const prechecks =
    spec.prechecks ??
    spec.warnings.flatMap((warning) => {
      const message =
        (warning as { message?: string }).message ?? JSON.stringify(warning);
      return message
        ? [{ code: "import-warning", level: "yellow" as const, message }]
        : [];
    });
  const progress = ticketProgress(tickets);
  const step = currentFlowStep(spec.state, {
    pullRequests: pullRequests.length,
    finalizing: finalizations.length > 0,
    started: tickets.some(
      (ticket) => ticket.state !== "pending" && ticket.state !== "cancelled",
    ),
    confirmed: timelineEvents.some((event) => event.kind === "confirm-plan"),
  });
  const stepIndex = flowStepIndex(step);
  const complete = flowStepComplete(spec.state);
  const locationStep = flowStepLocation(section, hash, step);
  const banner = flowBanner(spec.state, spec.pauseReason);
  const blocked = tickets.filter((t) => t.state === "blocked");
  const repos = spec.repos ?? [];
  const hostKind = hostKindOfRepos(repos);
  const pullWord = pullAbbrev(hostKind);
  const confirmAt = timelineEvents.find(
    (event) => event.kind === "confirm-plan",
  )?.at;
  const lastFinal = finalizations.at(-1);
  const captionFacts = {
    ticketDone: progress.done,
    ticketTotal: progress.total,
    blocked: blocked.length,
    planningSha: Boolean(spec.planningSha),
    confirmAt: confirmAt ? formatShanghaiTime(confirmAt) : undefined,
    finalStep: lastFinal ? `${lastFinal.repo} ${lastFinal.step}` : null,
    prSummary:
      pullRequests.length > 0
        ? pullRequests
            .map(
              (pr) =>
                `#${pr.number}${pr.draft ? " 草稿" : ""}${pr.ci === "failure" ? " CI 失败" : ""}`,
            )
            .join(" · ")
        : null,
    pack: Boolean(acceptancePack),
    orderBroken: list(orderBroken).length > 0,
  };

  return (
    <Page
      title={
        <span className="flex flex-wrap items-center gap-3">
          <IdChip id={spec.id} displayId={spec.displayId} />
          <span>{spec.title}</span>
          <StatusBadge kind="spec" code={spec.state} />
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-3">
          <Mono title={specTypeLabel[spec.type]}>{spec.type}</Mono>
          <span>{specTypeLabel[spec.type]}</span>
          {repos.map((repo) => (
            <RepoTag key={repo.name} name={repo.name} url={repo.url} />
          ))}
        </span>
      }
    >
      <nav aria-label="全部需求" className="mb-5 text-xs text-muted-foreground">
        <a href={paths.specs} className="hover:text-primary">
          ← 全部需求
        </a>
      </nav>
      <StaleNotice error={view.error} />
      {spec.tokenMerged ? (
        <p className="error mb-5" data-testid="token-merged">
          平台账号合并了 {pullWord}。只有人能合并。
        </p>
      ) : null}
      {banner ? (
        <div
          role="status"
          data-testid="spec-banner"
          className="mb-5 flex flex-wrap items-center gap-2 border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-sm"
        >
          <AlertTriangle className="size-4 text-destructive" />
          <strong>
            {banner.title}
            {banner.reason ? `: ${banner.reason}` : ""}
          </strong>
          {banner.kind === "paused" ? (
            <a href={paths.waiting} className="ml-auto text-primary underline">
              前往待处理
            </a>
          ) : null}
        </div>
      ) : null}

      <ol
        aria-label="需求流程"
        className="mb-5 flex items-start border-b pb-5"
        data-testid="flow-bar"
      >
        <span className="sr-only">
          {FLOW_STEPS.map((step) => flowStepLabel(step, hostKind)).join(" → ")}{" "}
          · 票 {progress.done}/{progress.total}
        </span>
        {FLOW_STEPS.map((name, index) => {
          const current = !complete && index === stepIndex;
          const done = complete || index < stepIndex;
          const reached = flowStepReached(index, stepIndex, complete);
          const here = locationStep === name;
          const caption = flowStepCaption(name, captionFacts);
          const showCaption = (complete || index <= stepIndex) && caption;
          const body = (
            <>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span
                  className={cn(
                    "grid size-6 place-items-center rounded-full border font-mono text-[11px]",
                    current
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-primary/40"
                        : "border-border-strong",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : index + 1}
                </span>
                {flowStepLabel(name, hostKind)}
              </span>
              {showCaption ? (
                <span
                  data-testid={`flow-caption-${name}`}
                  className="pl-8 text-[10px] font-normal text-muted-foreground"
                >
                  {caption}
                </span>
              ) : null}
            </>
          );
          return (
            <li
              key={name}
              aria-current={here ? "location" : current ? "step" : undefined}
              data-current={current ? "true" : undefined}
              data-here={here ? "true" : undefined}
              data-complete={done}
              className="flex min-w-0 flex-1 items-start gap-2 last:flex-none"
            >
              {reached ? (
                <a
                  href={flowStepHref(name, specId)}
                  className={cn(
                    "flex min-w-0 flex-col gap-1 border-b-2 text-xs outline-none hover:text-foreground focus-visible:border-primary",
                    here ? "border-primary" : "border-transparent",
                    current ? "font-semibold text-primary" : "text-primary",
                  )}
                >
                  {body}
                </a>
              ) : (
                <span className="flex min-w-0 flex-col gap-1 border-b-2 border-transparent text-xs text-muted-foreground">
                  {body}
                </span>
              )}
              {index < FLOW_STEPS.length - 1 ? (
                <span className="mx-1 mt-3 h-px min-w-2 flex-1 bg-border" />
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="mb-6 flex flex-wrap items-center gap-4 text-xs">
        <span>
          票进度{" "}
          <Mono>
            {progress.done}/{progress.total}
          </Mono>
        </span>
        <SegmentedProgress
          progress={{
            total: tickets.length,
            done: tickets.filter((t) => t.state === "done").length,
            active: tickets.filter(
              (t) =>
                t.state === "running" ||
                t.state === "queued" ||
                t.state === "merging",
            ).length,
            blocked: tickets.filter((t) => t.state === "blocked").length,
            pending: tickets.filter((t) => t.state === "pending").length,
            cancelled: tickets.filter((t) => t.state === "cancelled").length,
          }}
          className="max-w-60 flex-1"
        />
      </div>

      <nav
        aria-label="需求页"
        className="spec-sections mb-5 flex gap-1 overflow-x-auto border-b pb-2"
      >
        {SECTIONS.filter(
          (item) => !item.needsPulls || pullRequests.length > 0,
        ).map((item) => (
          <a
            key={item.id}
            href={item.href(specId)}
            aria-current={section === item.id ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-[12px] transition-colors hover:bg-accent/60 hover:text-foreground",
              section === item.id
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {section === "overview" ? (
        <Overview
          spec={spec}
          tickets={tickets}
          edges={edges}
          blocked={blocked}
          prechecks={prechecks}
          canConfirm={canConfirm}
          confirming={confirm.isPending}
          confirmError={confirm.isError ? confirm.error.message : null}
          onConfirm={() => confirm.mutate()}
          onLeavePlanningChanges={() => confirm.mutate(true)}
          onOpen={setOpenTicket}
          pullRequests={pullRequests}
          timeline={timeline}
          currentStep={step}
          hostKind={hostKind}
          potentialConflicts={potentialConflicts ?? []}
          leadTime={leadTime ?? null}
          usageByStage={usageByStage ?? []}
          links={links ?? []}
        />
      ) : null}
      {section === "description" ? (
        spec.body.trim() === "" ? (
          <p className="note" data-testid="empty-body">
            这份需求没有正文
          </p>
        ) : (
          <SpecBody source={spec.body} />
        )
      ) : null}
      {section === "tickets" ? (
        <TicketsPage
          tickets={tickets}
          edges={edges}
          repos={repos}
          onOpen={setOpenTicket}
        />
      ) : null}
      {section === "delivery" ? (
        <Delivery
          specId={specId}
          pullRequests={pullRequests}
          orderBroken={orderBroken}
          mergeOrder={mergeOrder}
          acceptancePack={acceptancePack}
          finalizations={finalizations}
          finalRuns={finalRuns}
          repos={spec.repos ?? []}
          hostKind={hostKind}
          autoMerge={autoMerge}
          specState={spec.state}
        />
      ) : null}
      {section === "review" ? <ReviewPage specId={specId} /> : null}
      {section === "timeline" ? (
        <TimelinePage
          events={timeline}
          tickets={tickets.map((ticket) => ({
            id: ticket.id,
            displayId: ticket.displayId,
            title: ticket.title,
          }))}
          pullRequests={pullRequests}
          hostKind={hostKind}
          legacy={Boolean(timelineLegacy)}
        />
      ) : null}
      <TicketSheet
        ticketId={openTicket}
        onClose={() => setOpenTicket(null)}
        onOpenTicket={setOpenTicket}
      />
    </Page>
  );
}
