import { describe, expect, it } from "vitest";
import {
  type FinalRunRow,
  finalizeProgress,
  runElapsedMs,
} from "./finalize-progress.ts";

let nextId = 100;
function run(
  repo: string,
  stage: string,
  result: string | null,
  axis: string | null = null,
): FinalRunRow {
  const id = nextId++;
  return {
    id,
    displayId: `R-${id}`,
    repo,
    stage,
    axis,
    result,
    durationMs: result === null ? null : 60_000,
    startedAt: "2026-11-05T05:08:00.000Z",
    finishedAt: result === null ? null : "2026-11-05T05:09:00.000Z",
  };
}

const statuses = (steps: { step: string; status: string }[]) =>
  steps.map((s) => `${s.step}:${s.status}`);

describe("finalizeProgress", () => {
  it("shows a review that passed as done, with the fix and merge-back not needed", () => {
    const [backend] = finalizeProgress(
      [
        {
          repo: "backend",
          step: "final-review",
          state: "done",
          blockedReason: null,
        },
      ],
      [
        run("backend", "final-review", "pass", "standards"),
        run("backend", "final-review", "pass", "spec"),
      ],
    );
    expect(backend?.status).toBe("done");
    expect(statuses(backend?.steps ?? [])).toEqual([
      "final-review:done",
      "final-fix:skipped",
      "recheck:skipped",
      "final-merge:skipped",
    ]);
    expect(backend?.steps[0]?.result).toBe("pass");
  });

  it("shows the step a repo is on as running, with what came before and what is still to come", () => {
    const [frontend] = finalizeProgress(
      [
        {
          repo: "frontend",
          step: "final-fix",
          state: "active",
          blockedReason: null,
        },
      ],
      [
        run("frontend", "final-review", "pass", "standards"),
        run("frontend", "final-review", "fix", "spec"),
        run("frontend", "final-fix", null),
      ],
    );
    expect(frontend?.status).toBe("running");
    expect(statuses(frontend?.steps ?? [])).toEqual([
      "final-review:done",
      "final-fix:running",
      "recheck:waiting",
      "final-merge:waiting",
    ]);
    // a review asks for a fix when either axis does
    expect(frontend?.steps[0]?.result).toBe("fix");
    expect(frontend?.running.map((r) => r.stage)).toEqual(["final-fix"]);
  });

  it("shows a step waiting for a worker as queued, and a blocked one with its reason", () => {
    const [queued, blocked] = finalizeProgress(
      [
        {
          repo: "backend",
          step: "final-review",
          state: "active",
          blockedReason: null,
        },
        {
          repo: "frontend",
          step: "final-merge",
          state: "blocked",
          blockedReason: "merge-conflict",
        },
      ],
      [
        run("frontend", "final-review", "fix", "standards"),
        run("frontend", "final-fix", "done"),
        run("frontend", "final-merge", "conflict"),
      ],
    );
    expect(queued?.status).toBe("queued");
    expect(statuses(queued?.steps ?? [])).toEqual([
      "final-review:queued",
      "final-fix:waiting",
      "recheck:waiting",
      "final-merge:waiting",
    ]);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.steps[3]).toMatchObject({
      status: "blocked",
      blockedReason: "merge-conflict",
    });
  });

  it("counts only the last try of a step", () => {
    const [frontend] = finalizeProgress(
      [
        {
          repo: "frontend",
          step: "final-merge",
          state: "active",
          blockedReason: null,
        },
      ],
      [
        run("frontend", "final-review", "fix", "standards"),
        run("frontend", "final-fix", "done"),
        run("frontend", "final-merge", "conflict"),
        run("frontend", "final-merge", null),
      ],
    );
    expect(frontend?.steps[3]?.status).toBe("running");
  });

  it("puts the finish e2e under the spec's integration, not under the repo that ran it", () => {
    const progress = finalizeProgress(
      [
        {
          repo: "(integration)",
          step: "final-e2e",
          state: "active",
          blockedReason: null,
        },
      ],
      [run("frontend", "final-e2e", null)],
    );
    expect(progress.map((p) => p.repo)).toEqual(["(integration)"]);
    expect(statuses(progress[0]?.steps ?? [])).toEqual(["final-e2e:running"]);
  });
});

describe("runElapsedMs", () => {
  it("is the recorded duration, else the time since the start", () => {
    const now = Date.parse("2026-11-05T05:09:30.000Z");
    expect(runElapsedMs(run("b", "final-merge", "merged"), now)).toBe(60_000);
    expect(runElapsedMs(run("b", "final-merge", null), now)).toBe(90_000);
    expect(
      runElapsedMs({ ...run("b", "final-merge", null), startedAt: null }, now),
    ).toBeNull();
  });
});
