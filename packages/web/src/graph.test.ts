import { TICKET_STATES } from "@afk/shared";
import { describe, expect, it } from "vitest";
import { layoutGraph, STATE_COLORS } from "./graph.ts";

const tickets = (...ids: string[]) => ids.map((displayId) => ({ displayId }));

describe("layoutGraph", () => {
  it("puts a ticket one column to the right of the one it waits for", () => {
    const placed = layoutGraph(tickets("T-1", "T-2", "T-3"), [
      { from: "T-1", to: "T-2" },
      { from: "T-2", to: "T-3" },
    ]);
    expect(placed.map((p) => [p.id, p.x / 260])).toEqual([
      ["T-1", 0],
      ["T-2", 1],
      ["T-3", 2],
    ]);
  });

  it("puts a ticket behind the furthest of the tickets it waits for", () => {
    // T-4 waits for T-1 (column 0) and T-3 (column 2)
    const placed = layoutGraph(tickets("T-1", "T-2", "T-3", "T-4"), [
      { from: "T-1", to: "T-2" },
      { from: "T-2", to: "T-3" },
      { from: "T-1", to: "T-4" },
      { from: "T-3", to: "T-4" },
    ]);
    expect(placed.find((p) => p.id === "T-4")?.x).toBe(3 * 260);
  });

  it("stacks tickets of the same column in rows, in ticket order", () => {
    const placed = layoutGraph(tickets("T-1", "T-2", "T-3"), [
      { from: "T-1", to: "T-2" },
      { from: "T-1", to: "T-3" },
    ]);
    const column1 = placed.filter((p) => p.x === 260);
    expect(column1.map((p) => p.id)).toEqual(["T-2", "T-3"]);
    expect(column1[1]?.y).toBeGreaterThan(column1[0]?.y as number);
  });

  it("keeps independent tickets in the first column, one under the other", () => {
    const placed = layoutGraph(tickets("T-1", "T-2"), []);
    expect(placed).toEqual([
      { id: "T-1", x: 0, y: 0 },
      { id: "T-2", x: 0, y: 96 },
    ]);
  });

  it("does not hang on a cycle, which an import never produces but bad data might", () => {
    const placed = layoutGraph(tickets("T-1", "T-2"), [
      { from: "T-1", to: "T-2" },
      { from: "T-2", to: "T-1" },
    ]);
    expect(placed).toHaveLength(2);
  });

  it("is empty for no tickets", () => {
    expect(layoutGraph([], [])).toEqual([]);
  });
});

describe("STATE_COLORS", () => {
  it("has a colour for every ticket state, and no two states look the same", () => {
    expect(Object.keys(STATE_COLORS).sort()).toEqual([...TICKET_STATES].sort());
    const looks = Object.values(STATE_COLORS).map(
      (c) => `${c.fill}/${c.border}`,
    );
    expect(new Set(looks).size).toBe(looks.length);
  });

  it("makes blocked tickets stand out in red and done ones green", () => {
    expect(STATE_COLORS.blocked.border).toBe("#fa5252");
    expect(STATE_COLORS.done.border).toBe("#40c057");
  });
});
