import { describe, expect, it } from "vitest";
import { structuredBrief } from "@/lib/view-map";

describe("structured brief mapping", () => {
  it("maps gate-failed to Chinese conclusion with failing tests and action, not JSON", () => {
    const brief = structuredBrief({
      reason: "gate-failed",
      stage: "gate",
      detail: "AssertionError: expected '201/200' to be '200/200'",
      failingTests: [
        "CheckoutNote.test.tsx › shows counter at limit",
        "CheckoutNote.test.tsx › blocks submit above limit",
      ],
      command: "pnpm vitest run --reporter=dot",
      lastLogLines: "Tests  2 failed | 38 passed",
    });
    expect(brief.reason).toBe("gate-failed");
    expect(brief.step).toBe("gate");
    expect(brief.summary).toBe("门禁失败，agent 已经修过一次（gate-fix），仍然没过。");
    expect(brief.summary.includes("{")).toBe(false);
    expect(brief.evidence).toEqual({
      failingTests: [
        "CheckoutNote.test.tsx › shows counter at limit",
        "CheckoutNote.test.tsx › blocks submit above limit",
      ],
      command: "pnpm vitest run --reporter=dot",
      lastLogLines: "Tests  2 failed | 38 passed",
    });
    expect(brief.evidence).not.toHaveProperty("conflictFiles");
    expect(brief.evidence).not.toHaveProperty("findingsCount");
    expect(brief.recommendedAction).toBe("先看门禁日志确认失败原因，再重试；若是用例本身有误，可改票后从头重试。");
  });

  it("omits empty evidence keys", () => {
    expect(structuredBrief({ reason: "timeout", stage: "implement" }).evidence).toEqual({});
  });

  it("maps protected-path-changed to conflict files without failing tests", () => {
    const brief = structuredBrief({
      reason: "protected-path-changed",
      stage: "review",
      conflictFiles: ["config/security/sensitive-words.yaml", "migrations/**"],
    });
    expect(brief.reason).toBe("protected-path-changed");
    expect(brief.step).toBe("review");
    expect(brief.evidence).toEqual({
      conflictFiles: ["config/security/sensitive-words.yaml", "migrations/**"],
    });
    expect(brief.evidence).not.toHaveProperty("failingTests");
    expect(brief.recommendedAction).toContain("批准");
  });
});