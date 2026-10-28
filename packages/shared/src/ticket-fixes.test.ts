import { describe, expect, it } from "vitest";
import { MAX_AGENT_RUNS, noFixes, retryPlan, tryFix } from "./ticket-fixes.ts";

describe("tryFix: each fix kind runs at most once per ticket", () => {
  it.each(["gate-fix", "review-fix", "merge-fix"] as const)(
    "allows a first %s and records it",
    (kind) => {
      const result = tryFix(noFixes(), kind);
      expect(result).toEqual({ ok: true, counts: { ...noFixes(), [kind]: 1 } });
    },
  );

  it.each(["gate-fix", "review-fix", "merge-fix"] as const)(
    "refuses a second %s",
    (kind) => {
      const first = tryFix(noFixes(), kind);
      if (!first.ok) throw new Error("first fix should be allowed");
      expect(tryFix(first.counts, kind).ok).toBe(false);
    },
  );

  it("different kinds do not use each other's budget", () => {
    let counts = noFixes();
    for (const kind of ["gate-fix", "review-fix", "merge-fix"] as const) {
      const r = tryFix(counts, kind);
      if (!r.ok) throw new Error(`${kind} should be allowed`);
      counts = r.counts;
    }
    expect(counts).toEqual({ "gate-fix": 1, "review-fix": 1, "merge-fix": 1 });
  });

  it("a ticket never exceeds 5 agent runs: implement + review + three fixes", () => {
    expect(MAX_AGENT_RUNS).toBe(5);
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
