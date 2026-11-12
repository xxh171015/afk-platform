import { describe, expect, it } from "vitest";
import { formatTokens, tokenCounts } from "./token-usage.ts";

describe("tokenCounts", () => {
  it("reads the four Cursor usage fields and ignores the rest", () => {
    expect(
      tokenCounts({
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 20,
        cacheWriteTokens: 1,
        extra: true,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 20,
      cacheWriteTokens: 1,
    });
  });

  it("is empty when usage is missing", () => {
    expect(tokenCounts(null)).toEqual({});
    expect(tokenCounts("nope")).toEqual({});
  });
});

describe("formatTokens", () => {
  it("groups thousands", () => {
    expect(formatTokens(5_110_000)).toBe("5,110,000");
  });
});
