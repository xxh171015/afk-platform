import { describe, expect, it } from "vitest";
import {
  advanceStage,
  type Progress,
  STAGES,
  type StageReport,
} from "./stage-flow.ts";
import { noFixes } from "./ticket-fixes.ts";
import { ticketTransition } from "./ticket-state.ts";

const fresh: Progress = { fixCounts: noFixes(), reviewed: false };
const used = (...kinds: (keyof Progress["fixCounts"])[]): Progress => {
  const fixCounts = noFixes();
  for (const kind of kinds) fixCounts[kind] = 1;
  return { fixCounts, reviewed: false };
};
// a ticket whose one automatic retry is spent: timeout and invalid-output block it
const retried: Progress = { ...fresh, autoRetried: true };
const reviewed = (progress: Progress): Progress => ({
  ...progress,
  reviewed: true,
});

const enqueue = (stage: string, event?: string) =>
  expect.objectContaining({
    type: "enqueue",
    stage,
    ...(event ? { event: { type: event } } : {}),
  });
const enqueueBoth = expect.objectContaining({
  type: "enqueue-both",
  stages: ["gate", "review"],
});
const waiting = expect.objectContaining({ type: "wait" });
const block = (reason: string) => ({ type: "block", reason });
const running = (
  progress: Progress,
  extra: Partial<Progress> = {},
): Progress => ({
  ...progress,
  parallelReview: "running",
  ...extra,
});
const SHA = "sha-gate";
const OTHER = "sha-other";
const gatePassed = (sha?: string) => ({
  stage: "gate" as const,
  outcome: "passed" as const,
  ...(sha ? { commitSha: sha } : {}),
});
const reviewAt = (outcome: "pass" | "fix", sha?: string) => ({
  stage: "review" as const,
  outcome,
  ...(sha ? { commitSha: sha } : {}),
});

describe("the happy path", () => {
  it("implement -> gate -> review -> merge -> done", () => {
    expect(
      advanceStage({ stage: "implement", outcome: "done" }, fresh),
    ).toEqual(enqueueBoth);
    expect(advanceStage({ stage: "gate", outcome: "passed" }, fresh)).toEqual(
      enqueue("review"),
    );
    const afterReview = advanceStage(
      { stage: "review", outcome: "pass" },
      fresh,
    );
    expect(afterReview).toEqual(enqueue("merge", "checks-passed"));
    expect(afterReview).toMatchObject({ progress: { reviewed: true } });
    expect(
      advanceStage({ stage: "merge", outcome: "merged" }, reviewed(fresh)),
    ).toEqual({
      type: "done",
    });
  });

  it("goes straight from the gate to merge once the ticket was reviewed", () => {
    expect(
      advanceStage({ stage: "gate", outcome: "passed" }, reviewed(fresh)),
    ).toEqual(enqueue("merge", "checks-passed"));
  });

  it("runs Recheck before merge when a post-review change hit existing tests or config", () => {
    expect(
      advanceStage(
        { stage: "gate", outcome: "passed" },
        { ...reviewed(fresh), recheckPending: true },
      ),
    ).toEqual(enqueue("recheck"));
    expect(
      advanceStage({ stage: "recheck", outcome: "pass" }, reviewed(fresh)),
    ).toEqual(enqueue("merge", "checks-passed"));
    expect(
      advanceStage({ stage: "recheck", outcome: "fix" }, reviewed(fresh)),
    ).toEqual(block("recheck-failed"));
  });
});

describe("blocking after an agent run", () => {
  const agentStages = [
    "implement",
    "gate-fix",
    "review-fix",
    "merge-fix",
  ] as const;
  const outcomes = [
    "invalid-output",
    "no-commits",
    "timeout",
    "agent-gave-up",
    "contract-change-needed",
  ] as const;
  for (const stage of agentStages) {
    for (const outcome of outcomes) {
      it(`${stage} reporting ${outcome} blocks with that reason`, () => {
        expect(advanceStage({ stage, outcome }, retried)).toEqual(
          block(outcome),
        );
      });
    }
    it(`${stage} reporting done goes to the gate`, () => {
      expect(advanceStage({ stage, outcome: "done" }, fresh)).toEqual(
        enqueueBoth,
      );
    });
  }
});

describe("the gate", () => {
  it("blocks on an unapproved protected path without a fix", () => {
    expect(
      advanceStage({ stage: "gate", outcome: "protected-path-changed" }, fresh),
    ).toEqual(block("protected-path-changed"));
  });

  it("blocks on a contract copy that differs without a fix", () => {
    expect(
      advanceStage({ stage: "gate", outcome: "contract-copy-mismatch" }, fresh),
    ).toEqual(block("contract-copy-mismatch"));
  });

  it("blocks on removed tests without spending a gate-fix", () => {
    expect(
      advanceStage({ stage: "gate", outcome: "tests-removed" }, fresh),
    ).toEqual(block("tests-removed"));
  });

  it("runs gate-fix once, then blocks gate-failed", () => {
    const first = advanceStage({ stage: "gate", outcome: "failed" }, fresh);
    expect(first).toEqual(enqueue("gate-fix"));
    expect(first).toMatchObject({ progress: { fixCounts: { "gate-fix": 1 } } });
    expect(
      advanceStage({ stage: "gate", outcome: "failed" }, used("gate-fix")),
    ).toEqual(block("gate-failed"));
  });

  it("allows gate-fix after a review-fix or merge-fix, each fix kind has its own budget", () => {
    expect(
      advanceStage({ stage: "gate", outcome: "failed" }, used("review-fix")),
    ).toEqual(enqueue("gate-fix"));
    expect(
      advanceStage({ stage: "gate", outcome: "failed" }, used("merge-fix")),
    ).toEqual(enqueue("gate-fix"));
  });
});

describe("review", () => {
  it("a fix verdict runs review-fix and marks the ticket reviewed", () => {
    const decision = advanceStage({ stage: "review", outcome: "fix" }, fresh);
    expect(decision).toEqual(enqueue("review-fix"));
    expect(decision).toMatchObject({
      progress: { reviewed: true, fixCounts: { "review-fix": 1 } },
    });
  });

  it("after the review-fix the gate passes straight to merge: no second review", () => {
    const afterFix = reviewed(used("review-fix"));
    expect(
      advanceStage({ stage: "gate", outcome: "passed" }, afterFix),
    ).toEqual(enqueue("merge", "checks-passed"));
  });

  it("blocks on unusable review output or a timeout", () => {
    expect(
      advanceStage({ stage: "review", outcome: "invalid-output" }, retried),
    ).toEqual(block("invalid-output"));
    expect(
      advanceStage({ stage: "review", outcome: "timeout" }, retried),
    ).toEqual(block("timeout"));
  });
});

describe("merge", () => {
  it("a conflict runs merge-fix (ticket back to running), then blocks merge-conflict", () => {
    const first = advanceStage(
      { stage: "merge", outcome: "conflict" },
      reviewed(fresh),
    );
    expect(first).toEqual(enqueue("merge-fix", "merge-fix-needed"));
    expect(first).toMatchObject({
      progress: { fixCounts: { "merge-fix": 1 } },
    });
    expect(
      advanceStage(
        { stage: "merge", outcome: "conflict" },
        reviewed(used("merge-fix")),
      ),
    ).toEqual(block("merge-conflict"));
  });

  it("a failed candidate gate also runs merge-fix once, then blocks post-merge-gate-failed", () => {
    expect(
      advanceStage({ stage: "merge", outcome: "gate-failed" }, reviewed(fresh)),
    ).toEqual(enqueue("merge-fix", "merge-fix-needed"));
    expect(
      advanceStage(
        { stage: "merge", outcome: "gate-failed" },
        reviewed(used("merge-fix")),
      ),
    ).toEqual(block("post-merge-gate-failed"));
  });

  it("blocks on removed tests without spending a merge-fix", () => {
    expect(
      advanceStage(
        { stage: "merge", outcome: "tests-removed" },
        reviewed(fresh),
      ),
    ).toEqual(block("tests-removed"));
  });

  it("merge-fix shares the budget between conflicts and candidate gate failures", () => {
    expect(
      advanceStage(
        { stage: "merge", outcome: "gate-failed" },
        reviewed(used("merge-fix")),
      ),
    ).toEqual(block("post-merge-gate-failed"));
  });
});

describe("a worst-case ticket", () => {
  it("uses at most five agent runs and every decision is a legal ticket transition", () => {
    // implement, gate-fix, review, review-fix, merge-fix
    const reports: StageReport[] = [
      { stage: "implement", outcome: "done" },
      { stage: "gate", outcome: "failed" },
      { stage: "gate-fix", outcome: "done" },
      { stage: "gate", outcome: "passed" },
      { stage: "review", outcome: "fix" },
      { stage: "review-fix", outcome: "done" },
      { stage: "gate", outcome: "passed" },
      { stage: "merge", outcome: "conflict" },
      { stage: "merge-fix", outcome: "done" },
      { stage: "gate", outcome: "passed" },
      { stage: "merge", outcome: "merged" },
    ];
    let progress = fresh;
    let state: "running" | "merging" | "done" = "running";
    const agentStages = new Set([
      "implement",
      "review",
      "gate-fix",
      "review-fix",
      "merge-fix",
      "e2e",
    ]);
    let agentRuns = 0;
    for (const report of reports) {
      if (agentStages.has(report.stage)) agentRuns += 1;
      const decision = advanceStage(report, progress);
      if (decision.type === "block")
        throw new Error(`blocked: ${decision.reason}`);
      if (decision.type === "await-fix") throw new Error("unexpected fix wait");
      if (decision.type === "enqueue-both" || decision.type === "wait") {
        progress = decision.progress;
        continue;
      }
      if (decision.type === "done") {
        const next = ticketTransition(state, { type: "merge-succeeded" });
        expect(next).toMatchObject({ ok: true, state: "done" });
        if (next.ok) state = next.state as typeof state;
        continue;
      }
      progress = decision.progress;
      if (decision.event) {
        const next = ticketTransition(state, decision.event);
        expect(next.ok).toBe(true);
        if (next.ok) state = next.state as typeof state;
      }
    }
    expect(agentRuns).toBe(5);
    expect(state).toBe("done");
  });
});

describe("shape", () => {
  it("knows every stage", () => {
    expect([...STAGES]).toEqual([
      "implement",
      "gate",
      "review",
      "merge",
      "gate-fix",
      "review-fix",
      "merge-fix",
      "recheck",
      "e2e",
      "diagnose",
    ]);
  });
});

describe("an integration ticket", () => {
  const merged = { stage: "merge", outcome: "merged" } as const;

  it("goes from merge to e2e instead of done, and stays merging", () => {
    const decision = advanceStage(merged, reviewed(fresh), "integration");
    expect(decision).toEqual(enqueue("e2e"));
    expect(decision).not.toHaveProperty("event");
  });

  it("is done when e2e passes", () => {
    expect(
      advanceStage(
        { stage: "e2e", outcome: "passed" },
        reviewed(fresh),
        "integration",
      ),
    ).toEqual({ type: "done" });
  });

  it("is diagnosed when e2e fails, and stays merging", () => {
    const decision = advanceStage(
      { stage: "e2e", outcome: "failed" },
      reviewed(fresh),
      "integration",
    );
    expect(decision).toEqual(enqueue("diagnose"));
    expect(decision).not.toHaveProperty("event");
  });

  it("waits for a fix ticket after a diagnosis, and counts the round", () => {
    expect(
      advanceStage(
        { stage: "diagnose", outcome: "diagnosed" },
        { ...reviewed(fresh), integrationRounds: 1 },
        "integration",
      ),
    ).toEqual({
      type: "await-fix",
      progress: { ...reviewed(fresh), integrationRounds: 2 },
    });
  });

  it("is blocked as integration-loop-exceeded at the third failure, without a diagnosis", () => {
    expect(
      advanceStage(
        { stage: "e2e", outcome: "failed" },
        { ...reviewed(fresh), integrationRounds: 2 },
        "integration",
      ),
    ).toEqual(block("integration-loop-exceeded"));
  });

  it.each([
    ["unknown-side", "integration-unknown-side"],
    ["invalid-output", "invalid-output"],
    ["timeout", "timeout"],
  ] as const)("is blocked when the diagnosis is %s", (outcome, reason) => {
    expect(
      advanceStage({ stage: "diagnose", outcome }, retried, "integration"),
    ).toEqual(block(reason));
  });

  it("other ticket types are done at merge", () => {
    for (const type of ["implementation", "contract", "fix"]) {
      expect(advanceStage(merged, reviewed(fresh), type)).toEqual({
        type: "done",
      });
    }
  });
});

describe("one automatic retry of an agent stage that timed out or gave no result", () => {
  const retryable = [
    "implement",
    "gate-fix",
    "review-fix",
    "merge-fix",
    "review",
    "recheck",
    "diagnose",
  ] as const;
  for (const stage of retryable) {
    for (const outcome of ["timeout", "invalid-output"] as const) {
      it(`runs ${stage} again once after ${outcome}, and spends the retry`, () => {
        const progress = { ...reviewed(fresh), recheckPending: true };
        expect(
          advanceStage({ stage, outcome } as StageReport, progress),
        ).toEqual({
          type: "enqueue",
          stage,
          autoRetry: outcome,
          progress: { ...progress, autoRetried: true },
        });
      });
    }
  }

  it("blocks a recheck that timed out again as recheck-failed, as before", () => {
    expect(
      advanceStage({ stage: "recheck", outcome: "timeout" }, retried),
    ).toEqual(block("recheck-failed"));
  });

  it.each(["no-commits", "agent-gave-up", "contract-change-needed"] as const)(
    "does not retry %s: a person decides",
    (outcome) => {
      expect(advanceStage({ stage: "implement", outcome }, fresh)).toEqual(
        block(outcome),
      );
    },
  );

  it("does not retry a recheck that wants a fix", () => {
    expect(
      advanceStage({ stage: "recheck", outcome: "fix" }, reviewed(fresh)),
    ).toEqual(block("recheck-failed"));
  });

  it("keeps the spent retry through the stages that follow", () => {
    const decision = advanceStage(
      { stage: "implement", outcome: "done" },
      retried,
    );
    expect(decision).toEqual(
      expect.objectContaining({
        progress: expect.objectContaining({ autoRetried: true }),
      }),
    );
  });
});

describe("gate and review in parallel", () => {
  it("implement done dispatches gate and review together and marks review running", () => {
    const decision = advanceStage(
      { stage: "implement", outcome: "done" },
      fresh,
    );
    expect(decision).toEqual(enqueueBoth);
    expect(decision).toMatchObject({ progress: { parallelReview: "running" } });
  });

  it("gate-fix done also dispatches both while the ticket is unreviewed", () => {
    expect(
      advanceStage({ stage: "gate-fix", outcome: "done" }, used("gate-fix")),
    ).toEqual(enqueueBoth);
  });

  it("a gate pass while review is still running waits and records the passed commit", () => {
    const decision = advanceStage(gatePassed(SHA), running(fresh));
    expect(decision).toEqual(waiting);
    expect(decision).toMatchObject({
      progress: { parallelReview: "running", gatePassedSha: SHA },
    });
  });

  it("a review pass while the gate is still running waits and records the conclusion", () => {
    const decision = advanceStage(reviewAt("pass", SHA), running(fresh));
    expect(decision).toEqual(waiting);
    expect(decision).toMatchObject({
      progress: { parallelReview: "pass", parallelReviewSha: SHA },
    });
  });

  it("a review fix while the gate is still running waits and records the conclusion", () => {
    const decision = advanceStage(reviewAt("fix", SHA), running(fresh));
    expect(decision).toEqual(waiting);
    expect(decision).toMatchObject({
      progress: { parallelReview: "fix", parallelReviewSha: SHA },
    });
  });

  it("gate pass then review pass of the same commit goes to merge and marks the ticket reviewed", () => {
    const afterGate = advanceStage(gatePassed(SHA), running(fresh));
    expect(afterGate.type).toBe("wait");
    const decision = advanceStage(
      reviewAt("pass", SHA),
      (afterGate as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("merge", "checks-passed"));
    expect(decision).toMatchObject({ progress: { reviewed: true } });
  });

  it("gate pass then review fix of the same commit spends review-fix", () => {
    const afterGate = advanceStage(gatePassed(SHA), running(fresh));
    const decision = advanceStage(
      reviewAt("fix", SHA),
      (afterGate as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("review-fix"));
    expect(decision).toMatchObject({
      progress: { reviewed: true, fixCounts: { "review-fix": 1 } },
    });
  });

  it("review pass then gate pass of the same commit goes to merge and marks the ticket reviewed", () => {
    const afterReview = advanceStage(reviewAt("pass", SHA), running(fresh));
    const decision = advanceStage(
      gatePassed(SHA),
      (afterReview as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("merge", "checks-passed"));
    expect(decision).toMatchObject({ progress: { reviewed: true } });
  });

  it("review fix then gate pass of the same commit spends review-fix", () => {
    const afterReview = advanceStage(reviewAt("fix", SHA), running(fresh));
    const decision = advanceStage(
      gatePassed(SHA),
      (afterReview as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("review-fix"));
    expect(decision).toMatchObject({
      progress: { reviewed: true, fixCounts: { "review-fix": 1 } },
    });
  });

  it("a failed gate while review is running clears the parallel review and spends gate-fix", () => {
    const decision = advanceStage(
      { stage: "gate", outcome: "failed" },
      running(fresh),
    );
    expect(decision).toEqual(enqueue("gate-fix"));
    expect(decision).toMatchObject({
      progress: { fixCounts: { "gate-fix": 1 } },
    });
    expect(
      (decision as { progress: Progress }).progress.parallelReview,
    ).toBeUndefined();
  });

  it("a failed gate while review already concluded still clears that conclusion and spends gate-fix", () => {
    const decision = advanceStage(
      { stage: "gate", outcome: "failed" },
      {
        ...fresh,
        parallelReview: "pass",
        parallelReviewSha: SHA,
      },
    );
    expect(decision).toEqual(enqueue("gate-fix"));
    expect(
      (decision as { progress: Progress }).progress.parallelReview,
    ).toBeUndefined();
  });

  it.each([
    "protected-path-changed",
    "contract-copy-mismatch",
    "tests-removed",
  ] as const)(
    "a %s gate while review is running clears the parallel review",
    (outcome) => {
      const decision = advanceStage({ stage: "gate", outcome }, running(fresh));
      expect(decision).toEqual(block(outcome));
    },
  );

  it("invalid-output on a parallel review retries only review and keeps it running", () => {
    const decision = advanceStage(
      { stage: "review", outcome: "invalid-output" },
      running(fresh),
    );
    expect(decision).toEqual({
      type: "enqueue",
      stage: "review",
      autoRetry: "invalid-output",
      progress: { ...running(fresh), autoRetried: true },
    });
  });

  it("joins when one side did not name a commit", () => {
    const afterGate = advanceStage(gatePassed(SHA), running(fresh));
    const decision = advanceStage(
      { stage: "review", outcome: "pass" },
      (afterGate as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("merge", "checks-passed"));
  });

  it("drops a review of a different commit than the one that passed the gate and dispatches review again", () => {
    const afterGate = advanceStage(gatePassed(SHA), running(fresh));
    const decision = advanceStage(
      reviewAt("pass", OTHER),
      (afterGate as { progress: Progress }).progress,
    );
    expect(decision).toEqual(enqueue("review"));
    expect(decision).toMatchObject({
      progress: {
        parallelReview: "running",
        gatePassedSha: SHA,
        reviewed: false,
      },
    });
  });

  it("reviewed tickets only dispatch the gate after review-fix or merge-fix", () => {
    expect(
      advanceStage(
        { stage: "review-fix", outcome: "done" },
        reviewed(used("review-fix")),
      ),
    ).toEqual(enqueue("gate"));
    expect(
      advanceStage(
        { stage: "merge-fix", outcome: "done" },
        reviewed(used("merge-fix")),
      ),
    ).toEqual(enqueue("gate"));
    expect(advanceStage(gatePassed(SHA), reviewed(fresh))).toEqual(
      enqueue("merge", "checks-passed"),
    );
  });
});
