import { describe, expect, it } from "vitest";

import { parseResumeHours } from "@/lib/resume-hours";

describe("parseResumeHours", () => {
  it("converts hours to seconds", () => {
    expect(parseResumeHours("4")).toEqual({ ok: true, hours: 4, seconds: 14400 });
    expect(parseResumeHours("0.5")).toEqual({ ok: true, hours: 0.5, seconds: 1800 });
  });
  it("allows exactly 168 hours (604800 s)", () => {
    expect(parseResumeHours("168")).toEqual({ ok: true, hours: 168, seconds: 604800 });
  });
  it("rejects 0, negatives, above 168, non-0.5 steps and empty", () => {
    expect(parseResumeHours("0").ok).toBe(false);
    expect(parseResumeHours("-1").ok).toBe(false);
    expect(parseResumeHours("168.5").ok).toBe(false);
    expect(parseResumeHours("1.25").ok).toBe(false);
    expect(parseResumeHours("").ok).toBe(false);
    expect(parseResumeHours("abc").ok).toBe(false);
  });
});
