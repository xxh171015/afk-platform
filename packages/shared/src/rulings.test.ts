import { describe, expect, it } from "vitest";
import { decisionLogFromRuns } from "./decision-log.ts";
import {
  checkReviewRulings,
  collectNeedsDecision,
  listedDecisionsForReview,
} from "./rulings.ts";

describe("checkReviewRulings", () => {
  it("accepts a ruling for each conflict and known-gap", () => {
    expect(
      checkReviewRulings({
        decisions: [
          { id: "R-1#0", kind: "known-gap" },
          { id: "R-1#1", kind: "choice" },
        ],
        rulings: [{ id: "R-1#0", verdict: "needs-human" }],
        mustFix: [],
      }),
    ).toEqual({ ok: true });
  });

  it("is missing when a known-gap has no ruling", () => {
    expect(
      checkReviewRulings({
        decisions: [{ id: "R-1#0", kind: "known-gap" }],
        rulings: [],
        mustFix: [],
      }),
    ).toEqual({ ok: false, reason: "missing ruling for R-1#0" });
  });

  it("is missing when a must-fix ruling has no mustFix item with that id", () => {
    expect(
      checkReviewRulings({
        decisions: [{ id: "R-1#0", kind: "known-gap" }],
        rulings: [{ id: "R-1#0", verdict: "must-fix" }],
        mustFix: [{ id: "other" }],
      }),
    ).toEqual({
      ok: false,
      reason: "must-fix ruling R-1#0 has no mustFix item",
    });
    expect(
      checkReviewRulings({
        decisions: [{ id: "R-1#0", kind: "known-gap" }],
        rulings: [{ id: "R-1#0", verdict: "must-fix" }],
        mustFix: [{ id: "R-1#0" }],
      }),
    ).toEqual({ ok: true });
  });
});

describe("listedDecisionsForReview", () => {
  it("gives a ticket review this ticket's decisions, and wrap-up the whole spec", () => {
    const log = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: 2,
      ticketDisplayId: "T-2",
      currentRunId: null,
      tickets: [
        { id: 1, state: "done" },
        { id: 2, state: "running" },
      ],
      runs: [
        {
          id: 10,
          stage: "implement",
          ticketId: 1,
          output: {
            decisions: [{ kind: "conflict", text: "upstream" }],
          },
        },
        {
          id: 20,
          stage: "implement",
          ticketId: 2,
          output: {
            decisions: [{ kind: "known-gap", text: "reload skips the filter" }],
          },
        },
      ],
    });
    expect(listedDecisionsForReview(log, "ticket").map((d) => d.id)).toEqual([
      "R-20#0",
    ]);
    const wrap = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: null,
      ticketDisplayId: null,
      currentRunId: null,
      tickets: [
        { id: 1, state: "done" },
        { id: 2, state: "done" },
      ],
      runs: log.doneTickets.length
        ? [
            {
              id: 10,
              stage: "implement",
              ticketId: 1,
              output: {
                decisions: [{ kind: "conflict", text: "upstream" }],
              },
            },
            {
              id: 20,
              stage: "implement",
              ticketId: 2,
              output: {
                decisions: [
                  { kind: "known-gap", text: "reload skips the filter" },
                ],
              },
            },
          ]
        : [],
    });
    expect(listedDecisionsForReview(wrap, "spec").map((d) => d.id)).toEqual([
      "R-10#0",
      "R-20#0",
    ]);
  });
});

describe("collectNeedsDecision", () => {
  const gap = {
    id: "R-1#0",
    kind: "known-gap",
    text: "reload skips the filter",
    source: "T-1 implement",
  };
  const deferred = {
    id: "R-1#1",
    kind: "deferred",
    text: "openapi extra field",
    ref: "T-2",
    source: "T-1 implement",
  };

  it("lists needs-human unless the spec-level ruling accepted it", () => {
    expect(
      collectNeedsDecision({
        decisions: [gap],
        ticketRulings: [{ id: "R-1#0", verdict: "needs-human" }],
        specRulings: [],
        tickets: [{ displayId: "T-1", state: "done" }],
      }),
    ).toEqual([
      {
        kind: "needs-human",
        id: "R-1#0",
        source: "T-1 implement",
        text: "reload skips the filter",
      },
    ]);
    expect(
      collectNeedsDecision({
        decisions: [gap],
        ticketRulings: [{ id: "R-1#0", verdict: "needs-human" }],
        specRulings: [{ id: "R-1#0", verdict: "accepted" }],
        tickets: [{ displayId: "T-1", state: "done" }],
      }),
    ).toEqual([]);
  });

  it("omits a deferred whose ticket is done, and keeps new or unfinished ones", () => {
    expect(
      collectNeedsDecision({
        decisions: [deferred],
        ticketRulings: [],
        specRulings: [],
        tickets: [
          { displayId: "T-1", state: "done" },
          { displayId: "T-2", state: "done" },
        ],
      }),
    ).toEqual([]);
    expect(
      collectNeedsDecision({
        decisions: [{ ...deferred, ref: "new" }],
        ticketRulings: [],
        specRulings: [],
        tickets: [{ displayId: "T-1", state: "done" }],
      }),
    ).toEqual([
      {
        kind: "deferred",
        id: "R-1#1",
        source: "T-1 implement",
        text: "openapi extra field",
        ref: "new",
      },
    ]);
  });
});
