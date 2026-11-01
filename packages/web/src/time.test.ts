import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTime,
  formatElapsed,
  formatRelativeTime,
} from "./time.ts";

const now = new Date("2026-11-01T12:00:00.000Z");

describe("relative time", () => {
  it("uses Chinese units and an absolute UTC title", () => {
    expect(formatRelativeTime("2026-11-01T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-11-01T11:50:00.000Z", now)).toBe(
      "10 分钟前",
    );
    expect(formatRelativeTime("2026-11-01T09:00:00.000Z", now)).toBe(
      "3 小时前",
    );
    expect(formatRelativeTime("2026-10-29T12:00:00.000Z", now)).toBe("3 天前");
    expect(formatAbsoluteTime("2026-11-01T09:00:00.000Z")).toBe(
      "2026-11-01 09:00:00 UTC",
    );
  });

  it("formats a running stage's elapsed time", () => {
    expect(formatElapsed(20_000)).toBe("不到 1 分钟");
    expect(formatElapsed(10 * 60_000)).toBe("10 分钟");
    expect(formatElapsed(3 * 3600_000)).toBe("3 小时");
  });
});
