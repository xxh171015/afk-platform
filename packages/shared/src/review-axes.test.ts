import { describe, expect, it } from "vitest";
import {
  combinedReview,
  DEFAULT_TICKET_REVIEW,
  reviewAxesFor,
} from "./review-axes.ts";

const spec = {
  verdict: "fix" as const,
  mustFix: [{ file: "t.ts", problem: "missing" }],
  suggestions: [],
  scopeCreep: [],
  uncertainties: [],
};

describe("reviewAxesFor", () => {
  it("runs only Spec on a ticket review by default, and both axes on final-review", () => {
    expect(DEFAULT_TICKET_REVIEW).toBe("spec");
    expect(reviewAxesFor("review")).toEqual(["spec"]);
    expect(reviewAxesFor("review", "spec")).toEqual(["spec"]);
    expect(reviewAxesFor("review", "both")).toEqual(["standards", "spec"]);
    expect(reviewAxesFor("final-review")).toEqual(["standards", "spec"]);
    expect(reviewAxesFor("final-review", "spec")).toEqual([
      "standards",
      "spec",
    ]);
  });
});

describe("combinedReview", () => {
  it("omits an axis that did not run, and still lists must-fix with the axis that asked", () => {
    expect(combinedReview({ spec })).toEqual({
      verdict: "fix",
      mustFix: [{ axis: "spec", file: "t.ts", problem: "missing" }],
      spec,
    });
  });
});
