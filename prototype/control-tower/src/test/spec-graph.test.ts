import { describe, expect, it } from "vitest";
import { createSeed } from "@/api/mock/seed";
import { layoutSpecGraph, NODE_HEIGHT, NODE_WIDTH } from "@/lib/spec-graph";

describe("repository dependency layout", () => {
  const db = createSeed(1793500000000);
  const tickets = db.tickets.filter(t => t.specId === "spec_12");
  const ids = new Set(tickets.map(t => t.id));
  const edges = db.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  it("puts upstream nodes left of downstream nodes including cross-repository contract edges", () => {
    const { positions } = layoutSpecGraph(tickets, edges, ["afk-pilot-backend", "afk-pilot-frontend"]);
    for (const e of edges) expect((positions[e.from]?.x ?? 0) + NODE_WIDTH).toBeLessThan(positions[e.to]?.x ?? 0);
  });
  it("keeps every ticket inside its repository lane without overlapping nodes", () => {
    const layout = layoutSpecGraph(tickets, edges, ["afk-pilot-backend", "afk-pilot-frontend"]);
    for (const t of tickets) {
      const lane = layout.lanes.find(l => l.repo === t.repo);
      const p = layout.positions[t.id];
      expect(p?.y).toBeGreaterThanOrEqual(lane?.y ?? 0);
      expect((p?.y ?? 0) + NODE_HEIGHT).toBeLessThan((lane?.y ?? 0) + (lane?.height ?? 0));
      for (const other of tickets.filter(o => o.id !== t.id)) {
        const q = layout.positions[other.id];
        expect(Math.abs((p?.x ?? 0) - (q?.x ?? 0)) >= NODE_WIDTH || Math.abs((p?.y ?? 0) - (q?.y ?? 0)) >= NODE_HEIGHT).toBe(true);
      }
    }
  });
});