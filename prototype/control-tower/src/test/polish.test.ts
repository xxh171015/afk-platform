import { describe, expect, it } from "vitest";
import { absoluteTime, formatDuration, relativeTime } from "@/lib/time";
import { isEditingTarget, shortcutDestination } from "@/lib/keyboard";
import { reasonLabel, specStateLabel, stageLabel, ticketStateLabel } from "@/lib/labels";
import { blockedReasonGuide } from "@/lib/blocked-reasons";

describe("global polish rules", () => {
  it("formats seconds as 12.3 s", () => expect(formatDuration(12300)).toBe("12.3 s"));
  it("formats minutes as 4m 05s", () => expect(formatDuration(245000)).toBe("4m 05s"));
  it("formats hours as 1h 02m", () => expect(formatDuration(3720000)).toBe("1h 02m"));
  it("uses relative dates and absolute UTC timestamps", () => {
    expect(relativeTime("2026-11-01T03:00:00Z", new Date("2026-11-01T03:03:00Z"))).toBe("3 分钟前");
    expect(absoluteTime("2026-11-01T03:00:00Z")).toBe("2026-11-01 03:00:00 UTC");
  });
  it("maps g h, g b and g s only to requested pages", () => {
    expect(shortcutDestination("g", "h")).toBe("/");
    expect(shortcutDestination("g", "b")).toBe("/waiting");
    expect(shortcutDestination("g", "s")).toBe("/specs");
    expect(shortcutDestination("g", "o")).toBeUndefined();
    expect(shortcutDestination("g", "w")).toBeUndefined();
    expect(shortcutDestination("", "s")).toBeUndefined();
  });
  it("does not trigger navigation while editing", () => {
    expect(isEditingTarget(document.createElement("input"))).toBe(true);
    expect(isEditingTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditingTarget(document.createElement("div"))).toBe(false);
  });
  it("retains exactly the original Spec and Ticket states", () => {
    expect(Object.keys(specStateLabel).sort()).toEqual(["draft", "planned", "running", "finalizing", "awaiting-review", "partially-merged", "reworking", "merged", "paused", "cancelled"].sort());
    expect(Object.keys(ticketStateLabel).sort()).toEqual(["pending", "queued", "running", "merging", "done", "blocked", "cancelled"].sort());
  });
  it("retains exactly the original blocked reasons and stages", () => {
    const reasons = ["gate-failed", "post-merge-gate-failed", "merge-conflict", "protected-path-changed", "contract-copy-mismatch", "no-commits", "agent-gave-up", "contract-change-needed", "invalid-output", "timeout", "integration-loop-exceeded", "integration-unknown-side", "integration-environment-failed", "upstream-cancelled", "job-failed"].sort();
    expect(Object.keys(reasonLabel).sort()).toEqual(reasons);
    expect(Object.keys(blockedReasonGuide).sort()).toEqual(reasons);
    expect(Object.keys(stageLabel).sort()).toEqual(["implement", "gate", "review", "merge", "gate-fix", "review-fix", "merge-fix", "e2e", "diagnose", "final-review", "final-fix", "final-merge", "final-e2e"].sort());
  });
});