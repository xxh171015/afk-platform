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
  | "pause"
  | "resume"
  | "cancel";

export type SpecTransition =
  | { ok: true; state: SpecState }
  | { ok: false; reason: string };

const TRANSITIONS: Partial<
  Record<SpecState, Partial<Record<SpecEvent, SpecState>>>
> = {
  draft: { "confirm-plan": "planned" },
  planned: { start: "running" },
  running: { "all-tickets-done": "finalizing", pause: "paused" },
  finalizing: { "pr-opened": "awaiting-review", pause: "paused" },
  "awaiting-review": {
    "some-prs-merged": "partially-merged",
    "all-prs-merged": "merged",
    pause: "paused",
  },
  "partially-merged": { "all-prs-merged": "merged", pause: "paused" },
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
// keep their place; everyone else returns to running.
export function specResumeTarget(input: {
  hasFinalizations: boolean;
  pullStates: readonly ("open" | "closed" | "merged")[];
}): SpecState {
  if (!input.hasFinalizations) return "running";
  const live = input.pullStates.filter((state) => state !== "closed");
  if (live.length === 0) return "finalizing";
  const merged = live.filter((state) => state === "merged").length;
  if (merged === 0) return "awaiting-review";
  if (merged === live.length) return "merged";
  return "partially-merged";
}
