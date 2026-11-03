import { describe, expect, it } from "vitest";
import {
  SPEC_SECTION_LABELS,
  sectionLabel,
  specExcerpt,
  splitMarkdownSections,
} from "./markdown-body.ts";

describe("splitMarkdownSections", () => {
  it("keeps a heading inside a fence as text, not a section", () => {
    const source = [
      "## Problem Statement",
      "",
      "Customers want CSV.",
      "",
      "## Testing Decisions",
      "",
      "```ts",
      "## not a section",
      "```",
    ].join("\n");
    expect(splitMarkdownSections(source).map((s) => s.title)).toEqual([
      "Problem Statement",
      "Testing Decisions",
    ]);
  });

  it("names to-spec sections in Chinese", () => {
    expect(sectionLabel("Problem Statement", SPEC_SECTION_LABELS)).toBe("问题");
    expect(sectionLabel("Odd heading", SPEC_SECTION_LABELS)).toBe(
      "Odd heading",
    );
  });

  it("takes the first Problem Statement paragraph as an excerpt", () => {
    expect(
      specExcerpt("## Problem Statement\n\nCustomers want **CSV**.\n\nMore."),
    ).toBe("Customers want CSV.");
  });
});
