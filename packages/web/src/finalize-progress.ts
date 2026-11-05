import { FINAL_STEPS } from "@afk/shared";

// Where each repo's finishing stands, step by step, so the delivery tab can show it without opening a Run.

export interface FinalStepRow {
  repo: string;
  step: string;
  state: string; // active | blocked | done
  blockedReason: string | null;
}

export interface FinalRunRow {
  id: number;
  displayId: string;
  repo: string;
  stage: string;
  axis: string | null;
  result: string | null; // null while the Run is going
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type FinalStepStatus =
  | "waiting" // not reached yet
  | "queued" // the current step, no Run started yet
  | "running"
  | "blocked"
  | "done"
  | "skipped"; // finishing went past it, or ended before it, without needing it

export interface FinalStepProgress {
  step: string;
  status: FinalStepStatus;
  result: string | null; // what the step's last Runs came to, when it is done
  blockedReason: string | null;
}

export interface RepoFinalProgress {
  repo: string;
  status: "queued" | "running" | "blocked" | "done";
  steps: FinalStepProgress[];
  running: FinalRunRow[];
  runs: FinalRunRow[];
}

// The finish e2e is one step for the whole spec; its Runs belong to whichever repo held the integration ticket.
const INTEGRATION = "(integration)";
const E2E = "final-e2e";

export function finalizeProgress(
  stepRows: readonly FinalStepRow[],
  runRows: readonly FinalRunRow[],
): RepoFinalProgress[] {
  const repos = [
    ...stepRows.map((row) => row.repo),
    ...runRows.map((run) => (run.stage === E2E ? INTEGRATION : run.repo)),
  ].filter((name, index, all) => all.indexOf(name) === index);
  return repos.map((repo) => {
    const current = stepRows.find((row) => row.repo === repo);
    const runs = runRows.filter((run) =>
      repo === INTEGRATION
        ? run.stage === E2E
        : run.repo === repo && run.stage !== E2E,
    );
    const order: readonly string[] = repo === INTEGRATION ? [E2E] : FINAL_STEPS;
    const at = current ? order.indexOf(current.step) : -1;
    const steps = order.map((step, index) =>
      stepProgress(
        step,
        index,
        at,
        current,
        runs.filter((run) => run.stage === step),
      ),
    );
    const running = runs.filter((run) => run.result === null);
    return {
      repo,
      status:
        running.length > 0
          ? "running"
          : current?.state === "blocked"
            ? "blocked"
            : current?.state === "done"
              ? "done"
              : "queued",
      steps,
      running,
      runs,
    };
  });
}

function stepProgress(
  step: string,
  index: number,
  at: number,
  current: FinalStepRow | undefined,
  runs: FinalRunRow[],
): FinalStepProgress {
  const latest = latestPerAxis(runs);
  const base = { step, result: null, blockedReason: null };
  if (latest.some((run) => run.result === null))
    return { ...base, status: "running" };
  if (index === at && current?.state === "blocked")
    return {
      ...base,
      status: "blocked",
      blockedReason: current.blockedReason,
    };
  if (index === at && current?.state === "active")
    return { ...base, status: "queued" };
  if (latest.length > 0)
    return { ...base, status: "done", result: stepResult(latest) };
  if (index < at || current?.state === "done")
    return { ...base, status: "skipped" };
  return { ...base, status: "waiting" };
}

// A step tried again keeps only its last Run of each review axis.
function latestPerAxis(runs: FinalRunRow[]): FinalRunRow[] {
  const byAxis = new Map<string, FinalRunRow>();
  for (const run of runs) byAxis.set(run.axis ?? "", run);
  return [...byAxis.values()];
}

// A review asks for a fix when any axis does.
function stepResult(latest: FinalRunRow[]): string | null {
  const results = latest.map((run) => run.result as string);
  return results.find((result) => result !== "pass") ?? results[0] ?? null;
}

// How long a Run took, or has been going for.
export function runElapsedMs(run: FinalRunRow, now: number): number | null {
  if (run.durationMs !== null) return run.durationMs;
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, end - Date.parse(run.startedAt));
}
