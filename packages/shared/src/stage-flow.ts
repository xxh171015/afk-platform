import { type FixCounts, type FixKind, tryFix } from "./ticket-fixes.ts";
import type { BlockedReason, TicketEvent } from "./ticket-state.ts";

// Which stage runs after which (docs/design.md「单票执行流水线」). The worker hands back facts about the stage it
// ran; this decides the next step. Pure: the API applies the decision and writes the database.

export const STAGES = [
  "implement",
  "gate",
  "review",
  "merge",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "e2e", // an integration ticket's last stage: a worker-run step in a fresh integration environment
  "diagnose", // after a failed e2e: an agent in the environment says which repo is at fault (it changes nothing)
] as const;
export type Stage = (typeof STAGES)[number];

export const AGENT_FAILURES = [
  "invalid-output",
  "no-commits",
  "timeout",
  "agent-gave-up",
  "contract-change-needed",
] as const;

export const AGENT_STAGES = [
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
] as const;

export type StageReport =
  | {
      stage: (typeof AGENT_STAGES)[number];
      outcome: "done" | (typeof AGENT_FAILURES)[number];
    }
  | {
      stage: "gate";
      outcome:
        | "passed"
        | "failed"
        | "protected-path-changed"
        | "contract-copy-mismatch"
        | "tests-removed";
    }
  | { stage: "review"; outcome: "pass" | "fix" | "invalid-output" | "timeout" }
  | {
      stage: "merge";
      outcome: "merged" | "conflict" | "gate-failed" | "tests-removed";
    }
  | { stage: "e2e"; outcome: "passed" | "failed" }
  // diagnosed: the diagnosis names a repo of the environment (or the ticket's own)
  | {
      stage: "diagnose";
      outcome: "diagnosed" | "unknown-side" | "invalid-output" | "timeout";
    };

// What the ticket remembers between stages.
export interface Progress {
  fixCounts: FixCounts;
  reviewed: boolean; // review runs once per ticket
  // An integration ticket's e2e failures that were followed by a fix ticket (absent: none yet).
  integrationRounds?: number;
}

// A failed e2e and the fix ticket after it make a round; the third failure is one too many.
export const MAX_INTEGRATION_ROUNDS = 2;

export type StageDecision =
  | {
      type: "enqueue";
      stage: Stage;
      // Applied to the ticket before the job is queued (running -> merging, merging -> running).
      event?: TicketEvent;
      progress: Progress;
    }
  | { type: "block"; reason: BlockedReason }
  // The diagnosis is in: a fix ticket is to be made, and the ticket waits for it (back to pending).
  | { type: "await-fix"; progress: Progress }
  | { type: "done" };

const enqueue = (
  stage: Stage,
  progress: Progress,
  event?: TicketEvent,
): StageDecision => ({
  type: "enqueue",
  stage,
  progress,
  ...(event ? { event } : {}),
});
const block = (reason: BlockedReason): StageDecision => ({
  type: "block",
  reason,
});

// Spends one fix of the kind, or reports that it is used up.
function spendFix(progress: Progress, kind: FixKind): Progress | undefined {
  const attempt = tryFix(progress.fixCounts, kind);
  return attempt.ok ? { ...progress, fixCounts: attempt.counts } : undefined;
}

const toMerge = (progress: Progress) =>
  enqueue("merge", progress, { type: "checks-passed" });

// `ticketType` is the type of the ticket the stage ran for: an integration ticket is not done at its merge, it
// still has to pass its e2e (docs/specs/m2-platform.md「联调」).
export function advanceStage(
  report: StageReport,
  progress: Progress,
  ticketType?: string,
): StageDecision {
  switch (report.stage) {
    case "implement":
    case "gate-fix":
    case "review-fix":
    case "merge-fix":
      return report.outcome === "done"
        ? enqueue("gate", progress)
        : block(report.outcome);

    case "gate": {
      if (report.outcome === "protected-path-changed") {
        return block("protected-path-changed");
      }
      if (report.outcome === "contract-copy-mismatch") {
        return block("contract-copy-mismatch");
      }
      if (report.outcome === "tests-removed") {
        return block("tests-removed");
      }
      if (report.outcome === "passed") {
        return progress.reviewed
          ? toMerge(progress)
          : enqueue("review", progress);
      }
      const spent = spendFix(progress, "gate-fix");
      return spent ? enqueue("gate-fix", spent) : block("gate-failed");
    }

    case "review": {
      if (report.outcome === "invalid-output" || report.outcome === "timeout") {
        return block(report.outcome);
      }
      const done = { ...progress, reviewed: true };
      if (report.outcome === "pass") return toMerge(done);
      // Review runs once, so review-fix is never spent yet; if it were, merging is all that is left.
      const spent = spendFix(done, "review-fix");
      return spent ? enqueue("review-fix", spent) : toMerge(done);
    }

    case "merge": {
      if (report.outcome === "merged") {
        // no ticket event: the ticket stays merging while its e2e runs
        return ticketType === "integration"
          ? enqueue("e2e", progress)
          : { type: "done" };
      }
      if (report.outcome === "tests-removed") {
        return block("tests-removed");
      }
      const spent = spendFix(progress, "merge-fix");
      if (spent) {
        return enqueue("merge-fix", spent, { type: "merge-fix-needed" });
      }
      return block(
        report.outcome === "conflict"
          ? "merge-conflict"
          : "post-merge-gate-failed",
      );
    }

    case "e2e": {
      if (report.outcome === "passed") return { type: "done" };
      const rounds = progress.integrationRounds ?? 0;
      return rounds >= MAX_INTEGRATION_ROUNDS
        ? block("integration-loop-exceeded")
        : enqueue("diagnose", progress);
    }

    case "diagnose":
      if (report.outcome === "diagnosed") {
        return {
          type: "await-fix",
          progress: {
            ...progress,
            integrationRounds: (progress.integrationRounds ?? 0) + 1,
          },
        };
      }
      return block(
        report.outcome === "unknown-side"
          ? "integration-unknown-side"
          : report.outcome,
      );
  }
}
