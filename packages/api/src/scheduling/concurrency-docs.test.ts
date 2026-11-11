import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const design = readFileSync(
  fileURLToPath(new URL("../../../../docs/design.md", import.meta.url)),
  "utf8",
);

describe("project concurrency versus worker slots", () => {
  it("the design document says project concurrency counts agent tickets and worker slots cover merge and e2e", () => {
    expect(design).toMatch(/项目并发\*\*是同时跑 agent 的票数/);
    expect(design).toMatch(/merging 不计入/);
    expect(design).toMatch(/合并和联调的开销由槽位兜底/);
    expect(design).toMatch(/领取作业按项目轮流/);
  });
});
