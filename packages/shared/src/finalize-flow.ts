import type { AGENT_FAILURES } from "./stage-flow.ts";
import type { BlockedReason } from "./ticket-state.ts";

// After every ticket of a spec is done, each repo's integration branch gets one overall review and, if the
// review asks for it, one fix, which is merged back under the branch lock and so goes through the gate again
// (docs/design.md「收尾」). Each step runs once: a second fix or a second review would only re-open what the
// first one settled. Pure: the API applies the decision.

export const FINAL_STEPS = [
  "final-review",
  "final-fix",
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
      step: "final-merge";
      outcome: "merged" | "conflict" | "gate-failed" | "tests-removed";
    };

export type FinalDecision =
  | { type: "enqueue"; step: FinalStep }
  | { type: "done" }
  | { type: "block"; reason: BlockedReason };

export function advanceFinalization(report: FinalReport): FinalDecision {
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
