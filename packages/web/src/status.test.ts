import { describe, expect, it } from "vitest";
import {
  blockedReasonLabel,
  prStateLabel,
  shortSha,
  specStateLabel,
  ticketStateLabel,
} from "./status.ts";

describe("status labels", () => {
  it("gives Chinese copy for spec, ticket, blocked-reason and pull-request states", () => {
    expect(specStateLabel("running")).toBe("运行中");
    expect(specStateLabel("awaiting-review")).toBe("待验收");
    expect(ticketStateLabel("blocked")).toBe("已卡住");
    expect(blockedReasonLabel("agent-gave-up")).toBe("模型放弃");
    expect(blockedReasonLabel("sandbox-oom")).toBe("沙箱内存不足");
    expect(prStateLabel("closed")).toBe("关闭未合并");
  });

  it("keeps an unknown code as itself so a new enum value still shows", () => {
    expect(specStateLabel("future-state")).toBe("future-state");
  });

  it("shows a SHA as its first seven characters", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456",
    );
  });
});
