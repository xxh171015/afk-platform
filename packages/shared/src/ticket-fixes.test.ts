import { describe, expect, it } from "vitest";
import {
  FIX_KINDS,
  MAX_AGENT_RUNS,
  noFixes,
  retryPlan,
  tryFix,
} from "./ticket-fixes.ts";

describe("tryFix: each fix kind runs at most once per ticket", () => {
  it.each(FIX_KINDS)("allows a first %s and records it", (kind) => {
    const result = tryFix(noFixes(), kind);
    expect(result).toEqual({ ok: true, counts: { ...noFixes(), [kind]: 1 } });
  });

  it.each(FIX_KINDS)("refuses a second %s", (kind) => {
    const first = tryFix(noFixes(), kind);
    if (!first.ok) throw new Error("first fix should be allowed");
    expect(tryFix(first.counts, kind).ok).toBe(false);
  });

  it("different kinds do not use each other's budget", () => {
    let counts = noFixes();
    for (const kind of FIX_KINDS) {
      const r = tryFix(counts, kind);
      if (!r.ok) throw new Error(`${kind} should be allowed`);
      counts = r.counts;
    }
    expect(counts).toEqual({ "gate-fix": 1, "review-fix": 1, "merge-fix": 1 });
  });

  it("does not mutate the counts it was given", () => {
    const counts = noFixes();
    tryFix(counts, "gate-fix");
    expect(counts).toEqual(noFixes());
  });

  it("a ticket never exceeds 5 agent runs: implement + review + every fix once", () => {
    let counts = noFixes();
    for (const kind of FIX_KINDS) {
      const r = tryFix(counts, kind);
      if (r.ok) counts = r.counts;
      expect(tryFix(counts, kind).ok).toBe(false);
    }
    const fixRuns = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(2 + fixRuns).toBe(5);
    expect(MAX_AGENT_RUNS).toBe(2 + fixRuns);
  });
});

describe("retryPlan", () => {
  it("resuming keeps the branch and its commits, and clears the fix counts", () => {
    expect(retryPlan("resume")).toEqual({
      deleteBranch: false,
      fixCounts: noFixes(),
    });
  });

  it("restarting deletes the agent branch, and starts with fresh fix counts", () => {
    expect(retryPlan("restart")).toEqual({
      deleteBranch: true,
      fixCounts: noFixes(),
    });
  });
});
