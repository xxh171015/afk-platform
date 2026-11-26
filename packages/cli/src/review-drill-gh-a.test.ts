import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("docs/canary/review-drill-gh-a.txt", () => {
  it("contains only the stamp string from this ticket plus a trailing newline", () => {
    const text = readFileSync(
      join(repoRoot, "docs/canary/review-drill-gh-a.txt"),
      "utf8",
    );
    expect(text).toBe("gh-377-20261126T233426Z-a\n");
  });
});
