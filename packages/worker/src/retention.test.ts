import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retainWorkerFiles } from "./retention.ts";

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");

function homeWith(dirs: Record<string, string[]>) {
  home = mkdtempSync(join(tmpdir(), "afk-worker-"));
  for (const [folder, names] of Object.entries(dirs)) {
    const root = join(home, folder);
    mkdirSync(root, { recursive: true });
    for (const name of names) {
      const path = join(root, name);
      mkdirSync(path);
      writeFileSync(join(path, "kept"), "x");
    }
  }
  return home;
}

function age(folder: string, name: string, daysAgo: number) {
  const path = join(home, folder, name);
  const at = new Date(NOW - daysAgo * DAY);
  utimesSync(path, at, at);
}

describe("worker file retention", () => {
  it("deletes sandbox-logs older than 14 days, salvage older than 30, snapshots older than 7, and leaves the rest", () => {
    homeWith({
      "sandbox-logs": ["fresh", "stale"],
      salvage: ["fresh-clone", "old-clone"],
      snapshots: ["backend@aaa", "backend@bbb"],
    });
    age("sandbox-logs", "fresh", 13);
    age("sandbox-logs", "stale", 15);
    age("salvage", "fresh-clone", 29);
    age("salvage", "old-clone", 31);
    age("snapshots", "backend@aaa", 6);
    age("snapshots", "backend@bbb", 8);

    expect(
      retainWorkerFiles({
        home,
        now: NOW,
        env: {},
      }),
    ).toEqual({ sandboxLogs: 1, salvage: 1, snapshots: 1 });

    const left = (folder: string) => readdirSync(join(home, folder)).sort();
    expect(left("sandbox-logs")).toEqual(["fresh"]);
    expect(left("salvage")).toEqual(["fresh-clone"]);
    expect(left("snapshots")).toEqual(["backend@aaa"]);
  });

  it("honours AFK_SANDBOX_LOG_RETENTION_DAYS", () => {
    homeWith({ "sandbox-logs": ["keep", "drop"] });
    age("sandbox-logs", "keep", 1);
    age("sandbox-logs", "drop", 3);
    expect(
      retainWorkerFiles({
        home,
        now: NOW,
        env: { AFK_SANDBOX_LOG_RETENTION_DAYS: "2" },
      }).sandboxLogs,
    ).toBe(1);
    expect(readdirSync(join(home, "sandbox-logs"))).toEqual(["keep"]);
  });

  it("does nothing when the folders are not there yet", () => {
    home = mkdtempSync(join(tmpdir(), "afk-worker-"));
    expect(retainWorkerFiles({ home, now: NOW, env: {} })).toEqual({
      sandboxLogs: 0,
      salvage: 0,
      snapshots: 0,
    });
  });
});
