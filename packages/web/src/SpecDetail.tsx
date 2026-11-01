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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { layoutGraph, STATE_COLORS } from "./graph.ts";
import { Markdown } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { Sha } from "./Sha.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
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
}

function TicketNode({ data }: NodeProps<Node<TicketNodeData>>) {
  const colors = STATE_COLORS[data.state];
  return (
    <div
      className="ticket-node"
      data-testid={`node-${data.displayId}`}
      data-state={data.state}
      style={{ background: colors.fill, borderColor: colors.border }}
    >
      <Handle type="target" position={Position.Left} />
      <a href={paths.ticket(data.id)}>
        <strong>{data.displayId}</strong>
      </a>{" "}
      {data.title}
      <div className="ticket-node-repo">
        {data.repo}
        {data.appended ? " · appended" : ""}
      </div>
      <div className="ticket-node-state">
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
  return useQuery({
    queryKey: ["spec", specId],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: 3_000,
  });
}

type SpecView = NonNullable<ReturnType<typeof useSpecView>["data"]>;

// The nodes and edges only change when the spec does, not on every poll that finds nothing new.
function DependencyGraph({
  tickets,
  edges,
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
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
  }, [tickets, edges]);
  return (
    <figure className="graph">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </figure>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// The acceptance pack, read top to bottom before merging: the pull requests in the order to merge them, then what
// backs each criterion, what the reviews and agents flagged, and what the gates measured.
function AcceptancePackSection({
  pack,
}: {
  pack: NonNullable<SpecView["acceptancePack"]>;
}) {
  return (
    <section className="acceptance-pack">
      <h3>Acceptance pack</h3>
      {pack.orderBroken.map((b) => (
        <p key={b.repo} className="error">
          Merge order broken: {b.repo} was merged before {b.skipped.join(", ")}.
        </p>
      ))}
      <p className="note" data-testid="pack-merge-order">
        {pack.mergeOrder.ordered.length > 0
          ? `Merge order: ${pack.mergeOrder.ordered.join(" → ")}${
              pack.mergeOrder.unordered.length > 0
                ? ` (no order: ${pack.mergeOrder.unordered.join(", ")})`
                : ""
            }`
          : "Merge order: none, the repos have no contract relation."}
      </p>
      {pack.repos.map((repo) => (
        <section
          key={repo.repo}
          className="pack-repo"
          data-testid={`pack-repo-${repo.repo}`}
        >
          <h4>{repo.repo}</h4>
          {repo.pullRequest ? (
            <p>
              <a href={repo.pullRequest.url}>
                Pull request #{repo.pullRequest.number}
              </a>{" "}
              <StatusBadge kind="pr" code={repo.pullRequest.state} />
              {repo.pullRequest.draft ? " (草稿)" : ""} CI {repo.pullRequest.ci}
              , review {repo.pullRequest.review}
            </p>
          ) : null}
          {repo.tickets.map((ticket) => (
            <div key={ticket.displayId}>
              <p>
                <strong>{ticket.displayId}</strong> {ticket.title}
                {ticket.appended ? (
                  <span className="badge appended"> appended</span>
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
              <p className="note">Scope creep: not asked for</p>
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
              <p className="note">What the agents were unsure of:</p>
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
              Gate: <Sha value={repo.gate.commitSha} />:{" "}
              {repo.gate.testsTotal ?? "?"} tests,{" "}
              {repo.gate.testsSkipped ?? "?"} skipped,{" "}
              {seconds(repo.gate.durationMs)} (
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
                  Approved protected paths, {approval.ticket}:{" "}
                  {approval.paths.join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      {pack.cancelledTickets.length > 0 ? (
        <>
          <h4>Cancelled tickets</h4>
          <ul className="cancelled-tickets">
            {pack.cancelledTickets.map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title} [
                {ticket.repo}] <span className="badge">cancelled</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="note">Agent time: {pack.agentSeconds} s.</p>
    </section>
  );
}

export function SpecDetail({ specId }: { specId: number }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const view = useSpecView(specId);
  const [tab, setTab] = useState<"spec" | "delivery">("spec");
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

  if (view.isPending) return <p className="note">Loading the spec…</p>;
  if (view.isError)
    return (
      <p className="error" role="alert">
        Could not load the spec: {view.error.message}
      </p>
    );
  const {
    spec,
    tickets,
    edges,
    finalizations,
    pullRequests,
    mergeOrder,
    orderBroken,
    acceptancePack,
  } = view.data;

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
  // what each ticket waits for: the tickets with an edge into it, and the kind of the edge
  const waitsFor = (displayId: string) =>
    edges.filter((e) => e.to === displayId);

  return (
    <section className="spec-detail">
      <p>
        <a href={paths.specs}>← 全部需求</a>
      </p>
      <h2>
        {spec.displayId} {spec.title}{" "}
        <StatusBadge kind="spec" code={spec.state} />
      </h2>
      {spec.pauseReason ? (
        <p className="error">Paused: {spec.pauseReason}</p>
      ) : null}

      <div className="two-columns">
        <div className="main-column">
          <div className="tabs" role="tablist">
            {(
              [
                ["spec", "需求说明"],
                ["delivery", "交付"],
              ] as const
            ).map(([name, label]) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? "tab selected" : "tab"}
                onClick={() => setTab(name)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "spec" ? (
            spec.body.trim() === "" ? (
              <p className="note" data-testid="empty-body">
                这份需求没有正文
              </p>
            ) : (
              <Markdown source={spec.body} contents />
            )
          ) : (
            <Delivery
              pullRequests={pullRequests}
              orderBroken={orderBroken}
              mergeOrder={mergeOrder}
              acceptancePack={acceptancePack}
              finalizations={finalizations}
            />
          )}
        </div>

        <aside className="side-column">
          {spec.state === "draft" ? (
            <div className="confirm">
              <button
                type="button"
                onClick={() => confirm.mutate()}
                disabled={!canConfirm || confirm.isPending}
              >
                {confirm.isPending ? "Confirming…" : "Confirm split"}
              </button>
              {tickets.length === 0 ? (
                <span className="note">
                  {" "}
                  Import tickets first (plat tickets import).
                </span>
              ) : null}
              {confirm.isError ? (
                <p className="error" role="alert">
                  {confirm.error.message}
                </p>
              ) : null}
            </div>
          ) : null}

          <h3>Tickets</h3>
          <ul className="tickets">
            {tickets.map((ticket) => {
              const waits = waitsFor(ticket.displayId);
              return (
                <li key={ticket.id}>
                  <StatusBadge kind="ticket" code={ticket.state} />{" "}
                  <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
                  {ticket.title} <span className="note">[{ticket.repo}]</span>
                  {ticket.appended ? (
                    <span className="badge appended"> appended</span>
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
                      waits for{" "}
                      {waits.map((e) => `${e.from} (${e.kind})`).join(", ")}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      <h3>确认前预检</h3>
      {prechecks.length === 0 ? (
        <p className="note">没有黄项</p>
      ) : (
        <ul className="warnings" data-testid="prechecks">
          {prechecks.map((item) => (
            <li key={`${item.code}:${item.message}`} data-level={item.level}>
              {item.message}
            </li>
          ))}
        </ul>
      )}

      <h3>Dependency graph</h3>
      {tickets.length === 0 ? (
        <p className="note">No tickets imported.</p>
      ) : (
        <DependencyGraph tickets={tickets} edges={edges} />
      )}
    </section>
  );
}

// The "交付" tab: the pull requests in the order to merge them, the acceptance pack and the overall review.
function Delivery({
  pullRequests,
  orderBroken,
  mergeOrder,
  acceptancePack,
  finalizations,
}: Pick<
  SpecView,
  | "pullRequests"
  | "orderBroken"
  | "mergeOrder"
  | "acceptancePack"
  | "finalizations"
>) {
  const nothing =
    pullRequests.length === 0 && !acceptancePack && finalizations.length === 0;
  return (
    <>
      {nothing ? <p className="note">还没有可交付的内容</p> : null}
      {pullRequests.length > 0 ? (
        <>
          <h3>Pull requests</h3>
          {orderBroken.map((b) => (
            <p key={b.repo} className="error" data-testid="order-broken">
              Merge order broken: {b.repo} was merged before{" "}
              {b.skipped.join(", ")}.
            </p>
          ))}
          <p className="note">
            Merge them in this order; the platform never merges.
            {mergeOrder.ordered.length > 0 && mergeOrder.unordered.length > 0
              ? ` No order between: ${mergeOrder.unordered.join(", ")} (no contract relation).`
              : ""}
          </p>
          <ol className="pull-requests">
            {pullRequests.map((pr) => (
              <li key={pr.repo}>
                <a href={pr.url}>
                  {pr.repo} #{pr.number}
                </a>{" "}
                <StatusBadge kind="pr" code={pr.state} />
                {pr.draft ? " (草稿)" : ""}{" "}
                {pr.waitsFor.length > 0 ? (
                  <span className="note">
                    after {pr.waitsFor.join(", ")}
                    {" · "}
                  </span>
                ) : null}
                CI {pr.ci}, review {pr.review}
                {pr.syncError ? (
                  <span className="error">
                    {" "}
                    could not be read: {pr.syncError}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {acceptancePack ? <AcceptancePackSection pack={acceptancePack} /> : null}
      {finalizations.length > 0 ? (
        <>
          <h3>Overall review</h3>
          <ul className="finalizations">
            {finalizations.map((f) => (
              <li key={f.repo}>
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
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
