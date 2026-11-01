import { describe, expect, it } from "vitest";
import { isSlowStage, SLOW_STAGE_FACTOR } from "./slow-stage.ts";

describe("isSlowStage", () => {
  it("is the lower bound of the 2～3× range", () => {
    expect(SLOW_STAGE_FACTOR).toBe(2);
  });

  it("marks a stage slow at twice the historical mean", () => {
    expect(isSlowStage(20_000, 10_000)).toBe(true);
    expect(isSlowStage(19_999, 10_000)).toBe(false);
  });

  it("does not mark slow when there is no finished history", () => {
    expect(isSlowStage(60_000, null)).toBe(false);
    expect(isSlowStage(60_000, undefined)).toBe(false);
    expect(isSlowStage(60_000, 0)).toBe(false);
  });
});
