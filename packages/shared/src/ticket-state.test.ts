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

describe("ticketTransition: an integration ticket around its e2e", () => {
  it("is queued straight into merging to run its e2e again, and goes back to pending to wait for a fix ticket", () => {
    expect(ticketTransition("queued", { type: "resume-e2e" })).toEqual({
      ok: true,
      state: "merging",
    });
    expect(ticketTransition("merging", { type: "await-fix" })).toEqual({
      ok: true,
      state: "pending",
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
    ["merging", "integration-loop-exceeded"],
    ["merging", "integration-unknown-side"],
    ["running", "integration-environment-failed"],
    ["merging", "integration-environment-failed"],
    ["merging", "invalid-output"],
    ["merging", "timeout"],
    ["running", "job-failed"],
    ["merging", "job-failed"],
    ["running", "branch-moved"],
    ["merging", "branch-moved"],
    ["running", "sandbox-oom"],
    ["merging", "sandbox-oom"],
    ["merging", "merge-conflict"],
    ["merging", "post-merge-gate-failed"],
    ["running", "tests-removed"],
    ["merging", "tests-removed"],
    ["running", "recheck-failed"],
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

  it("approving a Recheck sends a blocked ticket on to running, and only a blocked one", () => {
    expect(ticketTransition("blocked", { type: "approve-recheck" })).toEqual({
      ok: true,
      state: "running",
    });
    expect(ticketTransition("running", { type: "approve-recheck" }).ok).toBe(
      false,
    );
  });

  it("approving removed tests sends a blocked ticket on to running, and only a blocked one", () => {
    expect(
      ticketTransition("blocked", { type: "approve-removed-tests" }),
    ).toEqual({
      ok: true,
      state: "running",
    });
    expect(
      ticketTransition("running", { type: "approve-removed-tests" }).ok,
    ).toBe(false);
  });

  it("a person retrying sends blocked back to pending", () => {
    expect(ticketTransition("blocked", { type: "retry" })).toEqual({
      ok: true,
      state: "pending",
    });
  });

  it.each(["pending", "blocked", "taken-over"] as const)(
    "cancels from %s",
    (from) => {
      expect(ticketTransition(from, { type: "cancel" })).toEqual({
        ok: true,
        state: "cancelled",
      });
    },
  );
});

describe("ticketTransition: a person takes the ticket over and hands it back", () => {
  it.each(["pending", "queued", "running", "merging", "blocked"] as const)(
    "%s can be taken over",
    (from) => {
      expect(ticketTransition(from, { type: "takeover" })).toEqual({
        ok: true,
        state: "taken-over",
      });
    },
  );

  it("hands a taken-over ticket back to pending", () => {
    expect(ticketTransition("taken-over", { type: "handback" })).toEqual({
      ok: true,
      state: "pending",
    });
  });

  it.each(["done", "cancelled", "taken-over"] as const)(
    "%s cannot be taken over",
    (from) => {
      expect(ticketTransition(from, { type: "takeover" }).ok).toBe(false);
    },
  );

  it("does not retry a taken-over ticket: that is a handback", () => {
    expect(ticketTransition("taken-over", { type: "retry" }).ok).toBe(false);
  });
});

describe("ticketTransition: the spec is cancelled", () => {
  it.each([
    "pending",
    "queued",
    "running",
    "merging",
    "blocked",
    "taken-over",
  ] as const)("a ticket that is %s is cancelled with its spec", (from) => {
    expect(ticketTransition(from, { type: "spec-cancelled" })).toEqual({
      ok: true,
      state: "cancelled",
    });
  });

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
    ["running", { type: "block", reason: "integration-loop-exceeded" }],
    ["running", { type: "block", reason: "integration-unknown-side" }],
    ["running", { type: "await-fix" }],
    ["merging", { type: "resume-e2e" }],
    ["running", { type: "block", reason: "post-merge-gate-failed" }],
    ["running", { type: "block", reason: "upstream-cancelled" }],
  ] as const)("%s rejects %j", (from, event) => {
    expect(ticketTransition(from, event).ok).toBe(false);
  });
});
