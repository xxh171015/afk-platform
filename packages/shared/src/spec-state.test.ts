import { describe, expect, it } from "vitest";
import { specTransition } from "./spec-state.ts";

describe("specTransition: forward path", () => {
  it.each([
    ["draft", "confirm-plan", "planned"],
    ["planned", "start", "running"],
    ["running", "all-tickets-done", "finalizing"],
    ["finalizing", "pr-opened", "awaiting-review"],
    ["awaiting-review", "some-prs-merged", "partially-merged"],
    ["awaiting-review", "all-prs-merged", "merged"],
    ["partially-merged", "all-prs-merged", "merged"],
  ] as const)("%s --%s--> %s", (from, event, to) => {
    expect(specTransition(from, event)).toEqual({ ok: true, state: to });
  });
});

describe("specTransition: pause, resume, cancel", () => {
  it("pauses a running spec and resumes it to running", () => {
    expect(specTransition("running", "pause")).toEqual({
      ok: true,
      state: "paused",
    });
    expect(specTransition("paused", "resume")).toEqual({
      ok: true,
      state: "running",
    });
  });

  it.each([
    "draft",
    "planned",
    "running",
    "finalizing",
    "awaiting-review",
    "partially-merged", // whether it may be, the open pull requests decide (cancelSpec)
    "paused",
    "reworking",
  ] as const)("cancels from %s", (from) => {
    expect(specTransition(from, "cancel")).toEqual({
      ok: true,
      state: "cancelled",
    });
  });

  it.each(["merged", "cancelled"] as const)(
    "cannot cancel a terminal %s spec",
    (from) => {
      expect(specTransition(from, "cancel").ok).toBe(false);
    },
  );
});

describe("specTransition: illegal moves", () => {
  it.each([
    ["draft", "start"],
    ["draft", "pause"],
    ["planned", "all-tickets-done"],
    ["running", "pr-opened"],
    ["running", "resume"],
    ["finalizing", "pause"],
    ["awaiting-review", "start"],
    ["paused", "all-tickets-done"],
    ["merged", "resume"],
    ["cancelled", "resume"],
    ["partially-merged", "some-prs-merged"],
    ["merged", "some-prs-merged"],
    ["reworking", "pr-opened"],
  ] as const)("%s rejects %s", (from, event) => {
    const result = specTransition(from, event);
    expect(result.ok).toBe(false);
  });
});
