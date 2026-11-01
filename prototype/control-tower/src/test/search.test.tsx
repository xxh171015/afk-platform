import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mock from "@/api/mock/server";
import { useDebouncedSearch } from "@/hooks/use-search";
import { highlightParts, readRecentVisits, recordVisit, RECENT_VISITS_KEY } from "@/lib/search";

beforeEach(() => { mock.resetMockDb({ liveTicks: false }); localStorage.clear(); });
afterEach(() => vi.useRealTimers());

describe("global search rules", () => {
  it("requests only after 250ms of idle input", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ q }) => useDebouncedSearch(q), { initialProps: { q: "S-12" } });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe("");
    rerender({ q: "T-103" });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("T-103");
  });
  it("accepts 200 characters but rejects 201", () => {
    expect(() => mock.search("a".repeat(200))).not.toThrow();
    expect(() => mock.search("a".repeat(201))).toThrow("200");
  });
  it("returns an exact S-12 jump, ignoring case and surrounding spaces", () => {
    expect(mock.search(" s-12 ").jump).toMatchObject({ kind: "spec", id: "spec_12", displayId: "S-12" });
    expect(mock.search("S-1").jump).toBeUndefined();
  });
  it("returns an exact ticket jump and its owning spec", () => {
    expect(mock.search("T-103").jump).toMatchObject({ kind: "ticket", id: "tkt_103", specDisplayId: "S-12" });
  });
  it("resolves exact Run identifiers to their real ticket", () => {
    const run = mock.getTicket("tkt_103").runs[0];
    if (!run) throw new Error("fixture run missing");
    expect(mock.search(run.displayId).jump).toMatchObject({ kind: "run", id: run.id, ticketId: "tkt_103" });
  });
  it("reports title and body matches and preserves highlight text", () => {
    const results = mock.search("订单");
    expect(results.specs.some(s => s.matched.includes("title"))).toBe(true);
    expect(results.tickets.some(t => t.matched.includes("body"))).toBe(true);
    expect(highlightParts("S-12 / s-12", "s-12").filter(p => p.match).map(p => p.text)).toEqual(["S-12", "s-12"]);
  });
  it("stores recent visits newest first without duplicate destinations or operational data", () => {
    recordVisit({ kind: "spec", id: "spec_12", displayId: "S-12", title: "订单备注" });
    recordVisit({ kind: "ticket", id: "tkt_103", displayId: "T-103", title: "实现" });
    recordVisit({ kind: "spec", id: "spec_12", displayId: "S-12", title: "更新" });
    expect(readRecentVisits().map(v => v.displayId)).toEqual(["S-12", "T-103"]);
    localStorage.setItem(RECENT_VISITS_KEY, "malformed");
    expect(readRecentVisits()).toEqual([]);
  });
});