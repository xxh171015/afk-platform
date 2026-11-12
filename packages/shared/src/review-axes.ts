// A review is two runs, one per axis of the code-review skill: Standards (does the code follow the documented
// standards?) and Spec (does it do what the ticket or spec asked?). They are kept apart so that neither colours the
// other, and put side by side afterwards, not merged or re-ranked (ADR 0002).
// Ticket-level review defaults to Spec only; final-review still runs both. `ticketReview: both` restores two axes
// on the ticket.

export const REVIEW_AXES = ["standards", "spec"] as const;
export type ReviewAxis = (typeof REVIEW_AXES)[number];

export const TICKET_REVIEW_MODES = ["spec", "both"] as const;
export type TicketReviewMode = (typeof TICKET_REVIEW_MODES)[number];
export const DEFAULT_TICKET_REVIEW: TicketReviewMode = "spec";

export function reviewAxesFor(
  stage: "review" | "final-review",
  ticketReview: TicketReviewMode = DEFAULT_TICKET_REVIEW,
): readonly ReviewAxis[] {
  if (stage === "final-review" || ticketReview === "both") return REVIEW_AXES;
  return ["spec"];
}

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
  // files the Standards axis used as standards sources; Spec leaves this off
  sources?: string[];
}

// What a review-fix reads (review.json): every must-fix with the axis it came from, and each axis that ran.
// An axis that was not run is omitted, not filled in.
export interface CombinedReview {
  verdict: "pass" | "fix";
  mustFix: (ReviewItem & { axis: ReviewAxis })[];
  standards?: AxisReview;
  spec?: AxisReview;
}

export function combinedReview(
  outputs: Partial<Record<ReviewAxis, AxisReview>>,
): CombinedReview {
  const mustFix = REVIEW_AXES.flatMap((axis) =>
    (outputs[axis]?.mustFix ?? []).map((item) => ({ axis, ...item })),
  );
  return {
    verdict: mustFix.length > 0 ? "fix" : "pass",
    mustFix,
    ...(outputs.standards ? { standards: outputs.standards } : {}),
    ...(outputs.spec ? { spec: outputs.spec } : {}),
  };
}
