import { HOST_KIND_LABELS, type HostKind, type TicketState } from "@afk/shared";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import {
  IdChip,
  Mono,
  RepoTag,
  ShaChip,
  ticketBorderClass,
} from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { SegmentedProgress } from "./components/afk/progress-bar.tsx";
import {
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { FinalizeProgress, UpdateBranchRuns } from "./FinalizeProgress.tsx";
import { layoutGraph, STATE_COLORS } from "./graph.ts";
import { hostKindOf, hostKindOfRepos, pullAbbrev } from "./host-copy.ts";
import { commitHtmlUrl, treeHtmlUrl } from "./host-links.ts";
import {
  edgeKindLabel,
  prCiLabel,
  prReviewLabel,
  specTypeLabel,
} from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { SpecBody } from "./Markdown.tsx";
import { specExcerpt } from "./markdown-body.ts";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
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
import {
  TIMELINE_LABELS,
  timelineLabel,
  visibleTimeline,
} from "./spec-timeline.ts";
import { blockedReasonLabel, ticketStateLabel } from "./status.ts";
import { peekTicketClick, TicketSheet } from "./TicketDetail.tsx";
import { formatShanghaiDay, formatShanghaiTime } from "./time.ts";

const list = <T,>(value: T[] | undefined | null): T[] =>
  Array.isArray(value) ? value : [];

// One spec: the dependency graph with a node per ticket coloured by its state, the yellow prechecks before
// confirm, and the button that confirms the split so that the platform starts working on it.

interface TicketNodeData extends Record<string, unknown> {
  id: number;
  displayId: string;
  title: string;
  repo: string;
  appended: boolean;
  state: TicketState;
  blockedReason: string | null;
  onOpen?: (id: number) => void;
}

function TicketNode({ data }: NodeProps<Node<TicketNodeData>>) {
  return (
    // React Flow nodes are divs; the inner link is the keyboard target.
    // biome-ignore lint/a11y/noStaticElementInteractions: node click opens the sheet
    // biome-ignore lint/a11y/useKeyWithClickEvents: inner ticket link is keyboard-accessible
    <div
      className={cn(
        "afk-ticket-node w-[190px] rounded-md border border-l-4 bg-card px-2 py-1.5 text-xs",
        ticketBorderClass(data.state),
      )}
      style={{ borderColor: STATE_COLORS[data.state].border }}
      data-testid={`node-${data.displayId}`}
      data-state={data.state}
      onClick={(event) => {
        if (data.onOpen) peekTicketClick(event, data.id, data.onOpen);
      }}
    >
      <Handle type="target" position={Position.Left} />
      <a
        href={paths.ticket(data.id)}
        onClick={(event) => {
          if (data.onOpen) peekTicketClick(event, data.id, data.onOpen);
        }}
      >
        <strong>{data.displayId}</strong>
      </a>{" "}
      {data.title}
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {data.repo}
        {data.appended ? " · 追加" : ""}
      </div>
      <div className="mt-1">
        <span title={data.state}>{ticketStateLabel(data.state)}</span>
        {data.blockedReason ? (
          <span title={data.blockedReason}>
            {" "}
            ({blockedReasonLabel(data.blockedReason)})
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { ticket: TicketNode };
const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

function useSpecView(specId: number) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  return useQuery({
    queryKey: ["spec", specId],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

type SpecView = NonNullable<ReturnType<typeof useSpecView>["data"]>;

// The nodes and edges only change when the spec does, not on every poll that finds nothing new.
function DependencyGraph({
  tickets,
  edges,
  onOpen,
  className,
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  onOpen?: (id: number) => void;
  className?: string;
}) {
  const { nodes, flowEdges } = useMemo(() => {
    const positions = new Map(
      layoutGraph(tickets, edges).map((p) => [p.id, p]),
    );
    const nodes: Node<TicketNodeData>[] = tickets.map((ticket) => ({
      id: ticket.displayId,
      type: "ticket",
      position: {
        x: positions.get(ticket.displayId)?.x ?? 0,
        y: positions.get(ticket.displayId)?.y ?? 0,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        id: ticket.id,
        displayId: ticket.displayId,
        title: ticket.title,
        repo: ticket.repo,
        appended: ticket.appended,
        state: ticket.state,
        blockedReason: ticket.blockedReason,
        onOpen,
      },
    }));
    const flowEdges: Edge[] = edges.map((edge) => ({
      id: `${edge.from}-${edge.to}-${edge.kind}`,
      source: edge.from,
      target: edge.to,
      animated: false,
      // a contract edge is drawn dashed: it waits for a recorded contract SHA, not only for the ticket
      style: edge.kind === "contract" ? { strokeDasharray: "6 4" } : undefined,
      label: edge.kind === "contract" ? "contract" : undefined,
    }));
    return { nodes, flowEdges };
  }, [tickets, edges, onOpen]);
  return (
    <figure
      className={cn(
        "afk-graph graph h-[420px] rounded-md border bg-surface",
        className,
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={
          onOpen
            ? (event, node) =>
                peekTicketClick(event, (node.data as TicketNodeData).id, onOpen)
            : undefined
        }
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </figure>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

type PackRepo = NonNullable<SpecView["acceptancePack"]>["repos"][number];

function PackRepoSection({
  repo,
  repoUrl,
}: {
  repo: PackRepo;
  repoUrl?: string | null;
}) {
  return (
    <section
      className="pack-repo mt-3 rounded-md border bg-card p-4"
      data-testid={`pack-repo-${repo.repo}`}
    >
      <h3 className="mb-3 text-sm font-semibold">{repo.repo}</h3>
      <h4 className="text-xs font-medium text-muted-foreground">验收标准</h4>
      {list(repo.tickets).map((ticket) => (
        <div key={ticket.displayId} className="mt-2">
          <p>
            <strong>{ticket.displayId}</strong> {ticket.title}
            {ticket.appended ? (
              <span className="badge appended"> 追加</span>
            ) : null}
          </p>
          <ul className="criteria mt-1 space-y-2">
            {list(ticket.criteria).map((criterion) => (
              <li key={criterion.text} data-status={criterion.status}>
                <span className={`badge criterion-${criterion.status}`}>
                  {criterion.status}
                </span>{" "}
                {criterion.text}
                {criterion.reason ? (
                  <span className="note"> — {criterion.reason}</span>
                ) : null}
                {list(criterion.tests).length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {list(criterion.tests).map((test) => (
                      <li key={test}>{test}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {list(repo.findings).length > 0 ? (
        <ul className="pack-findings">
          {list(repo.findings).map((finding) => (
            <li key={`${finding.run}-${finding.kind}-${finding.body}`}>
              <span className="badge">{finding.resolution}</span>{" "}
              {finding.axis ? (
                <span className={`badge axis-${finding.axis}`}>
                  {finding.axis}
                </span>
              ) : null}{" "}
              {finding.ticket ?? "spec"} {finding.stage} {finding.kind}:{" "}
              {finding.body}
            </li>
          ))}
        </ul>
      ) : null}
      {list(repo.scopeCreep).length > 0 ? (
        <>
          <p className="note">范围蔓延：票没要求的改动</p>
          <ul className="scope-creep">
            {list(repo.scopeCreep).map((item) => (
              <li key={`${item.run}-${item.body}`}>
                {item.ticket ?? "spec"} {item.run}: {item.body}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {list(repo.uncertainties).length > 0 ? (
        <>
          <p className="note">模型不确定的地方：</p>
          <ul className="uncertainties">
            {list(repo.uncertainties).map((u) => (
              <li key={`${u.source}-${u.text}`}>
                {u.source}: {u.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {repo.gate ? (
        <p className="gates">
          门禁：{" "}
          <ShaChip
            sha={repo.gate.commitSha}
            href={repoUrl ? commitHtmlUrl(repoUrl, repo.gate.commitSha) : null}
          />
          : {repo.gate.testsTotal ?? "?"} 个测试，跳过{" "}
          {repo.gate.testsSkipped ?? "?"} 个，{seconds(repo.gate.durationMs)} (
          {list(repo.gate.steps)
            .map(
              (step) =>
                `${step.name} ${seconds(step.ms)}${step.exitCode === 0 ? "" : ` exit ${step.exitCode}`}`,
            )
            .join(", ")}
          )
        </p>
      ) : null}
      {list(repo.protectedPathApprovals).length > 0 ? (
        <ul className="approvals">
          {list(repo.protectedPathApprovals).map((approval) => (
            <li key={approval.ticket}>
              已批准的保护路径，{approval.ticket}： {approval.paths.join(", ")}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// Merge order, cancelled tickets, agent time: the bits that are not per-repo.
function AcceptancePackMeta({
  pack,
}: {
  pack: NonNullable<SpecView["acceptancePack"]>;
}) {
  return (
    <>
      {list(pack.orderBroken).map((b) => (
        <p key={b.repo} className="error">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      <p className="note" data-testid="pack-merge-order">
        {list(pack.mergeOrder?.ordered).length > 0
          ? `合并顺序：${list(pack.mergeOrder?.ordered).join(" → ")}${
              list(pack.mergeOrder?.unordered).length > 0
                ? `（没有顺序：${list(pack.mergeOrder?.unordered).join("、")}）`
                : ""
            }`
          : "没有合并顺序：这些仓库没有契约关系。"}
      </p>

      {list(pack.cancelledTickets).length > 0 ? (
        <>
          <h4>已取消的票</h4>
          <ul className="cancelled-tickets">
            {list(pack.cancelledTickets).map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title} [
                {ticket.repo}] <span className="badge">已取消</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pack.agentSeconds != null ? (
        <p className="note">Agent 耗时：{pack.agentSeconds} s。</p>
      ) : null}
      {pack.integration ? (
        <section className="mt-4" data-testid="pack-integration">
          <h4>联调</h4>
          {pack.integration.failedBeforePullRequest ? (
            <p className="error">
              开 {pullAbbrev(hostKindOf(pack))} 前联调失败
            </p>
          ) : null}
          <ul>
            {list(pack.integration.tickets).map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title}
                {ticket.result ? ` · ${ticket.result}` : ""}
                {ticket.testsTotal != null
                  ? ` · ${ticket.testsTotal} 个测试，失败 ${ticket.testsFailed ?? 0} 个`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export type SpecSection =
  | "overview"
  | "description"
  | "tickets"
  | "delivery"
  | "timeline";

const SECTIONS: {
  id: SpecSection;
  label: string;
  href: (id: number) => string;
}[] = [
  { id: "overview", label: "概览", href: paths.spec },
  { id: "description", label: "需求说明", href: paths.specDescription },
  { id: "tickets", label: "票与依赖", href: paths.specTickets },
  { id: "delivery", label: "交付", href: paths.specDelivery },
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
    mutationFn: async () => {
      const { data, error } = await api.POST("/specs/{specId}/confirm", {
        params: { path: { specId } },
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
    finalRuns,
    potentialConflicts,
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
        className="spec-sections mb-6 flex gap-5 overflow-x-auto border-b"
      >
        {SECTIONS.map((item) => (
          <a
            key={item.id}
            href={item.href(specId)}
            aria-current={section === item.id ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-1 py-3 text-[13px] hover:text-foreground",
              section === item.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground",
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
          onOpen={setOpenTicket}
          pullRequests={pullRequests}
          timeline={timeline}
          currentStep={step}
          hostKind={hostKind}
          potentialConflicts={potentialConflicts ?? []}
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
          pullRequests={pullRequests}
          orderBroken={orderBroken}
          mergeOrder={mergeOrder}
          acceptancePack={acceptancePack}
          finalizations={finalizations}
          finalRuns={finalRuns}
          repos={spec.repos ?? []}
          hostKind={hostKind}
        />
      ) : null}
      {section === "timeline" ? (
        <TimelinePage
          events={timeline}
          pullRequests={pullRequests}
          hostKind={hostKind}
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

function Overview({
  spec,
  tickets,
  edges,
  blocked,
  prechecks,
  canConfirm,
  confirming,
  confirmError,
  onConfirm,
  onOpen,
  pullRequests,
  timeline,
  currentStep,
  hostKind,
  potentialConflicts,
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
  onOpen: (id: number) => void;
  pullRequests: SpecView["pullRequests"];
  timeline: SpecView["timeline"];
  currentStep: string;
  hostKind: HostKind;
  potentialConflicts: NonNullable<SpecView["potentialConflicts"]>;
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
  return (
    <>
      {draft ? (
        <div
          id="flow-confirm"
          className="confirm mb-5 flex scroll-mt-6 flex-wrap items-center gap-3"
        >
          <Button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm || confirming}
          >
            {confirming ? "确认中…" : "确认拆分"}
          </Button>
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

function TicketsPage({
  tickets,
  edges,
  repos,
  onOpen,
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  repos: NonNullable<SpecView["spec"]["repos"]>;
  onOpen: (id: number) => void;
}) {
  const [repo, setRepo] = useState("all");
  const [state, setState] = useState("all");
  const repoNames = [...new Set(tickets.map((t) => t.repo))];
  const repoUrl = new Map(repos.map((item) => [item.name, item.url]));
  const idByDisplay = new Map(
    tickets.map((ticket) => [ticket.displayId, ticket.id]),
  );
  const shown = tickets.filter(
    (t) =>
      (repo === "all" || t.repo === repo) &&
      (state === "all" || t.state === state),
  );
  const waitsFor = (displayId: string) =>
    edges.filter((e) => e.to === displayId);
  return (
    <>
      {tickets.length === 0 ? (
        <p className="note">还没有导入票。</p>
      ) : (
        <>
          <h3 className="mb-3 text-sm font-semibold">依赖图</h3>
          <DependencyGraph
            tickets={tickets}
            edges={edges}
            onOpen={onOpen}
            className="h-[480px]"
          />
        </>
      )}
      <div className="mt-6 mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-2 text-sm font-semibold">票</h3>
        <Select value={repo} onValueChange={setRepo}>
          <SelectTrigger
            className="h-7 w-auto gap-1.5 text-[12px]"
            aria-label="按仓库筛选"
          >
            <SelectValue placeholder="仓库" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部仓库</SelectItem>
            {repoNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={setState}>
          <SelectTrigger
            className="h-7 w-auto gap-1.5 text-[12px]"
            aria-label="按状态筛选"
          >
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {(
              [
                "pending",
                "queued",
                "running",
                "merging",
                "done",
                "blocked",
                "cancelled",
              ] as const
            ).map((value) => (
              <SelectItem key={value} value={value}>
                {ticketStateLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="space-y-2" data-testid="ticket-cards">
        {shown.map((ticket) => {
          const waits = waitsFor(ticket.displayId);
          return (
            <li
              key={ticket.id}
              className="rounded-md border bg-card px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="ticket" code={ticket.state} />
                <a
                  href={paths.ticket(ticket.id)}
                  className="font-mono text-sm hover:underline"
                  onClick={(event) => peekTicketClick(event, ticket.id, onOpen)}
                >
                  {ticket.displayId}
                </a>
                <span className="min-w-0 truncate text-sm">{ticket.title}</span>
                <RepoTag name={ticket.repo} url={repoUrl.get(ticket.repo)} />
                {ticket.appended ? (
                  <span className="badge appended">追加</span>
                ) : null}
                {ticket.blockedReason ? (
                  <StatusBadge kind="blocked" code={ticket.blockedReason} />
                ) : null}
              </div>
              {waits.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {waits.map((edge, index) => {
                    const targetId = idByDisplay.get(edge.from);
                    const kind = edgeKindLabel[edge.kind] ?? edge.kind;
                    return (
                      <span key={`${edge.from}-${edge.kind}`}>
                        {index > 0 ? " · " : null}
                        {kind}{" "}
                        {targetId ? (
                          <a
                            href={paths.ticket(targetId)}
                            className="font-mono text-primary hover:underline"
                            onClick={(event) =>
                              peekTicketClick(event, targetId, onOpen)
                            }
                          >
                            {edge.from}
                          </a>
                        ) : (
                          <span className="font-mono">{edge.from}</span>
                        )}
                      </span>
                    );
                  })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function TimelinePage({
  events,
  pullRequests,
  hostKind,
}: {
  events: { kind: string; at?: string; text?: string; runId?: number }[];
  pullRequests: SpecView["pullRequests"];
  hostKind: HostKind;
}) {
  if (events.length === 0) return <p className="note">还没有时间线事件</p>;
  const days = new Map<string, typeof events>();
  for (const event of events) {
    const day = event.at ? formatShanghaiDay(event.at) : "未知日期";
    const bucket = days.get(day) ?? [];
    bucket.push(event);
    days.set(day, bucket);
  }
  const prHref = (text?: string) => {
    if (!text) return null;
    const prs = list(pullRequests);
    const match = prs.find(
      (pr) => text.includes(`#${pr.number}`) || text.includes(pr.repo),
    );
    return match?.url ?? prs[0]?.url ?? null;
  };
  return (
    <div className="timeline">
      {[...days.entries()].map(([day, items]) => (
        <section key={day} className="timeline-day">
          <h3 className="timeline-day-label">{day}</h3>
          <ol className="timeline-rail">
            {items.map((event) => {
              const label =
                event.kind in TIMELINE_LABELS
                  ? timelineLabel(
                      event.kind as keyof typeof TIMELINE_LABELS,
                      hostKind,
                    )
                  : event.kind;
              const host =
                event.kind === "pr-opened" ||
                event.kind === "pr-ready" ||
                event.kind === "merged"
                  ? prHref(event.text)
                  : null;
              return (
                <li
                  key={`${event.kind}-${event.at}-${event.text}-${event.runId ?? ""}`}
                  className="timeline-item"
                >
                  <span className="timeline-dot" aria-hidden="true" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="timeline-kind">{label}</span>
                    {event.at ? <RelativeTime iso={event.at} /> : null}
                  </div>
                  {event.text && event.text !== label ? (
                    <div className="mt-1 text-sm text-muted-foreground">
                      {event.text}
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-3 text-xs">
                    {event.runId ? (
                      <a
                        href={paths.run(event.runId)}
                        className="text-primary hover:underline"
                      >
                        R-{event.runId}
                      </a>
                    ) : null}
                    {host ? (
                      <a
                        href={host}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {HOST_KIND_LABELS[hostKind]}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// The "交付" tab: finalizations, pull requests, then the acceptance pack as its own chapter.
function Delivery({
  pullRequests,
  orderBroken,
  mergeOrder,
  acceptancePack,
  finalizations,
  finalRuns,
  repos: specRepos,
  hostKind,
}: Pick<
  SpecView,
  | "pullRequests"
  | "orderBroken"
  | "mergeOrder"
  | "acceptancePack"
  | "finalizations"
  | "finalRuns"
> & {
  repos: NonNullable<SpecView["spec"]["repos"]>;
  hostKind: HostKind;
}) {
  const repoUrls = new Map(
    list(specRepos).map((repo) => [repo.name, repo.url]),
  );
  const prs = list(pullRequests);
  const steps = list(finalizations);
  const runs = list(finalRuns);
  const updateRuns = runs.filter((run) => run.stage === "update-branch");
  const finishRuns = runs.filter((run) => run.stage !== "update-branch");
  const hasFinalize = steps.length > 0 || finishRuns.length > 0;
  const hasUpdate = updateRuns.length > 0;
  const hasPrs = prs.length > 0;
  const nothing = !hasFinalize && !hasUpdate && !hasPrs && !acceptancePack;
  const prRepos = [
    ...list(mergeOrder?.ordered),
    ...prs.map((pr) => pr.repo),
  ].filter((name, index, all) => all.indexOf(name) === index);

  return (
    <>
      {nothing ? <p className="note">还没有可交付的内容</p> : null}
      {list(orderBroken).map((b) => (
        <p key={b.repo} className="error" data-testid="order-broken">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      {hasUpdate ? (
        <section id="delivery-update-branch" className="mb-8 scroll-mt-6">
          <h2 className="mb-3 text-sm font-semibold">合 main</h2>
          <UpdateBranchRuns runs={updateRuns} />
        </section>
      ) : null}
      {hasFinalize ? (
        <section id="delivery-finalize" className="mb-8 scroll-mt-6">
          <h2 className="mb-3 text-sm font-semibold">收尾</h2>
          <FinalizeProgress steps={steps} runs={finishRuns} />
        </section>
      ) : null}
      {hasPrs ? (
        <section id="delivery-prs" className="mb-8 scroll-mt-6">
          <h2 className="mb-1 text-sm font-semibold">{pullAbbrev(hostKind)}</h2>
          <p className="note mb-3">
            按这个顺序合并；平台从不合入。
            {list(mergeOrder?.ordered).length > 0
              ? ` 合并顺序：${list(mergeOrder?.ordered).join(" → ")}`
              : " 没有合并顺序（没有契约关系）。"}
            {list(mergeOrder?.unordered).length > 0
              ? ` 没有顺序：${list(mergeOrder?.unordered).join("、")}`
              : ""}
          </p>
          {prRepos.map((repo) => {
            const pr = prs.find((item) => item.repo === repo);
            if (!pr) return null;
            return (
              <div key={repo} className="mb-3 rounded-md border bg-card p-4">
                <h3 className="mb-2 text-sm font-medium">{repo}</h3>
                <ul className="pull-requests">
                  <li>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      {pr.repo} #{pr.number}
                      <ExternalLink className="ml-1 inline size-3" />
                    </a>{" "}
                    <StatusBadge kind="pr" code={pr.state} />
                    {pr.draft ? " (草稿)" : ""}{" "}
                    {list(pr.waitsFor).length > 0 ? (
                      <span className="note">
                        排在 {list(pr.waitsFor).join("、")} 后面
                        {" · "}
                      </span>
                    ) : null}
                    {prCiLabel[pr.ci] ?? pr.ci}，
                    {prReviewLabel[pr.review] ?? pr.review}
                    {pr.syncError ? (
                      <span className="error"> 读取失败：{pr.syncError}</span>
                    ) : null}
                  </li>
                </ul>
              </div>
            );
          })}
        </section>
      ) : null}
      <section id="delivery-pack" className="mb-4 scroll-mt-6">
        <h2 className="mb-3 text-sm font-semibold">验收包</h2>
        {acceptancePack ? (
          <>
            <AcceptancePackMeta pack={acceptancePack} />
            {list(acceptancePack.repos).map((item) => (
              <PackRepoSection
                key={item.repo}
                repo={item}
                repoUrl={repoUrls.get(item.repo)}
              />
            ))}
          </>
        ) : (
          <p className="note">
            还没有验收包。开完 {pullAbbrev(hostKind)} 后会生成。
          </p>
        )}
      </section>
    </>
  );
}
