import { describe, expect, it } from "vitest";
import {
  coerceDecisionsInput,
  DecisionSchema,
  DecisionsField,
  decisionsOf,
  decisionTally,
  isListedDecisionKind,
} from "./decisions.ts";

describe("a Decision", () => {
  it("accepts each kind, and deferred only with a ref", () => {
    for (const kind of [
      "choice",
      "conflict",
      "known-gap",
      "workaround",
    ] as const) {
      expect(DecisionSchema.safeParse({ kind, text: "did this" }).success).toBe(
        true,
      );
    }
    expect(
      DecisionSchema.safeParse({
        kind: "deferred",
        text: "later",
        ref: "T-4",
      }).success,
    ).toBe(true);
    expect(
      DecisionSchema.safeParse({ kind: "deferred", text: "later" }).success,
    ).toBe(false);
    expect(
      DecisionSchema.safeParse({
        kind: "deferred",
        text: "later",
        ref: "foo",
      }).success,
    ).toBe(false);
    expect(
      DecisionSchema.safeParse({
        kind: "choice",
        text: "name",
        ref: "T-4",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(
      DecisionSchema.safeParse({ kind: "question", text: "ask" }).success,
    ).toBe(false);
  });

  it("reads a legacy string array as choice", () => {
    expect(DecisionsField.parse(["picked ISO dates"])).toEqual([
      { kind: "choice", text: "picked ISO dates" },
    ]);
    expect(DecisionsField.parse([])).toEqual([]);
  });
});

describe("decisions on a Run output", () => {
  it("prefers decisions and still reads uncertainties", () => {
    expect(
      decisionsOf({
        decisions: [{ kind: "conflict", text: "picked the story" }],
        uncertainties: ["old"],
      }),
    ).toEqual([{ kind: "conflict", text: "picked the story" }]);
    expect(decisionsOf({ uncertainties: ["old"] })).toEqual([
      { kind: "choice", text: "old" },
    ]);
    expect(decisionsOf({ summary: "did it" })).toEqual([]);
  });

  it("moves uncertainties onto decisions for the implement schema", () => {
    expect(
      coerceDecisionsInput({
        status: "done",
        uncertainties: ["old"],
      }),
    ).toEqual({ status: "done", decisions: ["old"] });
  });

  it("lists conflict and known-gap, not choice", () => {
    expect(isListedDecisionKind("conflict")).toBe(true);
    expect(isListedDecisionKind("known-gap")).toBe(true);
    expect(isListedDecisionKind("choice")).toBe(false);
    expect(isListedDecisionKind("workaround")).toBe(false);
  });

  it("tallies listed kinds and counts choice and workaround", () => {
    const tally = decisionTally([
      { kind: "conflict", text: "picked the story" },
      { kind: "choice", text: "named it export" },
      { kind: "choice", text: "ISO dates" },
      { kind: "workaround", text: "skipped drizzle" },
      { kind: "deferred", text: "later", ref: "new" },
    ]);
    expect(tally.listed.map((item) => item.text)).toEqual(["picked the story"]);
    expect(tally.choice).toBe(2);
    expect(tally.workaround).toBe(1);
    expect(tally.counted).toHaveLength(3);
  });
});
