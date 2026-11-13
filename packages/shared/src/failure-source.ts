import { BLOCKED_REASONS } from "./ticket-state.ts";
import { unrecoverableJobError } from "./unrecoverable-job-error.ts";

// Whose fault a failure or a block is (GLOSSARY Failure source), decided by its reason code when it happens and
// never changed afterwards (docs/specs/m3-platform.md「失败来源」). Events store it; the waiting queue groups by it.

export const FAILURE_SOURCES = [
  "platform",
  "external",
  "agent",
  "spec",
] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

export const FAILURE_SOURCE_LABELS: Record<FailureSource, string> = {
  platform: "平台",
  external: "外部服务",
  agent: "agent",
  spec: "需求本身",
};

// The final e2e before the pull requests failed (finalize/final-e2e.ts).
export const FINAL_E2E_FAILED = "final-e2e-failed";

// Why the final e2e step is blocked: its e2e failed, its environment would not come up three times over, or
// an unrecoverable job error (a failed image build, a dead Cursor key) blocked it at once, as on a ticket.
export const FINAL_E2E_BLOCKED_REASONS = [
  FINAL_E2E_FAILED,
  "integration-environment-failed",
  "job-failed",
  "sandbox-oom",
] as const;

// Why the platform paused a spec.
export const PAUSE_REASONS = [
  "budget-exhausted",
  "update-branch-conflict",
  "update-branch-gate-failed",
  "branch-moved",
  "job-failed",
  "tests-removed",
  "recheck-failed",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  "budget-exhausted": "agent 时间用完",
  "update-branch-conflict": "合 main 有冲突",
  "update-branch-gate-failed": "合 main 后门禁失败",
  "branch-moved": "运行期间分支被推过了",
  "job-failed": "作业失败",
  "tests-removed": "删了测试，等人批准",
  "recheck-failed": "Recheck 不是 pass，等人批准",
};

export function pauseReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "已暂停";
  return (PAUSE_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

export const REASON_CODES = [
  ...BLOCKED_REASONS,
  FINAL_E2E_FAILED,
  ...PAUSE_REASONS.filter(
    (reason) => !(BLOCKED_REASONS as readonly string[]).includes(reason),
  ),
  // the planning docs patch did not apply to the planning repo's default branch
  "planning-conflict",
  // a worker's lease on a job ran out and the job went back to the queue (the worker died or hung)
  "lease-expired",
  // host-sync could not read a pull request from the code host
  "sync-error",
  // Locate could not map a bug report onto an original spec
  "bug-unlocated",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// A Locate run on a bug draft: pending while the job is out, found after it filled
// the original spec, failed when a person has to retry or fill the source by hand.
export const LOCATE_STATES = ["pending", "found", "failed"] as const;
export type LocateState = (typeof LOCATE_STATES)[number];

export const LOCATE_REASONS = [
  "bug-unlocated",
  "sandbox-oom",
  "job-failed",
  "invalid-output",
] as const;
export type LocateReason = (typeof LOCATE_REASONS)[number];

export const LOCATE_REASON_LABELS: Record<LocateReason, string> = {
  "bug-unlocated": "未能定位原需求",
  "sandbox-oom": "沙箱内存不足",
  "job-failed": "作业失败",
  "invalid-output": "输出不合法",
};

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
  "tests-removed": "spec",
  "recheck-failed": "spec",
  "contract-copy-mismatch": "spec",
  "contract-change-needed": "spec",
  "integration-environment-failed": "spec",
  "update-branch-conflict": "spec",
  "update-branch-gate-failed": "spec",
  "planning-conflict": "spec",
  "bug-unlocated": "spec",
  "branch-moved": "spec",
  "job-failed": "platform",
  "sandbox-oom": "platform",
  "lease-expired": "platform",
  "sync-error": "external",
  "upstream-cancelled": null,
};

// Signs in a failed job's error that an outside service let it down: Cursor's login or rate limit, a 5xx from the
// code host, a package registry or image registry that could not be reached, a gate setup that ran out of time.
// Matched case-insensitively. Written so JavaScript and Postgres (~*) read them alike: the events trigger matches
// the same list (afk_failure_source, last redefined in the latest drizzle migration that touches it).
export const EXTERNAL_ERROR_PATTERNS = [
  "(github|gitlab).*(answered |http |[(])(401|403|5[0-9][0-9])([^0-9]|$)",
  "authentication required|not authenticated|cursor-agent login|unauthorized|invalid username or token",
  "rate.?limit|too many requests|usage limit|out of usage|increase limits|http 429",
  "enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake",
  "err_pnpm_meta_fetch_fail|registry\\.npmjs\\.org|registry\\.npmmirror\\.com",
  "invalid model|unknown model|model not found|model does not exist|no such model",
  "quota[ _]?(exceeded|exhausted)|insufficient (quota|credits)|resource.?exhausted",
  "docker build of .+ failed",
  // GNU timeout's exit: the gate's setup (installing dependencies, pulling images) ran out of time on the network
  "gate setup failed \\(exit 124\\)",
] as const;

const EXTERNAL = EXTERNAL_ERROR_PATTERNS.map(
  (pattern) => new RegExp(pattern, "i"),
);

export function isSandboxOomError(error: string): boolean {
  return /\bOOMKilled\b|\bsandbox-oom\b/.test(error);
}

export function failureSourceOf(
  reason: string,
  error?: string | null,
): FailureSource | null {
  const source = (
    FAILURE_SOURCE_OF_REASON as Record<string, FailureSource | null>
  )[reason];
  if (source === undefined) return "platform";
  if (
    reason === "job-failed" &&
    error &&
    (EXTERNAL.some((re) => re.test(error)) || unrecoverableJobError(error))
  )
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
  // disk, agent pause, token expiry: inserted on the edge, not by a state trigger (ADR 0009)
  "system",
  // a Locate run found the original spec, or failed to
  "locate",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// What a person can do from the page or with plat; each is an event of type action.
export const HUMAN_ACTIONS = [
  "confirm",
  "retry",
  "approve-protected",
  "approve-removed-tests",
  "approve-recheck",
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
  "retry-locate",
  "takeover",
  "handback",
] as const;
export type HumanAction = (typeof HUMAN_ACTIONS)[number];
