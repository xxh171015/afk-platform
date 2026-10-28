import { describe, expect, it } from "vitest";
import { ticketTransition } from "./ticket-state.ts";

describe("ticketTransition: forward path", () => {
  it.each([
    ["pending", "enqueue", "queued"],
    ["queued", "claim", "running"],
    ["running", "checks-passed", "merging"],
    ["merging", "merge-succeeded", "done"],
    ["merging", "merge-fix-needed", "running"],
  ] as const)("%s --%s--> %s", (from, event, to) => {
    expect(ticketTransition(from, { type: event })).toEqual({
      ok: true,
      state: to,
    });
  });
});

describe("ticketTransition: blocked, retry, cancel", () => {
  it.each([
    ["running", "gate-failed"],
    ["running", "protected-path-changed"],
    ["running", "no-commits"],
    ["running", "agent-gave-up"],
    ["running", "contract-change-needed"],
    ["running", "invalid-output"],
    ["running", "timeout"],
    ["merging", "merge-conflict"],
    ["merging", "post-merge-gate-failed"],
    ["pending", "upstream-cancelled"],
  ] as const)("%s blocks with %s and keeps the reason", (from, reason) => {
    expect(ticketTransition(from, { type: "block", reason })).toEqual({
      ok: true,
      state: "blocked",
      blockedReason: reason,
    });
  });

  it("a person retrying sends blocked back to pending", () => {
    expect(ticketTransition("blocked", { type: "retry" })).toEqual({
      ok: true,
      state: "pending",
    });
  });

  it.each(["pending", "blocked"] as const)("cancels from %s", (from) => {
    expect(ticketTransition(from, { type: "cancel" })).toEqual({
      ok: true,
      state: "cancelled",
    });
  });
});

describe("ticketTransition: illegal moves", () => {
  it.each([
    ["pending", { type: "claim" }],
    ["pending", { type: "checks-passed" }],
    ["queued", { type: "enqueue" }],
    ["queued", { type: "cancel" }],
    ["running", { type: "merge-succeeded" }],
    ["running", { type: "cancel" }],
    ["running", { type: "retry" }],
    ["merging", { type: "claim" }],
    ["merging", { type: "cancel" }],
    ["blocked", { type: "claim" }],
    ["blocked", { type: "block", reason: "timeout" }],
    ["done", { type: "retry" }],
    ["done", { type: "cancel" }],
    ["done", { type: "block", reason: "gate-failed" }],
    ["cancelled", { type: "retry" }],
    ["cancelled", { type: "enqueue" }],
    ["running", { type: "block", reason: "merge-conflict" }],
    ["merging", { type: "block", reason: "no-commits" }],
    ["pending", { type: "block", reason: "gate-failed" }],
    ["running", { type: "block", reason: "upstream-cancelled" }],
  ] as const)("%s rejects %j", (from, event) => {
    expect(ticketTransition(from, event).ok).toBe(false);
  });
});
