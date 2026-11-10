import { describe, expect, it } from "vitest";
import { advanceDiskAlert, diskGib, diskLevel, GIB } from "./disk.ts";

describe("diskLevel", () => {
  it("is ok at the warn threshold, warn below 10 GiB, stop below 5 GiB", () => {
    expect(diskLevel(10 * GIB)).toBe("ok");
    expect(diskLevel(10 * GIB - 1)).toBe("warn");
    expect(diskLevel(5 * GIB)).toBe("warn");
    expect(diskLevel(5 * GIB - 1)).toBe("stop");
  });

  it("reads whole-GiB overrides from the env, and ignores junk", () => {
    expect(diskGib("AFK_DISK_WARN_GIB", 10, { AFK_DISK_WARN_GIB: "7" })).toBe(
      7,
    );
    expect(
      diskGib("AFK_DISK_WARN_GIB", 10, { AFK_DISK_WARN_GIB: "nope" }),
    ).toBe(10);
  });
});

describe("advanceDiskAlert", () => {
  it("notifies once when crossing each threshold down, and again only after a recovery", () => {
    let noticed: "none" | "warn" | "stop" = "none";
    const step = (free: number) => {
      const next = advanceDiskAlert(noticed, free);
      noticed = next.noticed;
      return next;
    };

    expect(step(20 * GIB)).toMatchObject({ level: "ok", notices: [] });
    expect(step(9 * GIB)).toMatchObject({
      level: "warn",
      notices: ["warn"],
    });
    expect(step(8 * GIB)).toMatchObject({ level: "warn", notices: [] });
    expect(step(4 * GIB)).toMatchObject({
      level: "stop",
      notices: ["stop"],
    });
    expect(step(3 * GIB)).toMatchObject({ level: "stop", notices: [] });
    expect(step(9 * GIB)).toMatchObject({ level: "warn", notices: [] });
    expect(step(4 * GIB)).toMatchObject({
      level: "stop",
      notices: ["stop"],
    });
    expect(step(20 * GIB)).toMatchObject({ level: "ok", notices: [] });
    expect(step(4 * GIB)).toMatchObject({
      level: "stop",
      notices: ["warn", "stop"],
    });
  });
});
