import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  LimitOverridesSchema,
  resolveLimits,
} from "./limits.ts";

describe("resolveLimits", () => {
  it("is the documented defaults when nothing is stored", () => {
    expect(resolveLimits({})).toEqual({
      workerSlots: 2,
      projectConcurrency: 2,
      repoConcurrency: 2,
      maxIntegrationEnvironments: 1,
      runIdleSeconds: 600,
      runWallclockSeconds: 3600,
      ticketWallclockSeconds: 10_800,
      specAgentSeconds: 43_200,
      updateBranchBehindCommits: 15,
      updateBranchBehindHours: 6,
    });
  });

  it("applies overrides on top of the defaults", () => {
    const limits = resolveLimits({ repoConcurrency: 4 });
    expect(limits.repoConcurrency).toBe(4);
    expect(limits.projectConcurrency).toBe(DEFAULT_LIMITS.projectConcurrency);
  });

  it("falls back to the defaults when the stored value is unusable", () => {
    expect(resolveLimits({ repoConcurrency: 0 })).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({ unknown: 1 })).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits(null)).toEqual(DEFAULT_LIMITS);
  });

  it("rejects unknown and non-positive overrides when they are written", () => {
    expect(LimitOverridesSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(LimitOverridesSchema.safeParse({ runIdleSeconds: -1 }).success).toBe(
      false,
    );
  });
});
