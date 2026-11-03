import { describe, expect, it } from "vitest";
import { TIMELINE_KINDS, visibleTimeline } from "./spec-timeline.ts";

describe("the spec timeline", () => {
  it("keeps only the events the spec named, in the order they arrived", () => {
    const shown = visibleTimeline([
      { kind: "confirm-plan", at: "1" },
      { kind: "job-heartbeat", at: "2" },
      { kind: "gate", at: "3" },
      { kind: "log-chunk", at: "4" },
      { kind: "merged", at: "5" },
    ]);
    expect(shown.map((e) => e.kind)).toEqual([
      "confirm-plan",
      "gate",
      "merged",
    ]);
  });

  it("names every kind the spec listed and no others", () => {
    expect(TIMELINE_KINDS).toEqual([
      "confirm-plan",
      "ticket-start",
      "gate",
      "review",
      "ticket-merge",
      "ticket-blocked",
      "finalization",
      "pr-opened",
      "pr-ready",
      "pack",
      "ticket-appended",
      "pause",
      "resume",
      "merged",
    ]);
  });
});
