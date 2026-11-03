import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTime,
  formatElapsed,
  formatShanghaiDay,
  formatShanghaiTime,
} from "./time.ts";

describe("Shanghai wall clocks", () => {
  it("prints Asia/Shanghai, not relative units or UTC", () => {
    expect(formatShanghaiTime("2026-11-01T09:00:00.000Z")).toBe(
      "2026-11-01 17:00",
    );
    expect(formatAbsoluteTime("2026-11-01T09:00:00.000Z")).toBe(
      "2026-11-01 17:00:00",
    );
    expect(formatShanghaiDay("2026-11-01T16:30:00.000Z")).toBe("2026-11-02");
  });

  it("formats a running stage's elapsed time", () => {
    expect(formatElapsed(20_000)).toBe("不到 1 分钟");
    expect(formatElapsed(10 * 60_000)).toBe("10 分钟");
    expect(formatElapsed(3 * 3600_000)).toBe("3 小时");
  });
});
