import type { TicketState } from "@afk/shared";
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
import { AlertTriangle, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { IdChip, Mono, ticketBorderClass } from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import { SegmentedProgress } from "./components/afk/progress-bar.tsx";
import {
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./components/ui/sheet.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { layoutGraph, STATE_COLORS } from "./graph.ts";
import { prCiLabel, prReviewLabel, specTypeLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { Markdown } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { Sha } from "./Sha.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import {
  currentFlowStep,
  FLOW_STEPS,
  flowBanner,
  flowStepComplete,
  flowStepIndex,
  ticketProgress,
} from "./spec-flow.ts";
import { TIMELINE_LABELS, visibleTimeline } from "./spec-timeline.ts";
import { blockedReasonLabel, ticketStateLabel } from "./status.ts";

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
      onClick={() => data.onOpen?.(data.id)}
    >
      <Handle type="target" position={Position.Left} />
      <a
        href={paths.ticket(data.id)}
        onClick={(event) => {
          event.preventDefault();
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
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  onOpen?: (id: number) => void;
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
    <figure className="afk-graph graph h-[420px] rounded-md border bg-surface">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={
          onOpen
            ? (_, node) => onOpen((node.data as TicketNodeData).id)
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

function PackRepoSection({ repo }: { repo: PackRepo }) {
  return (
    <section className="pack-repo" data-testid={`pack-repo-${repo.repo}`}>
      <h4>验收标准</h4>
      {repo.tickets.map((ticket) => (
        <div key={ticket.displayId}>
          <p>
            <strong>{ticket.displayId}</strong> {ticket.title}
            {ticket.appended ? (
              <span className="badge appended"> 追加</span>
            ) : null}
          </p>
          <ul className="criteria">
            {ticket.criteria.map((criterion) => (
              <li key={criterion.text} data-status={criterion.status}>
                <span className={`badge criterion-${criterion.status}`}>
                  {criterion.status}
                </span>{" "}
                {criterion.text}
                {criterion.tests.length > 0
                  ? ` (${criterion.tests.join(", ")})`
                  : ""}
                {criterion.reason ? (
                  <span className="note"> — {criterion.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {repo.findings.length > 0 ? (
        <ul className="pack-findings">
          {repo.findings.map((finding) => (
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
      {repo.scopeCreep.length > 0 ? (
        <>
          <p className="note">范围蔓延：票没要求的改动</p>
          <ul className="scope-creep">
            {repo.scopeCreep.map((item) => (
              <li key={`${item.run}-${item.body}`}>
                {item.ticket ?? "spec"} {item.run}: {item.body}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {repo.uncertainties.length > 0 ? (
        <>
          <p className="note">模型不确定的地方：</p>
          <ul className="uncertainties">
            {repo.uncertainties.map((u) => (
              <li key={`${u.source}-${u.text}`}>
                {u.source}: {u.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {repo.gate ? (
        <p className="gates">
          门禁： <Sha value={repo.gate.commitSha} />:{" "}
          {repo.gate.testsTotal ?? "?"} 个测试，跳过{" "}
          {repo.gate.testsSkipped ?? "?"} 个，{seconds(repo.gate.durationMs)} (
          {repo.gate.steps
            .map(
              (step) =>
                `${step.name} ${seconds(step.ms)}${step.exitCode === 0 ? "" : ` exit ${step.exitCode}`}`,
            )
            .join(", ")}
          )
        </p>
      ) : null}
      {repo.protectedPathApprovals.length > 0 ? (
        <ul className="approvals">
          {repo.protectedPathApprovals.map((approval) => (
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
function AcceptancePackSection({
  pack,
}: {
  pack: NonNullable<SpecView["acceptancePack"]>;
}) {
  return (
    <section className="acceptance-pack">
      <h3>验收包</h3>
      {pack.orderBroken.map((b) => (
        <p key={b.repo} className="error">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      <p className="note" data-testid="pack-merge-order">
        {pack.mergeOrder.ordered.length > 0
          ? `合并顺序：${pack.mergeOrder.ordered.join(" → ")}${
              pack.mergeOrder.unordered.length > 0
                ? `（没有顺序：${pack.mergeOrder.unordered.join("、")}）`
                : ""
            }`
          : "没有合并顺序：这些仓库没有契约关系。"}
      </p>

      {pack.cancelledTickets.length > 0 ? (
        <>
          <h4>已取消的票</h4>
          <ul className="cancelled-tickets">
            {pack.cancelledTickets.map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title} [
                {ticket.repo}] <span className="badge">已取消</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="note">Agent 耗时：{pack.agentSeconds} s。</p>
    </section>
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
}: {
  specId: number;
  section?: SpecSection;
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
  const banner = flowBanner(spec.state, spec.pauseReason);
  const blocked = tickets.filter((t) => t.state === "blocked");

  const opened = tickets.find((t) => t.id === openTicket);

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
        <span className="flex items-center gap-3">
          <Mono title={specTypeLabel[spec.type]}>{spec.type}</Mono>
          <span>{specTypeLabel[spec.type]}</span>
          {"project" in spec && typeof spec.project === "string" ? (
            <span>
              项目 <Mono>{spec.project}</Mono>
            </span>
          ) : null}
        </span>
      }
    >
      <nav aria-label="全部需求" className="mb-5 text-xs text-muted-foreground">
        <a href={paths.specs} className="hover:text-primary">
          ← 全部需求
        </a>
      </nav>
      <StaleNotice error={view.error} />
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
        className="mb-5 flex items-center border-b pb-5"
        data-testid="flow-bar"
      >
        <span className="sr-only">
          {FLOW_STEPS.join(" → ")} · 票 {progress.done}/{progress.total}
        </span>
        {FLOW_STEPS.map((name, index) => {
          const current = !complete && index === stepIndex;
          const done = complete || index < stepIndex;
          return (
            <li
              key={name}
              aria-current={current ? "step" : undefined}
              data-current={current ? "true" : undefined}
              data-complete={done}
              className="flex min-w-0 flex-1 items-center gap-2 last:flex-none"
            >
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2 text-xs",
                  current
                    ? "font-semibold text-primary"
                    : done
                      ? "text-primary"
                      : "text-muted-foreground",
                )}
              >
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
                {name}
              </div>
              {index < FLOW_STEPS.length - 1 ? (
                <span className="mx-1 h-px min-w-2 flex-1 bg-border" />
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
        />
      ) : null}
      {section === "description" ? (
        spec.body.trim() === "" ? (
          <p className="note" data-testid="empty-body">
            这份需求没有正文
          </p>
        ) : (
          <Markdown source={spec.body} contents />
        )
      ) : null}
      {section === "tickets" ? (
        <TicketsPage tickets={tickets} edges={edges} onOpen={setOpenTicket} />
      ) : null}
      {section === "delivery" ? (
        <Delivery
          pullRequests={pullRequests}
          orderBroken={orderBroken}
          mergeOrder={mergeOrder}
          acceptancePack={acceptancePack}
          finalizations={finalizations}
          finalRuns={finalRuns}
        />
      ) : null}
      {section === "timeline" ? <TimelinePage events={timeline} /> : null}
      <Sheet
        open={openTicket !== null}
        onOpenChange={(open) => {
          if (!open) setOpenTicket(null);
        }}
      >
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex flex-wrap items-center gap-2">
              {opened ? (
                <IdChip id={opened.id} displayId={opened.displayId} />
              ) : null}
              {opened?.title ?? "票摘要"}
            </SheetTitle>
            <SheetDescription>票摘要</SheetDescription>
          </SheetHeader>
          {opened ? (
            <div className="space-y-4 text-[13px]">
              <div className="flex flex-wrap gap-2">
                <StatusBadge kind="ticket" code={opened.state} />
                <Mono>{opened.repo}</Mono>
              </div>
              <Button asChild className="w-full">
                <a href={paths.ticket(opened.id)}>打开票详情</a>
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
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
}) {
  const progress = ticketProgress(tickets);
  return (
    <>
      {spec.state === "draft" ? (
        <div className="confirm mb-5 flex flex-wrap items-center gap-3">
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

      <p className="note" data-testid="spec-stats">
        票 {progress.done}/{progress.total}
        {blocked.length > 0 ? ` · 卡住 ${blocked.length}` : ""}
      </p>

      {blocked.length > 0 ? (
        <>
          <h3>卡住的票</h3>
          <ul className="tickets">
            {blocked.map((ticket) => (
              <li key={ticket.id}>
                <StatusBadge kind="ticket" code={ticket.state} />{" "}
                <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
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

      <h3>确认前预检</h3>
      {prechecks.length === 0 ? (
        <p className="note">没有黄项</p>
      ) : (
        <ul className="warnings" data-testid="prechecks">
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
  onOpen,
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  onOpen: (id: number) => void;
}) {
  const [repo, setRepo] = useState("all");
  const [state, setState] = useState("all");
  const [graph, setGraph] = useState(false);
  const repos = [...new Set(tickets.map((t) => t.repo))];
  const shown = tickets.filter(
    (t) =>
      (repo === "all" || t.repo === repo) &&
      (state === "all" || t.state === state),
  );
  const waitsFor = (displayId: string) =>
    edges.filter((e) => e.to === displayId);
  return (
    <>
      <p className="flex flex-wrap gap-3 text-sm">
        <label>
          仓库{" "}
          <select
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          >
            <option value="all">全部</option>
            {repos.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态{" "}
          <select
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="all">全部</option>
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
              <option key={value} value={value}>
                {ticketStateLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setGraph((on) => !on)}>
          {graph ? "票表" : "依赖图"}
        </button>
      </p>
      {graph ? (
        tickets.length === 0 ? (
          <p className="note">还没有导入票。</p>
        ) : (
          <DependencyGraph tickets={shown} edges={edges} onOpen={onOpen} />
        )
      ) : (
        <ul className="tickets">
          {shown.map((ticket) => {
            const waits = waitsFor(ticket.displayId);
            return (
              <li key={ticket.id}>
                <StatusBadge kind="ticket" code={ticket.state} />{" "}
                <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
                {ticket.title} <span className="note">[{ticket.repo}]</span>
                {ticket.appended ? (
                  <span className="badge appended"> 追加</span>
                ) : null}
                {ticket.blockedReason ? (
                  <>
                    {" — "}
                    <StatusBadge kind="blocked" code={ticket.blockedReason} />
                  </>
                ) : (
                  ""
                )}
                {waits.length > 0 ? (
                  <div className="note waits-for">
                    等待 {waits.map((e) => `${e.from} (${e.kind})`).join("、")}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function TimelinePage({
  events,
}: {
  events: { kind: string; at?: string; text?: string; runId?: number }[];
}) {
  if (events.length === 0) return <p className="note">还没有时间线事件</p>;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li
          key={`${event.kind}-${event.at}-${event.text}-${event.runId ?? ""}`}
        >
          <strong>
            {TIMELINE_LABELS[event.kind as keyof typeof TIMELINE_LABELS] ??
              event.kind}
          </strong>
          {event.at ? (
            <>
              {" "}
              <RelativeTime iso={event.at} />
            </>
          ) : null}
          {event.text &&
          event.text !==
            TIMELINE_LABELS[event.kind as keyof typeof TIMELINE_LABELS] ? (
            <div className="note">{event.text}</div>
          ) : null}
          {event.runId ? (
            <div>
              <a href={paths.run(event.runId)}>R-{event.runId}</a>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// The "交付" tab: the pull requests in the order to merge them, the acceptance pack and the overall review.
function Delivery({
  pullRequests,
  orderBroken,
  mergeOrder,
  acceptancePack,
  finalizations,
  finalRuns,
}: Pick<
  SpecView,
  | "pullRequests"
  | "orderBroken"
  | "mergeOrder"
  | "acceptancePack"
  | "finalizations"
  | "finalRuns"
>) {
  const nothing =
    pullRequests.length === 0 &&
    !acceptancePack &&
    finalizations.length === 0 &&
    finalRuns.length === 0;
  const repos = [
    ...mergeOrder.ordered,
    ...mergeOrder.unordered,
    ...pullRequests.map((pr) => pr.repo),
    ...finalizations.map((step) => step.repo),
    ...finalRuns.map((run) => run.repo),
    ...(acceptancePack?.repos.map((item) => item.repo) ?? []),
  ].filter((name, index, all) => all.indexOf(name) === index);
  return (
    <>
      {nothing ? <p className="note">还没有可交付的内容</p> : null}
      {orderBroken.map((b) => (
        <p key={b.repo} className="error" data-testid="order-broken">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      {pullRequests.length > 0 ? (
        <>
          <h3>PR</h3>
          <p className="note">
            按这个顺序合并；平台从不合入。
            {mergeOrder.ordered.length > 0 && mergeOrder.unordered.length > 0
              ? ` 没有顺序：${mergeOrder.unordered.join("、")}（没有契约关系）。`
              : ""}
          </p>
        </>
      ) : null}
      {repos.map((repo) => {
        const pr = pullRequests.find((item) => item.repo === repo);
        const steps = finalizations.filter((item) => item.repo === repo);
        const runs = finalRuns.filter((item) => item.repo === repo);
        const place = mergeOrder.ordered.indexOf(repo);
        return (
          <section
            key={repo}
            className="delivery-repo"
            data-testid={`delivery-${repo}`}
          >
            <h3>{repo}</h3>
            {place >= 0 ? (
              <p className="note">
                合并顺序 {place + 1}/{mergeOrder.ordered.length}
              </p>
            ) : mergeOrder.unordered.includes(repo) ? (
              <p className="note">没有合并顺序（没有契约关系）</p>
            ) : null}
            {pr ? (
              <ul className="pull-requests">
                <li>
                  <a href={pr.url}>
                    {pr.repo} #{pr.number}
                  </a>{" "}
                  <StatusBadge kind="pr" code={pr.state} />
                  {pr.draft ? " (草稿)" : ""}{" "}
                  {pr.waitsFor.length > 0 ? (
                    <span className="note">
                      排在 {pr.waitsFor.join("、")} 后面
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
            ) : null}
            {steps.length > 0 || runs.length > 0 ? (
              <ul className="finalizations">
                {steps.map((f) => {
                  const run = runs.find((item) => item.stage === f.step);
                  return (
                    <li key={f.step}>
                      {f.repo}: {f.step} {f.state}
                      {f.blockedReason ? (
                        <>
                          {" ("}
                          <StatusBadge kind="blocked" code={f.blockedReason} />
                          {")"}
                        </>
                      ) : (
                        ""
                      )}
                      {run ? (
                        <>
                          {" "}
                          <a href={paths.run(run.id)}>{run.displayId}</a>
                        </>
                      ) : null}
                    </li>
                  );
                })}
                {runs
                  .filter(
                    (run) => !steps.some((step) => step.step === run.stage),
                  )
                  .map((run) => (
                    <li key={run.id}>
                      {run.repo} {run.stage} {run.result ?? ""}{" "}
                      <a href={paths.run(run.id)}>{run.displayId}</a>
                    </li>
                  ))}
              </ul>
            ) : null}
            {acceptancePack?.repos
              .filter((item) => item.repo === repo)
              .map((item) => (
                <PackRepoSection key={item.repo} repo={item} />
              ))}
          </section>
        );
      })}
      {acceptancePack ? <AcceptancePackSection pack={acceptancePack} /> : null}
    </>
  );
}
