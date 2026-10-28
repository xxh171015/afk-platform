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

const TERMINAL = new Set<SpecState>(["merged", "cancelled"]);

export function specTransition(
  from: SpecState,
  event: SpecEvent,
): SpecTransition {
  if (event === "cancel" && !TERMINAL.has(from))
    return { ok: true, state: "cancelled" };
  const state = TRANSITIONS[from]?.[event];
  if (!state)
    return { ok: false, reason: `${event} is not allowed in ${from}` };
  return { ok: true, state };
}
