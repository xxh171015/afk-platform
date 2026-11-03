import type { BlockedReason } from "@afk/shared";
import { describe, expect, it } from "vitest";
import { structuredBrief } from "./structured-brief.ts";

const source = (
  stage: string,
  output: unknown,
  over: Record<string, unknown> = {},
) => ({
  stage,
  result: null,
  output,
  run: { id: 7, displayId: "R-7" },
  ...over,
});

describe("structuredBrief", () => {
  it("fills summary, step and recommended action from the reason code, without dumping JSON", () => {
    const brief = structuredBrief(
      "agent-gave-up",
      source("implement", {
        status: "cannot-proceed",
        detail: "needs a decision",
      }),
    );
    expect(brief).toEqual({
      reason: "agent-gave-up",
      step: "implement",
      summary: "模型放弃",
      evidence: { lastLogLines: "needs a decision" },
      recommendedAction: "看它卡住的地方，带一句话说明后继续",
    });
    expect(JSON.stringify(brief)).not.toContain("cannot-proceed");
  });

  it("omits evidence keys that have no value", () => {
    expect(
      structuredBrief("timeout", source("implement", null)).evidence,
    ).toEqual({});
  });

  it("takes failing tests, command, conflict files and findings when they are present", () => {
    expect(
      structuredBrief(
        "gate-failed",
        source("gate", {
          failureLog: "# test failed\nboom",
          reasons: ["test failed (exit 1)"],
          failingTests: ["exports csv"],
        }),
      ).evidence,
    ).toEqual({
      failingTests: ["exports csv"],
      command: "test failed (exit 1)",
      lastLogLines: "# test failed\nboom",
    });
    expect(
      structuredBrief(
        "merge-conflict",
        source("merge", {
          failureLog: "# merge conflict\n\n- src/a.ts\n- src/b.ts\n",
        }),
      ).evidence,
    ).toEqual({
      lastLogLines: "# merge conflict\n\n- src/a.ts\n- src/b.ts\n",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(
      structuredBrief(
        "protected-path-changed",
        source("gate", { unapproved: [".github/ci.yml"] }),
      ).evidence,
    ).toEqual({ lastLogLines: ".github/ci.yml" });
    expect(
      structuredBrief("agent-gave-up", source("review", { findings: [{}, {}] }))
        .evidence,
    ).toEqual({ findingsCount: 2 });
  });

  it("picks failing tests off an integration diagnosis when the output has none", () => {
    expect(
      structuredBrief(
        "integration-loop-exceeded",
        source("e2e", null, {
          attempts: [
            {
              diagnosis: {
                failingTests: ["downloads the export"],
                evidence: "GET /orders 404",
              },
            },
          ],
        }),
      ).evidence,
    ).toEqual({
      failingTests: ["downloads the export"],
      lastLogLines: "GET /orders 404",
    });
  });

  it("covers every blocked reason with a Chinese recommended action", () => {
    const reasons: BlockedReason[] = [
      "gate-failed",
      "post-merge-gate-failed",
      "merge-conflict",
      "protected-path-changed",
      "contract-copy-mismatch",
      "no-commits",
      "agent-gave-up",
      "contract-change-needed",
      "invalid-output",
      "timeout",
      "integration-loop-exceeded",
      "integration-unknown-side",
      "integration-environment-failed",
      "upstream-cancelled",
      "job-failed",
    ];
    for (const reason of reasons) {
      const brief = structuredBrief(reason, source("implement", null));
      expect(brief.reason).toBe(reason);
      expect(brief.recommendedAction.length).toBeGreaterThan(0);
      expect(brief.summary.length).toBeGreaterThan(0);
    }
  });
});
