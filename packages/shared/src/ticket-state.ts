export const TICKET_STATES = [
  "pending",
  "queued",
  "running",
  "merging",
  "done",
  "blocked",
  "cancelled",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const BLOCKED_REASONS = [
  "gate-failed",
  "post-merge-gate-failed",
  "merge-conflict",
  "protected-path-changed",
  // the contract copy in the repo is not the contract the ticket was pinned to (or a ticket without a contract edge touched one)
  "contract-copy-mismatch",
  "no-commits",
  "agent-gave-up",
  "contract-change-needed",
  "invalid-output",
  "timeout",
  "integration-loop-exceeded",
  // the diagnosis could not tell which repo is at fault (or named one the ticket's environment does not have)
  "integration-unknown-side",
  // the integration environment could not be brought up (build, health check, service names), three times over
  "integration-environment-failed",
  "upstream-cancelled",
  // the worker could not carry out a stage, three times over: its environment is at fault, not the ticket
  "job-failed",
  // the kernel killed the sandbox for using too much memory; stop at once, do not retry the same limit
  "sandbox-oom",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export type TicketEvent =
  | { type: "enqueue" }
  | { type: "claim" }
  | { type: "checks-passed" }
  | { type: "merge-succeeded" }
  | { type: "merge-fix-needed" }
  // An integration ticket whose e2e is to run (again): from the queue straight to merging, it is merged already.
  | { type: "resume-e2e" }
  // A failed e2e was diagnosed and a fix ticket was made: the ticket waits for it, to run its e2e again.
  | { type: "await-fix" }
  | { type: "block"; reason: BlockedReason }
  | { type: "retry" }
  // A person accepts the protected path changes of a blocked ticket: it goes on from the gate.
  | { type: "approve-protected" }
  | { type: "cancel" }
  // The whole spec is cancelled: every ticket that has not finished goes with it, even one under way.
  | { type: "spec-cancelled" };

type PlainState = Exclude<TicketState, "blocked">;

export type TicketTransition =
  | { ok: true; state: PlainState }
  | { ok: true; state: "blocked"; blockedReason: BlockedReason }
  | { ok: false; reason: string };

const TRANSITIONS: Partial<
  Record<TicketState, Partial<Record<TicketEvent["type"], PlainState>>>
> = {
  pending: {
    enqueue: "queued",
    cancel: "cancelled",
    "spec-cancelled": "cancelled",
  },
  queued: {
    claim: "running",
    "resume-e2e": "merging",
    "spec-cancelled": "cancelled",
  },
  running: { "checks-passed": "merging", "spec-cancelled": "cancelled" },
  blocked: {
    retry: "pending",
    "approve-protected": "running",
    cancel: "cancelled",
    "spec-cancelled": "cancelled",
  },
  merging: {
    "merge-succeeded": "done",
    "merge-fix-needed": "running",
    "await-fix": "pending",
    "spec-cancelled": "cancelled",
  },
};

const FROM_RUNNING: TicketState[] = ["running"];
const FROM_MERGING: TicketState[] = ["merging"];

// Which states each reason can be raised from (docs/design.md「单票执行流水线」「blocked 处理」).
const BLOCK_SOURCES: Record<BlockedReason, TicketState[]> = {
  "gate-failed": FROM_RUNNING,
  "protected-path-changed": FROM_RUNNING,
  "contract-copy-mismatch": FROM_RUNNING,
  "no-commits": FROM_RUNNING,
  "agent-gave-up": FROM_RUNNING,
  "contract-change-needed": FROM_RUNNING,
  // the merge stage reports its facts too, and can hand back garbage or run out of time
  "invalid-output": [...FROM_RUNNING, ...FROM_MERGING],
  timeout: [...FROM_RUNNING, ...FROM_MERGING],
  "merge-conflict": FROM_MERGING,
  "post-merge-gate-failed": FROM_MERGING,
  "integration-loop-exceeded": FROM_MERGING,
  "integration-unknown-side": FROM_MERGING,
  "integration-environment-failed": [...FROM_RUNNING, ...FROM_MERGING],
  "upstream-cancelled": ["pending"],
  "job-failed": [...FROM_RUNNING, ...FROM_MERGING],
  "sandbox-oom": [...FROM_RUNNING, ...FROM_MERGING],
};

export function ticketTransition(
  from: TicketState,
  event: TicketEvent,
): TicketTransition {
  if (event.type === "block" && BLOCK_SOURCES[event.reason].includes(from)) {
    return { ok: true, state: "blocked", blockedReason: event.reason };
  }
  const state = TRANSITIONS[from]?.[event.type];
  if (!state)
    return { ok: false, reason: `${event.type} is not allowed in ${from}` };
  return { ok: true, state };
}
