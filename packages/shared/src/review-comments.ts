// Review comment (GLOSSARY): a person's note on a Review revision. Not a Finding.
// Drafts exist only on the platform; submitting them is a Change request (#374).

export const REVIEW_COMMENT_STATES = [
  "draft",
  "submitted",
  "addressed",
  "declined",
] as const;
export type ReviewCommentState = (typeof REVIEW_COMMENT_STATES)[number];

export const REVIEW_COMMENT_SIDES = ["old", "new"] as const;
export type ReviewCommentSide = (typeof REVIEW_COMMENT_SIDES)[number];

export const REVIEW_COMMENT_BODY_MAX = 4000;
