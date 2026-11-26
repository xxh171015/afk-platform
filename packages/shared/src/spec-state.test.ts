import { describe, expect, it } from "vitest";
import { specResumeTarget, specTransition } from "./spec-state.ts";

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

  it.each(["finalizing", "awaiting-review", "partially-merged"] as const)(
    "pauses a %s spec",
    (from) => {
      expect(specTransition(from, "pause")).toEqual({
        ok: true,
        state: "paused",
      });
    },
  );

  it("resumes a paused spec to 收尾 or 验收 when those had already started", () => {
    expect(specResumeTarget({ hasFinalizations: false, pullStates: [] })).toBe(
      "running",
    );
    expect(specResumeTarget({ hasFinalizations: true, pullStates: [] })).toBe(
      "finalizing",
    );
    expect(
      specResumeTarget({
        hasFinalizations: true,
        pullStates: ["open"],
      }),
    ).toBe("awaiting-review");
    expect(
      specResumeTarget({
        hasFinalizations: true,
        pullStates: ["merged", "open"],
      }),
    ).toBe("partially-merged");
    expect(
      specResumeTarget({
        hasFinalizations: true,
        pullStates: ["merged"],
      }),
    ).toBe("merged");
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
    ["finalizing", "all-tickets-done"],
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

describe("specTransition: rework", () => {
  it("moves awaiting-review to reworking on rework", () => {
    expect(specTransition("awaiting-review", "rework")).toEqual({
      ok: true,
      state: "reworking",
    });
  });

  it("rejects rework from partially-merged", () => {
    const result = specTransition("partially-merged", "rework");
    expect(result.ok).toBe(false);
  });

  it("moves reworking to finalizing when all tickets are done", () => {
    expect(specTransition("reworking", "all-tickets-done")).toEqual({
      ok: true,
      state: "finalizing",
    });
  });

  it("moves reworking to merged when all prs are merged", () => {
    expect(specTransition("reworking", "all-prs-merged")).toEqual({
      ok: true,
      state: "merged",
    });
  });

  it("pauses a reworking spec", () => {
    expect(specTransition("reworking", "pause")).toEqual({
      ok: true,
      state: "paused",
    });
  });

  it("resumes a paused spec with unfinished tickets and open pull requests to reworking", () => {
    expect(
      specResumeTarget({
        hasFinalizations: true,
        pullStates: ["open"],
        hasIncompleteAppendedTickets: true,
      }),
    ).toBe("reworking");
  });

  it("resumes a paused spec with unfinished wrap-up and open pull requests to 收尾", () => {
    expect(
      specResumeTarget({
        hasFinalizations: true,
        pullStates: ["open"],
        hasIncompleteFinalizations: true,
      }),
    ).toBe("finalizing");
  });
});

describe("specTransition: request-changes", () => {
  it("moves awaiting-review to finalizing on request-changes, not reworking", () => {
    expect(specTransition("awaiting-review", "request-changes")).toEqual({
      ok: true,
      state: "finalizing",
    });
    expect(specTransition("awaiting-review", "rework")).toEqual({
      ok: true,
      state: "reworking",
    });
  });

  it("rejects request-changes from finalizing, reworking, and partially-merged", () => {
    expect(specTransition("finalizing", "request-changes").ok).toBe(false);
    expect(specTransition("reworking", "request-changes").ok).toBe(false);
    expect(specTransition("partially-merged", "request-changes").ok).toBe(
      false,
    );
  });

  it("moves finalizing to merged on all-prs-merged", () => {
    expect(specTransition("finalizing", "all-prs-merged")).toEqual({
      ok: true,
      state: "merged",
    });
  });
});
