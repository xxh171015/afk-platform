import { describe, expect, it } from "vitest";
import {
  lastWeekStarts,
  medianMs,
  weekStartYmd,
  ymdInZone,
} from "./metrics.ts";

describe("weekStartYmd", () => {
  it("puts a Shanghai Monday in its own week", () => {
    expect(weekStartYmd(new Date("2026-11-09T00:00:00+08:00"))).toBe(
      "2026-11-09",
    );
  });

  it("puts a Shanghai Sunday in the week that started that Monday", () => {
    expect(weekStartYmd(new Date("2026-11-15T23:00:00+08:00"))).toBe(
      "2026-11-09",
    );
  });

  it("rolls a UTC Sunday evening into the next Shanghai Monday", () => {
    // 2026-11-08 16:00Z is 2026-11-09 00:00 in Shanghai
    expect(weekStartYmd(new Date("2026-11-08T16:00:00Z"))).toBe("2026-11-09");
  });
});

describe("lastWeekStarts", () => {
  it("returns 12 Mondays ending on this week", () => {
    const weeks = lastWeekStarts(new Date("2026-11-09T12:00:00+08:00"));
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toBe("2026-08-24");
    expect(weeks.at(-1)).toBe("2026-11-09");
  });
});

describe("medianMs", () => {
  it("returns null for no values", () => {
    expect(medianMs([])).toBeNull();
  });

  it("returns the middle of an odd list and the mean of the two middles of an even list", () => {
    expect(medianMs([3, 1, 2])).toBe(2);
    expect(medianMs([4, 1, 2, 3])).toBe(3);
  });
});

describe("ymdInZone", () => {
  it("prints the Shanghai calendar date", () => {
    expect(ymdInZone(new Date("2026-11-08T16:30:00Z"))).toBe("2026-11-09");
  });
});
