export const SPEC_STATES = [
  "draft",
  "planned",
  "running",
  "finalizing",
  "awaiting-review",
  "partially-merged",
  "reworking",
  "merged",
  "paused",
  "cancelled",
] as const;
export type SpecState = (typeof SPEC_STATES)[number];

export type SpecEvent =
  | "confirm-plan"
  | "start"
  | "all-tickets-done"
  | "pr-opened"
  | "some-prs-merged"
  | "all-prs-merged"
  | "rework"
  | "request-changes"
  | "pause"
  | "resume"
  | "cancel";

// Specs whose tickets the scheduler may start. Reworking is the same as running for slots and budget.
export const SCHEDULABLE_SPEC_STATES: readonly SpecState[] = [
  "running",
  "reworking",
];

export function specIsSchedulable(state: SpecState): boolean {
  return (SCHEDULABLE_SPEC_STATES as readonly string[]).includes(state);
}

// Why unfinished tickets are cancelled when a person merges the PR during rework.
export const REWORK_PR_MERGED_REASON = "返工中 PR 被合并";

export type SpecTransition =
  | { ok: true; state: SpecState }
  | { ok: false; reason: string };

const TRANSITIONS: Partial<
  Record<SpecState, Partial<Record<SpecEvent, SpecState>>>
> = {
  draft: { "confirm-plan": "planned" },
  planned: { start: "running" },
  running: { "all-tickets-done": "finalizing", pause: "paused" },
  finalizing: {
    "pr-opened": "awaiting-review",
    "all-prs-merged": "merged",
    pause: "paused",
  },
  "awaiting-review": {
    "some-prs-merged": "partially-merged",
    "all-prs-merged": "merged",
    rework: "reworking",
    "request-changes": "finalizing",
    pause: "paused",
  },
  "partially-merged": { "all-prs-merged": "merged", pause: "paused" },
  reworking: {
    "all-tickets-done": "finalizing",
    "all-prs-merged": "merged",
    pause: "paused",
  },
  paused: { resume: "running" },
};

// Only a spec that is over cannot be cancelled. Whether a partially merged one may be depends on its pull
// requests, which the state machine does not know: cancelSpec refuses it while one is merged and another is open.
const NOT_CANCELLABLE = new Set<SpecState>(["merged", "cancelled"]);

export function specTransition(
  from: SpecState,
  event: SpecEvent,
): SpecTransition {
  if (event === "cancel" && !NOT_CANCELLABLE.has(from))
    return { ok: true, state: "cancelled" };
  const state = TRANSITIONS[from]?.[event];
  if (!state)
    return { ok: false, reason: `${event} is not allowed in ${from}` };
  return { ok: true, state };
}

// Where a paused spec goes on resume: 收尾 (finalizing) and 验收 (awaiting-review / partially-merged)
// keep their place; unfinished appended tickets of a wrap-up that already opened PRs return to reworking;
// a second wrap-up after rework still has open PRs, so unfinished finalizations stay in 收尾;
// everyone else to running.
export function specResumeTarget(input: {
  hasFinalizations: boolean;
  pullStates: readonly ("open" | "closed" | "merged")[];
  hasIncompleteAppendedTickets?: boolean;
  hasIncompleteFinalizations?: boolean;
}): SpecState {
  if (!input.hasFinalizations) return "running";
  if (input.hasIncompleteAppendedTickets) return "reworking";
  if (input.hasIncompleteFinalizations) return "finalizing";
  const live = input.pullStates.filter((state) => state !== "closed");
  if (live.length === 0) return "finalizing";
  const merged = live.filter((state) => state === "merged").length;
  if (merged === 0) return "awaiting-review";
  if (merged === live.length) return "merged";
  return "partially-merged";
}
