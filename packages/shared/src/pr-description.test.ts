import { describe, expect, it } from "vitest";
import {
  fitPrDescription,
  GITHUB_PR_BODY_LIMIT,
  PACK_MARK_END,
  PACK_MARK_START,
  splicePackSection,
  wrapPackSection,
} from "./pr-description.ts";

describe("splicePackSection", () => {
  it("appends a marked section when the description has no markers", () => {
    const next = splicePackSection("Spec: S-1\n\nTickets", "pack here");
    expect(next).toBe(
      `Spec: S-1\n\nTickets\n\n${PACK_MARK_START}\npack here\n${PACK_MARK_END}`,
    );
  });

  it("replaces only the marked section, keeping what a person wrote outside", () => {
    const existing = `Spec: S-1\n\n${wrapPackSection("old pack")}\n\nI added a note`;
    expect(splicePackSection(existing, "new pack")).toBe(
      `Spec: S-1\n\n${PACK_MARK_START}\nnew pack\n${PACK_MARK_END}\n\nI added a note`,
    );
  });

  it("does not overwrite the whole description when the markers are missing", () => {
    const existing = "A person rewrote this from scratch.";
    expect(splicePackSection(existing, "pack")).toContain(
      "A person rewrote this from scratch.",
    );
    expect(splicePackSection(existing, "pack")).toContain("pack");
  });
});

describe("fitPrDescription", () => {
  it("keeps the full text when it fits GitHub's limit", () => {
    expect(fitPrDescription("full", "sum", "only")).toBe("full");
  });

  it("falls back to a summary that still has room, then to the marked summary alone", () => {
    const huge = "x".repeat(GITHUB_PR_BODY_LIMIT + 1);
    const summarized = "short enough";
    expect(fitPrDescription(huge, summarized, "only")).toBe(summarized);
    expect(fitPrDescription(huge, huge, "only")).toBe(wrapPackSection("only"));
  });
});
