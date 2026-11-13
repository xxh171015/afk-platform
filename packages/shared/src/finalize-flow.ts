import {
  type AGENT_FAILURES,
  type AutoRetryOutcome,
  isAutoRetryOutcome,
} from "./stage-flow.ts";
import type { BlockedReason } from "./ticket-state.ts";

// After every ticket of a spec is done, each repo's integration branch gets one overall review and, if the
// review asks for it, one fix, which is merged back under the branch lock and so goes through the gate again
// (docs/design.md「收尾」). Each step runs once: a second fix or a second review would only re-open what the
// first one settled. Pure: the API applies the decision.

export const FINAL_STEPS = [
  "final-review",
  "final-fix",
  "recheck",
  "final-merge",
] as const;
export type FinalStep = (typeof FINAL_STEPS)[number];

export type FinalReport =
  | {
      step: "final-review";
      outcome: "pass" | "fix" | "invalid-output" | "timeout";
    }
  | { step: "final-fix"; outcome: "done" | (typeof AGENT_FAILURES)[number] }
  | {
      step: "recheck";
      outcome: "pass" | "fix" | "invalid-output" | "timeout";
    }
  | {
      step: "final-merge";
      outcome: "merged" | "conflict" | "gate-failed" | "tests-removed";
    };

export type FinalDecision =
  // autoRetry: the same step again, on its own, after a timeout or a missing result (once per finalization)
  | { type: "enqueue"; step: FinalStep; autoRetry?: AutoRetryOutcome }
  | { type: "done" }
  | { type: "block"; reason: BlockedReason };

// `autoRetried`: this finalization has spent its one automatic retry (a person's retry gives it back).
export function advanceFinalization(
  report: FinalReport,
  autoRetried = false,
): FinalDecision {
  if (
    report.step !== "final-merge" &&
    isAutoRetryOutcome(report.outcome) &&
    !autoRetried
  )
    return { type: "enqueue", step: report.step, autoRetry: report.outcome };
  switch (report.step) {
    case "final-review":
      if (report.outcome === "pass") return { type: "done" };
      if (report.outcome === "fix")
        return { type: "enqueue", step: "final-fix" };
      return { type: "block", reason: report.outcome };
    case "final-fix":
      return report.outcome === "done"
        ? { type: "enqueue", step: "final-merge" }
        : { type: "block", reason: report.outcome };
    case "recheck":
      if (report.outcome === "pass")
        return { type: "enqueue", step: "final-merge" };
      return { type: "block", reason: "recheck-failed" };
    case "final-merge":
      if (report.outcome === "merged") return { type: "done" };
      if (report.outcome === "tests-removed")
        return { type: "block", reason: "tests-removed" };
      return {
        type: "block",
        reason:
          report.outcome === "conflict"
            ? "merge-conflict"
            : "post-merge-gate-failed",
      };
  }
}
