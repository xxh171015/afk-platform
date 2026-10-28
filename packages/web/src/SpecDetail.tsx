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
import { describeError, useApi } from "./api.tsx";
import { layoutGraph, STATE_COLORS } from "./graph.ts";

// One spec: the dependency graph with a node per ticket coloured by its state, the warnings the import left, and
// the button that confirms the split so that the platform starts working on it.

interface TicketNodeData extends Record<string, unknown> {
  displayId: string;
  title: string;
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
      <strong>{data.displayId}</strong> {data.title}
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
const NODE_HEIGHT = 64;

export function SpecDetail({ specId }: { specId: number }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const view = useQuery({
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
  const { spec, tickets, edges, finalizations } = view.data;

  const positions = new Map(layoutGraph(tickets, edges).map((p) => [p.id, p]));
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
      displayId: ticket.displayId,
      title: ticket.title,
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
      )}

      <h3>Tickets</h3>
      <ul className="tickets">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <span className={`badge ticket-${ticket.state}`}>
              {ticket.state}
            </span>{" "}
            {ticket.displayId} {ticket.title}
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
