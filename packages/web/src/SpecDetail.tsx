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
import { useMemo } from "react";
import { describeError, useApi } from "./api.tsx";
import { layoutGraph, STATE_COLORS } from "./graph.ts";
import { pullStateLabel } from "./pull-request.ts";

// One spec: the dependency graph with a node per ticket coloured by its state, the warnings the import left, and
// the button that confirms the split so that the platform starts working on it.

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
      <a href={`#/tickets/${data.id}`}>
        <strong>{data.displayId}</strong>
      </a>{" "}
      {data.title}
      <div className="ticket-node-repo">
        {data.repo}
        {data.appended ? " · appended" : ""}
      </div>
      <div className="ticket-node-state">
        {data.state}
        {data.blockedReason ? ` (${data.blockedReason})` : ""}
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
      <h4>Criteria</h4>
      {pack.tickets.map((ticket) => (
        <div key={ticket.displayId}>
          <p>
            <strong>{ticket.displayId}</strong> {ticket.title}
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

      <h4>Review findings</h4>
      {pack.findings.length === 0 ? (
        <p className="note">None.</p>
      ) : (
        <ul className="pack-findings">
          {pack.findings.map((finding) => (
            <li key={`${finding.run}-${finding.kind}-${finding.body}`}>
              <span className="badge">{finding.resolution}</span>{" "}
              {finding.ticket ?? "spec"} {finding.stage} {finding.kind}:{" "}
              {finding.body}
            </li>
          ))}
        </ul>
      )}

      <h4>What the agents were unsure of</h4>
      {pack.uncertainties.length === 0 ? (
        <p className="note">Nothing.</p>
      ) : (
        <ul className="uncertainties">
          {pack.uncertainties.map((u) => (
            <li key={`${u.source}-${u.text}`}>
              {u.source}: {u.text}
            </li>
          ))}
        </ul>
      )}

      <h4>Gates</h4>
      <ul className="gates">
        {pack.gates.map((gate) => (
          <li key={gate.repo}>
            {gate.repo} @ {gate.commitSha.slice(0, 8)}: {gate.testsTotal ?? "?"}{" "}
            tests, {gate.testsSkipped ?? "?"} skipped,{" "}
            {seconds(gate.durationMs)} (
            {gate.steps
              .map(
                (step) =>
                  `${step.name} ${seconds(step.ms)}${step.exitCode === 0 ? "" : ` exit ${step.exitCode}`}`,
              )
              .join(", ")}
            )
          </li>
        ))}
      </ul>

      {pack.protectedPathApprovals.length > 0 ? (
        <>
          <h4>Approved protected paths</h4>
          <ul className="approvals">
            {pack.protectedPathApprovals.map((approval) => (
              <li key={approval.ticket}>
                {approval.ticket}: {approval.paths.join(", ")}
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
  const { spec, tickets, edges, finalizations, pullRequests, acceptancePack } =
    view.data;

  const canConfirm = spec.state === "draft" && tickets.length > 0;

  return (
    <section className="spec-detail">
      <p>
        <a href="#/">← all specs</a>
      </p>
      <h2>
        {spec.displayId} {spec.title}{" "}
        <span className={`badge spec-${spec.state}`}>{spec.state}</span>
      </h2>
      {spec.pauseReason ? (
        <p className="error">Paused: {spec.pauseReason}</p>
      ) : null}

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

      {pullRequests.length > 0 ? (
        <>
          <h3>Pull requests</h3>
          <p className="note">
            Merge them in this order; the platform never merges.
          </p>
          <ol className="pull-requests">
            {pullRequests.map((pr) => (
              <li key={pr.repo}>
                <a href={pr.url}>
                  {pr.repo} #{pr.number}
                </a>{" "}
                <span className={`badge pr-${pr.state}`}>
                  {pullStateLabel(pr.state)}
                  {pr.draft ? " (draft)" : ""}
                </span>{" "}
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

      <h3>Warnings from the import</h3>
      {spec.warnings.length === 0 ? (
        <p className="note">No warnings.</p>
      ) : (
        <ul className="warnings">
          {spec.warnings.map((warning, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no id of their own
            <li key={index}>
              {(warning as { message?: string }).message ??
                JSON.stringify(warning)}
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

      <h3>Tickets</h3>
      <ul className="tickets">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <span className={`badge ticket-${ticket.state}`}>
              {ticket.state}
            </span>{" "}
            <a href={`#/tickets/${ticket.id}`}>{ticket.displayId}</a>{" "}
            {ticket.title}
            {ticket.appended ? (
              <span className="badge appended"> appended</span>
            ) : null}
            {ticket.blockedReason ? ` — ${ticket.blockedReason}` : ""}
          </li>
        ))}
      </ul>

      {finalizations.length > 0 ? (
        <>
          <h3>Overall review</h3>
          <ul className="finalizations">
            {finalizations.map((f) => (
              <li key={f.repo}>
                {f.repo}: {f.step} {f.state}
                {f.blockedReason ? ` (${f.blockedReason})` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
