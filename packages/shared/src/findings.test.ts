import { describe, expect, it } from "vitest";
import { FINDING_RESOLUTIONS, findingResolutionPhrase } from "./findings.ts";

describe("findingResolutionPhrase", () => {
  it("gives the Chinese phrase for every known resolution and leaves unknown values as they are", () => {
    expect(findingResolutionPhrase("unhandled")).toBe("未处理");
    expect(findingResolutionPhrase("fixed")).toBe("已交给 fix 处理");
    expect(findingResolutionPhrase("acceptance-pack")).toBe(
      "进验收包，留给你看",
    );
    expect(findingResolutionPhrase("refactored")).toBe("已由 Tidy 整理");
    expect(findingResolutionPhrase("approved")).toBe("人已批准");
    expect(findingResolutionPhrase("something-else")).toBe("something-else");
  });

  it("lists approved among the stored resolution codes", () => {
    expect(FINDING_RESOLUTIONS).toContain("approved");
  });

  it("lists resolved among the stored resolution codes and phrases it as 审查确认已解决", () => {
    expect(FINDING_RESOLUTIONS).toContain("resolved");
    expect(findingResolutionPhrase("resolved")).toBe("审查确认已解决");
  });
});
