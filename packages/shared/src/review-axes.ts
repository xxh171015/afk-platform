// A review is two runs, one per axis of the code-review skill: Standards (does the code follow the documented
// standards?) and Spec (does it do what the ticket or spec asked?). They are kept apart so that neither colours the
// other, and put side by side afterwards, not merged or re-ranked (ADR 0002).

export const REVIEW_AXES = ["standards", "spec"] as const;
export type ReviewAxis = (typeof REVIEW_AXES)[number];

export interface ReviewItem {
  file: string;
  line?: number;
  problem: string;
}

// What one axis's agent ends with.
export interface AxisReview {
  verdict: "pass" | "fix";
  mustFix: ReviewItem[];
  suggestions: string[];
  scopeCreep: string[];
  uncertainties: string[];
}

// The two results as a review-fix reads them (review.json): every must-fix with the axis it came from, and the two
// results as they were.
export interface CombinedReview {
  verdict: "pass" | "fix";
  mustFix: (ReviewItem & { axis: ReviewAxis })[];
  standards: AxisReview;
  spec: AxisReview;
}

export function combinedReview(
  outputs: Record<ReviewAxis, AxisReview>,
): CombinedReview {
  const mustFix = REVIEW_AXES.flatMap((axis) =>
    outputs[axis].mustFix.map((item) => ({ axis, ...item })),
  );
  return {
    verdict: mustFix.length > 0 ? "fix" : "pass",
    mustFix,
    standards: outputs.standards,
    spec: outputs.spec,
  };
}
