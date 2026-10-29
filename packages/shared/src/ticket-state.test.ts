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
    ["running", "integration-loop-exceeded"],
    ["merging", "invalid-output"],
    ["merging", "timeout"],
    ["running", "job-failed"],
    ["merging", "job-failed"],
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

  it("approving protected path changes sends a blocked ticket on to running, and only a blocked one", () => {
    expect(ticketTransition("blocked", { type: "approve-protected" })).toEqual({
      ok: true,
      state: "running",
    });
    for (const from of [
      "pending",
      "queued",
      "running",
      "merging",
      "done",
      "cancelled",
    ] as const) {
      expect(ticketTransition(from, { type: "approve-protected" }).ok).toBe(
        false,
      );
    }
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

describe("ticketTransition: the spec is cancelled", () => {
  it.each(["pending", "queued", "running", "merging", "blocked"] as const)(
    "a ticket that is %s is cancelled with its spec",
    (from) => {
      expect(ticketTransition(from, { type: "spec-cancelled" })).toEqual({
        ok: true,
        state: "cancelled",
      });
    },
  );

  it.each(["done", "cancelled"] as const)(
    "a %s ticket stays as it is",
    (from) => {
      expect(ticketTransition(from, { type: "spec-cancelled" }).ok).toBe(false);
    },
  );
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
    ["merging", { type: "block", reason: "integration-loop-exceeded" }],
    ["running", { type: "block", reason: "post-merge-gate-failed" }],
    ["running", { type: "block", reason: "upstream-cancelled" }],
  ] as const)("%s rejects %j", (from, event) => {
    expect(ticketTransition(from, event).ok).toBe(false);
  });
});
