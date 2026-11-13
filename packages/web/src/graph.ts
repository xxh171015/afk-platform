import type { TicketState } from "@afk/shared";

// The dependency graph of a spec, laid out in columns: a ticket sits one column to the right of the furthest
// ticket it waits for, so work flows left to right.

export const STATE_COLORS: Record<
  TicketState,
  { fill: string; border: string }
> = {
  pending: { fill: "#f1f3f5", border: "#adb5bd" },
  queued: { fill: "#e7f5ff", border: "#74c0fc" },
  running: { fill: "#d0ebff", border: "#339af0" },
  merging: { fill: "#e5dbff", border: "#845ef7" },
  done: { fill: "#d3f9d8", border: "#40c057" },
  blocked: { fill: "#ffe3e3", border: "#fa5252" },
  cancelled: { fill: "#f8f9fa", border: "#ced4da" },
  "taken-over": { fill: "#fff4e6", border: "#fd7e14" },
};

export interface GraphTicket {
  displayId: string;
}
export interface GraphEdge {
  from: string;
  to: string;
}

const COLUMN = 260;
const ROW = 96;

export function layoutGraph(
  tickets: readonly GraphTicket[],
  edges: readonly GraphEdge[],
) {
  const incoming = new Map<string, string[]>(
    tickets.map((t) => [t.displayId, []]),
  );
  for (const edge of edges) incoming.get(edge.to)?.push(edge.from);

  const depth = new Map<string, number>();
  const depthOf = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0; // an import never has a cycle; do not loop on bad data
    trail.add(id);
    const ups = incoming.get(id) ?? [];
    const result =
      ups.length === 0
        ? 0
        : 1 + Math.max(...ups.map((up) => depthOf(up, trail)));
    trail.delete(id);
    depth.set(id, result);
    return result;
  };

  const rows = new Map<number, number>();
  return tickets.map((ticket) => {
    const column = depthOf(ticket.displayId, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { id: ticket.displayId, x: column * COLUMN, y: row * ROW };
  });
}
