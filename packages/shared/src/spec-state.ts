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
  finalizing: { "pr-opened": "awaiting-review" },
  "awaiting-review": { "all-prs-merged": "merged" },
  paused: { resume: "running" },
};

const TERMINAL_STATES = new Set<SpecState>(["merged", "cancelled"]);
// A person has already merged part of it: what is merged cannot be taken back by cancelling. Nothing moves a spec
// into partially-merged yet (a spec with a merged pull request stays in awaiting-review until all are merged), so
// cancelSpec also refuses a spec that has a merged pull request, which is the check that works today.
const NOT_CANCELLABLE = new Set<SpecState>([
  ...TERMINAL_STATES,
  "partially-merged",
]);

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
