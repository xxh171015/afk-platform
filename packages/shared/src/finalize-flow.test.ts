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
      expect(
        advanceFinalization({ step, outcome } as FinalReport, true),
      ).toEqual({
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

  it("a Recheck that passes goes to final-merge, and a must-fix blocks without another fix", () => {
    expect(advanceFinalization({ step: "recheck", outcome: "pass" })).toEqual({
      type: "enqueue",
      step: "final-merge",
    });
    expect(advanceFinalization({ step: "recheck", outcome: "fix" })).toEqual({
      type: "block",
      reason: "recheck-failed",
    });
  });

  it("blocks tests-removed on final-merge without a second fix", () => {
    expect(
      advanceFinalization({
        step: "final-merge",
        outcome: "tests-removed",
      }),
    ).toEqual({ type: "block", reason: "tests-removed" });
  });

  it("knows its steps in order", () => {
    expect([...FINAL_STEPS]).toEqual([
      "final-review",
      "final-fix",
      "recheck",
      "final-merge",
      "final-tidy",
      "tidy-merge",
    ]);
  });

  it("a review that passes with tidyWanted goes to final-tidy", () => {
    expect(
      advanceFinalization(
        { step: "final-review", outcome: "pass" },
        false,
        true,
      ),
    ).toEqual({ type: "enqueue", step: "final-tidy" });
  });

  it("a merged final-fix with tidyWanted goes to final-tidy", () => {
    expect(
      advanceFinalization(
        { step: "final-merge", outcome: "merged" },
        false,
        true,
      ),
    ).toEqual({ type: "enqueue", step: "final-tidy" });
  });

  it("a finished final-tidy goes to tidy-merge, and any other tidy result is the end", () => {
    expect(
      advanceFinalization({ step: "final-tidy", outcome: "done" }, false, true),
    ).toEqual({ type: "enqueue", step: "tidy-merge" });
    for (const outcome of [
      "invalid-output",
      "timeout",
      "no-commits",
      "agent-gave-up",
      "contract-change-needed",
    ] as const) {
      expect(
        advanceFinalization({ step: "final-tidy", outcome }, false, true),
      ).toEqual({ type: "done" });
      expect(
        advanceFinalization({ step: "final-tidy", outcome }, true, true),
      ).toEqual({ type: "done" });
    }
  });

  it("every tidy-merge result is the end, and only merged counts as the tidy taking effect", () => {
    for (const outcome of [
      "merged",
      "conflict",
      "gate-failed",
      "tests-removed",
    ] as const) {
      expect(
        advanceFinalization({ step: "tidy-merge", outcome }, false, true),
      ).toEqual({ type: "done" });
    }
  });

  it("tidyWanted false leaves each step's decision as it was", () => {
    expect(
      advanceFinalization(
        { step: "final-review", outcome: "pass" },
        false,
        false,
      ),
    ).toEqual({ type: "done" });
    expect(
      advanceFinalization(
        { step: "final-merge", outcome: "merged" },
        false,
        false,
      ),
    ).toEqual({ type: "done" });
    expect(
      advanceFinalization(
        { step: "final-review", outcome: "fix" },
        false,
        true,
      ),
    ).toEqual({ type: "enqueue", step: "final-fix" });
    expect(
      advanceFinalization({ step: "final-fix", outcome: "done" }, false, true),
    ).toEqual({ type: "enqueue", step: "final-merge" });
    expect(
      advanceFinalization({ step: "recheck", outcome: "pass" }, false, true),
    ).toEqual({ type: "enqueue", step: "final-merge" });
    expect(
      advanceFinalization(
        { step: "final-merge", outcome: "conflict" },
        false,
        true,
      ),
    ).toEqual({ type: "block", reason: "merge-conflict" });
  });

  it.each([
    ["final-review", "timeout"],
    ["final-review", "invalid-output"],
    ["final-fix", "timeout"],
    ["final-fix", "invalid-output"],
    ["recheck", "timeout"],
    ["recheck", "invalid-output"],
  ] as const)(
    "runs %s again once after %s, before blocking",
    (step, outcome) => {
      expect(advanceFinalization({ step, outcome } as FinalReport)).toEqual({
        type: "enqueue",
        step,
        autoRetry: outcome,
      });
      expect(
        advanceFinalization({ step, outcome } as FinalReport, true),
      ).toEqual({
        type: "block",
        reason: step === "recheck" ? "recheck-failed" : outcome,
      });
    },
  );

  it.each(["no-commits", "agent-gave-up", "contract-change-needed"] as const)(
    "does not retry a final-fix that reports %s",
    (outcome) => {
      expect(advanceFinalization({ step: "final-fix", outcome })).toEqual({
        type: "block",
        reason: outcome,
      });
    },
  );
});
