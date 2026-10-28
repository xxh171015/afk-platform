export const FIX_KINDS = ["gate-fix", "review-fix", "merge-fix"] as const;
export type FixKind = (typeof FIX_KINDS)[number];
export type FixCounts = Record<FixKind, number>;

const MAX_FIXES_PER_KIND = 1;

// implement + review + one of each fix = 5 (docs/design.md「单票执行流水线」).
export const MAX_AGENT_RUNS = 2 + FIX_KINDS.length * MAX_FIXES_PER_KIND;

export type FixAttempt =
  | { ok: true; counts: FixCounts }
  | { ok: false; reason: string };

export function noFixes(): FixCounts {
  return { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 };
}

export function tryFix(counts: FixCounts, kind: FixKind): FixAttempt {
  if (counts[kind] >= MAX_FIXES_PER_KIND)
    return { ok: false, reason: `${kind} already used` };
  return { ok: true, counts: { ...counts, [kind]: counts[kind] + 1 } };
}

export type RetryMode = "resume" | "restart";

export interface RetryPlan {
  deleteBranch: boolean;
  fixCounts: FixCounts;
}

// "接着重试" keeps the branch; "从头重试" deletes it. Both go back to pending
// (see ticketTransition "retry"). The fix counts restart in both cases: for
// restart the branch is new (an inference: the design only says 清零 for resume), for resume docs/design.md「blocked 处理」says 清零.
export function retryPlan(mode: RetryMode): RetryPlan {
  return { deleteBranch: mode === "restart", fixCounts: noFixes() };
}
