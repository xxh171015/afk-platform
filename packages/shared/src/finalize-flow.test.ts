import { describe, expect, it } from "vitest";
import {
  advanceFinalization,
  FINAL_STEPS,
  type FinalReport,
} from "./finalize-flow.ts";

describe("finalization of a spec's integration branch", () => {
  it("a review that passes is the end: nothing to fix, nothing to merge", () => {
    expect(
      advanceFinalization({ step: "final-review", outcome: "pass" }),
    ).toEqual({ type: "done" });
  });

  it("a review that wants a fix runs final-fix once, then merges the fix under the branch lock", () => {
    expect(
      advanceFinalization({ step: "final-review", outcome: "fix" }),
    ).toEqual({ type: "enqueue", step: "final-fix" });
    expect(advanceFinalization({ step: "final-fix", outcome: "done" })).toEqual(
      { type: "enqueue", step: "final-merge" },
    );
    expect(
      advanceFinalization({ step: "final-merge", outcome: "merged" }),
    ).toEqual({ type: "done" });
  });

  it.each([
    ["final-review", "invalid-output"],
    ["final-review", "timeout"],
    ["final-fix", "invalid-output"],
    ["final-fix", "timeout"],
    ["final-fix", "no-commits"],
    ["final-fix", "agent-gave-up"],
    ["final-fix", "contract-change-needed"],
  ] as const)(
    "%s reporting %s blocks the finalization with that reason",
    (step, outcome) => {
      expect(advanceFinalization({ step, outcome } as FinalReport)).toEqual({
        type: "block",
        reason: outcome,
      });
    },
  );

  it("a conflict or a failed gate when the fix is merged blocks it, and does not try a second fix", () => {
    expect(
      advanceFinalization({ step: "final-merge", outcome: "conflict" }),
    ).toEqual({ type: "block", reason: "merge-conflict" });
    expect(
      advanceFinalization({ step: "final-merge", outcome: "gate-failed" }),
    ).toEqual({
      type: "block",
      reason: "post-merge-gate-failed",
    });
  });

  it("knows its steps in order", () => {
    expect([...FINAL_STEPS]).toEqual([
      "final-review",
      "final-fix",
      "final-merge",
    ]);
  });
});
