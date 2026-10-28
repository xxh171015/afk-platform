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
  "no-commits",
  "agent-gave-up",
  "contract-change-needed",
  "invalid-output",
  "timeout",
  "integration-loop-exceeded",
  "upstream-cancelled",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export type TicketEvent =
  | { type: "enqueue" }
  | { type: "claim" }
  | { type: "checks-passed" }
  | { type: "merge-succeeded" }
  | { type: "merge-fix-needed" }
  | { type: "block"; reason: BlockedReason }
  | { type: "retry" }
  | { type: "cancel" };

type PlainState = Exclude<TicketState, "blocked">;

export type TicketTransition =
  | { ok: true; state: PlainState }
  | { ok: true; state: "blocked"; blockedReason: BlockedReason }
  | { ok: false; reason: string };

const TRANSITIONS: Partial<
  Record<TicketState, Partial<Record<TicketEvent["type"], PlainState>>>
> = {
  pending: { enqueue: "queued", cancel: "cancelled" },
  queued: { claim: "running" },
  running: { "checks-passed": "merging" },
  blocked: { retry: "pending", cancel: "cancelled" },
  merging: { "merge-succeeded": "done", "merge-fix-needed": "running" },
};

const FROM_RUNNING: TicketState[] = ["running"];
const FROM_MERGING: TicketState[] = ["merging"];

// Which states each reason can be raised from (docs/design.md「单票执行流水线」「blocked 处理」).
const BLOCK_SOURCES: Record<BlockedReason, TicketState[]> = {
  "gate-failed": FROM_RUNNING,
  "protected-path-changed": FROM_RUNNING,
  "no-commits": FROM_RUNNING,
  "agent-gave-up": FROM_RUNNING,
  "contract-change-needed": FROM_RUNNING,
  // the merge stage reports its facts too, and can hand back garbage or run out of time
  "invalid-output": [...FROM_RUNNING, ...FROM_MERGING],
  timeout: [...FROM_RUNNING, ...FROM_MERGING],
  "merge-conflict": FROM_MERGING,
  "post-merge-gate-failed": FROM_MERGING,
  "integration-loop-exceeded": FROM_RUNNING,
  "upstream-cancelled": ["pending"],
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
