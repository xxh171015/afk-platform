import { TICKET_STATES, type TicketState } from "@afk/shared";
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
import { useMemo } from "react";
import { ticketBorderClass } from "../components/afk/badges.tsx";
import { layoutGraph, STATE_COLORS } from "../graph.ts";
import { cn } from "../lib/utils.ts";
import { paths } from "../paths.ts";
import { blockedReasonLabel, ticketStateLabel } from "../status.ts";
import { peekTicketClick } from "../TicketDetail.tsx";
import type { SpecView } from "./view.ts";

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

// The nodes and edges only change when the spec does, not on every poll that finds nothing new.
export function DependencyGraph({
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
        "afk-graph graph flex h-[420px] flex-col rounded-md border bg-surface",
        className,
      )}
    >
      <div className="min-h-0 flex-1">
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
                  peekTicketClick(
                    event,
                    (node.data as TicketNodeData).id,
                    onOpen,
                  )
              : undefined
          }
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ul
        aria-label="票状态图例"
        className="flex flex-wrap gap-x-3 gap-y-1 border-t px-3 py-2 text-[11px] text-muted-foreground"
      >
        {TICKET_STATES.map((state) => (
          <li key={state} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-sm border"
              style={{
                background: STATE_COLORS[state].fill,
                borderColor: STATE_COLORS[state].border,
              }}
            />
            {ticketStateLabel(state)}
          </li>
        ))}
      </ul>
    </figure>
  );
}
