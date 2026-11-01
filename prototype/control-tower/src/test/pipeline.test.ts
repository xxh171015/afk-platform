import { describe, expect, it } from "vitest";

import {
  CLOSED_TIMELINE_TYPES,
  keepClosedTimelineEvents,
  specEtaCopy,
  specPipeline,
} from "@/lib/view-map";

describe("spec pipeline bar", () => {
  it("maps running to 运行", () => {
    expect(specPipeline({ state: "running", pullRequests: [] })).toEqual({
      currentStep: "运行",
      currentIndex: 2,
      allComplete: false,
      banner: null,
    });
  });

  it("maps finalizing with no PR to 收尾", () => {
    expect(specPipeline({ state: "finalizing", pullRequests: [] }).currentStep).toBe("收尾");
  });

  it("maps finalizing with a PR opening or already open to 开 PR", () => {
    expect(specPipeline({
      state: "finalizing",
      pullRequests: [{ state: "open" }],
    }).currentStep).toBe("开 PR");
  });

  it("maps awaiting-review and partially-merged to 验收合并", () => {
    expect(specPipeline({ state: "awaiting-review", pullRequests: [{ state: "open" }] }).currentStep).toBe("验收合并");
    expect(specPipeline({ state: "partially-merged", pullRequests: [{ state: "merged" }] }).currentStep).toBe("验收合并");
  });

  it("maps merged as all six steps complete", () => {
    expect(specPipeline({ state: "merged", pullRequests: [{ state: "merged" }] })).toEqual({
      currentStep: "验收合并",
      currentIndex: 5,
      allComplete: true,
      banner: null,
    });
  });

  it("maps draft to 草稿 and planned to 确认", () => {
    expect(specPipeline({ state: "draft", pullRequests: [] }).currentStep).toBe("草稿");
    expect(specPipeline({ state: "planned", pullRequests: [] }).currentStep).toBe("确认");
  });

  it("paused from running shows 暂停 banner and stays on 运行", () => {
    expect(specPipeline({
      state: "paused",
      pullRequests: [],
      anomalyFrom: "running",
    })).toEqual({
      currentStep: "运行",
      currentIndex: 2,
      allComplete: false,
      banner: { kind: "paused", label: "暂停" },
    });
  });

  it("cancelled and reworking are banners, not new pipeline steps", () => {
    expect(specPipeline({
      state: "cancelled",
      pullRequests: [],
      anomalyFrom: "draft",
    })).toEqual({
      currentStep: "草稿",
      currentIndex: 0,
      allComplete: false,
      banner: { kind: "cancelled", label: "已取消" },
    });
    expect(specPipeline({
      state: "reworking",
      pullRequests: [{ state: "open" }],
      anomalyFrom: "awaiting-review",
    })).toEqual({
      currentStep: "验收合并",
      currentIndex: 5,
      allComplete: false,
      banner: { kind: "reworking", label: "验收返工" },
    });
  });
});

describe("spec timeline events", () => {
  it("keeps only the closed event list", () => {
    expect(CLOSED_TIMELINE_TYPES).toEqual([
      "confirmed",
      "ticket-started",
      "gate-passed",
      "gate-failed",
      "review-findings",
      "ticket-merged-to-integration",
      "ticket-blocked",
      "finalizing-entered",
      "final-step-changed",
      "pr-opened",
      "pr-marked-ready",
      "acceptance-pack-generated",
      "tickets-appended",
      "paused",
      "resumed",
      "merged-to-main",
    ]);
  });

  it("drops event types that are not in the closed list", () => {
    const kept = keepClosedTimelineEvents([
      { type: "confirmed", at: "2026-11-01T00:00:00.000Z" },
      { type: "agent-thought", at: "2026-11-01T00:01:00.000Z" },
      { type: "ticket-blocked", at: "2026-11-01T00:02:00.000Z" },
    ]);
    expect(kept.map((event) => event.type)).toEqual(["confirmed", "ticket-blocked"]);
  });
});

describe("fake remaining time", () => {
  it("prints 预计还需 xx 分钟 from a mock integer", () => {
    expect(specEtaCopy(40)).toBe("预计还需 40 分钟");
  });
});