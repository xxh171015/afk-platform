import dagre from "@dagrejs/dagre";
import type { Edge, Ticket } from "@/api/types";

export const NODE_WIDTH = 256;
export const NODE_HEIGHT = 152;
export function layoutSpecGraph(tickets: Ticket[], edges: Edge[], repos: string[]) {
  const g = new dagre.graphlib.Graph().setGraph({ rankdir: "LR", ranksep: 100, nodesep: 40 }).setDefaultEdgeLabel(() => ({}));
  for (const t of tickets) g.setNode(t.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  const ids = new Set(tickets.map(t => t.id));
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const positions: Record<string, { x: number; y: number }> = {};
  const lanes: { repo: string; y: number; height: number }[] = [];
  let y = 0;
  for (const repo of repos) {
    const rows = new Map<number, number>();
    let maxRows = 1;
    for (const t of tickets.filter(t => t.repo === repo)) {
      const x = Math.round(g.node(t.id).x - NODE_WIDTH / 2) + 32;
      const row = rows.get(x) ?? 0;
      rows.set(x, row + 1);
      maxRows = Math.max(maxRows, row + 1);
      positions[t.id] = { x, y: y + 60 + row * (NODE_HEIGHT + 28) };
    }
    const height = 84 + maxRows * (NODE_HEIGHT + 28);
    lanes.push({ repo, y, height });
    y += height + 16;
  }
  const width = Math.max(700, ...Object.values(positions).map(p => p.x + NODE_WIDTH + 32));
  return { positions, lanes, width, height: y };
}