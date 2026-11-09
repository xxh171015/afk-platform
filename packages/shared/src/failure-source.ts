import { BLOCKED_REASONS } from "./ticket-state.ts";

// Whose fault a failure or a block is (GLOSSARY Failure source), decided by its reason code when it happens and
// never changed afterwards (docs/specs/m3-platform.md「失败来源」). Events store it; the waiting queue groups by it.

export const FAILURE_SOURCES = [
  "platform",
  "external",
  "agent",
  "spec",
] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

// The final e2e before the pull requests failed (finalize/final-e2e.ts).
export const FINAL_E2E_FAILED = "final-e2e-failed";

// Why the final e2e step is blocked: its e2e failed, or its environment would not come up three times over.
export const FINAL_E2E_BLOCKED_REASONS = [
  FINAL_E2E_FAILED,
  "integration-environment-failed",
] as const;

// Why the platform paused a spec.
export const PAUSE_REASONS = [
  "budget-exhausted",
  "update-branch-conflict",
  "update-branch-gate-failed",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  "budget-exhausted": "agent 时间用完",
  "update-branch-conflict": "合 main 有冲突",
  "update-branch-gate-failed": "合 main 后门禁失败",
};

export function pauseReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "已暂停";
  return (PAUSE_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

export const REASON_CODES = [
  ...BLOCKED_REASONS,
  FINAL_E2E_FAILED,
  ...PAUSE_REASONS,
  // the planning docs patch did not apply to the planning repo's default branch
  "planning-conflict",
  // a worker's lease on a job ran out and the job went back to the queue (the worker died or hung)
  "lease-expired",
  // host-sync could not read a pull request from the code host
  "sync-error",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// null: not counted against anyone (the ticket went with the one it waited for).
// job-failed is the platform's unless its error names a known outside service (failureSourceOf).
export const FAILURE_SOURCE_OF_REASON: Record<
  ReasonCode,
  FailureSource | null
> = {
  "invalid-output": "agent",
  "no-commits": "agent",
  "agent-gave-up": "agent",
  timeout: "agent",
  "gate-failed": "agent",
  "post-merge-gate-failed": "agent",
  "integration-loop-exceeded": "agent",
  "integration-unknown-side": "agent",
  "final-e2e-failed": "agent",
  "budget-exhausted": "agent",
  "merge-conflict": "spec",
  "protected-path-changed": "spec",
  "contract-copy-mismatch": "spec",
  "contract-change-needed": "spec",
  "integration-environment-failed": "spec",
  "update-branch-conflict": "spec",
  "update-branch-gate-failed": "spec",
  "planning-conflict": "spec",
  "job-failed": "platform",
  "lease-expired": "platform",
  "sync-error": "external",
  "upstream-cancelled": null,
};

// Signs in a failed job's error that an outside service let it down: Cursor's login or rate limit, a 5xx from the
// code host, a package registry or image registry that could not be reached. Matched case-insensitively. Written so
// JavaScript and Postgres (~*) read them alike: the events trigger matches the same list (drizzle/0035_events.sql).
export const EXTERNAL_ERROR_PATTERNS = [
  "(github|gitlab).*(answered |http |[(])5[0-9][0-9]([^0-9]|$)",
  "authentication required|not authenticated|cursor-agent login|unauthorized",
  "rate.?limit|too many requests|usage limit|http 429",
  "enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake timeout",
  "err_pnpm_meta_fetch_fail|registry\\.npmjs\\.org|registry\\.npmmirror\\.com",
] as const;

const EXTERNAL = EXTERNAL_ERROR_PATTERNS.map(
  (pattern) => new RegExp(pattern, "i"),
);

export function failureSourceOf(
  reason: string,
  error?: string | null,
): FailureSource | null {
  const source = (
    FAILURE_SOURCE_OF_REASON as Record<string, FailureSource | null>
  )[reason];
  if (source === undefined) return "platform";
  if (reason === "job-failed" && error && EXTERNAL.some((re) => re.test(error)))
    return "external";
  return source;
}

// The platform's own problems and outside services' are listed after the specs' own in the waiting queue, as a
// group of their own: a person looks at what their spec needs first.
export const isPlatformProblem = (source: FailureSource | null | undefined) =>
  source === "platform" || source === "external";

// Who made a change an event records (the events table's source).
export const EVENT_SOURCES = [
  "scheduler",
  "worker",
  "host-sync",
  "page",
  "cli",
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

// What an event is about: the state of a spec, its planning commit, a ticket, a job, an overall review step, the
// final e2e, or a pull request (its state, draft, CI, review, and whether host-sync can read it).
export const EVENT_TYPES = [
  "spec",
  "planning",
  "ticket",
  "job",
  "finalization",
  "final-e2e",
  "pull-request",
  "pull-request-draft",
  "pull-request-ci",
  "pull-request-review",
  "pull-request-sync",
  // a person's action (HUMAN_ACTIONS), written by the action's code
  "action",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// What a person can do from the page or with plat; each is an event of type action.
export const HUMAN_ACTIONS = [
  "confirm",
  "retry",
  "approve-protected",
  "allow-paths",
  "edit-ticket",
  "cancel-ticket",
  "allow",
  "cancel-spec",
  "retry-final",
  "waive-final",
  "retry-cleanup",
  "retry-planning",
  "waive-planning",
] as const;
export type HumanAction = (typeof HUMAN_ACTIONS)[number];
