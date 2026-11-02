import { describe, expect, it } from "vitest";
import {
  currentFlowStep,
  FLOW_STEPS,
  flowBanner,
  flowStepComplete,
  ticketProgress,
} from "./spec-flow.ts";

describe("the six-step bar", () => {
  it("maps each spec state to the step the spec named", () => {
    expect(
      currentFlowStep("draft", { pullRequests: 0, finalizing: false }),
    ).toBe("草稿");
    expect(
      currentFlowStep("planned", { pullRequests: 0, finalizing: false }),
    ).toBe("确认");
    expect(
      currentFlowStep("running", { pullRequests: 0, finalizing: false }),
    ).toBe("运行");
    expect(
      currentFlowStep("finalizing", { pullRequests: 0, finalizing: true }),
    ).toBe("收尾");
    expect(
      currentFlowStep("finalizing", { pullRequests: 1, finalizing: true }),
    ).toBe("开 PR");
    expect(
      currentFlowStep("awaiting-review", { pullRequests: 1, finalizing: true }),
    ).toBe("验收合并");
    expect(
      currentFlowStep("partially-merged", {
        pullRequests: 2,
        finalizing: true,
      }),
    ).toBe("验收合并");
    expect(
      currentFlowStep("merged", { pullRequests: 2, finalizing: true }),
    ).toBe("验收合并");
    expect(flowStepComplete("merged")).toBe(true);
    expect(flowStepComplete("awaiting-review")).toBe(false);
  });

  it("keeps paused, cancelled and reworking off the bar, sitting on the step before the exception", () => {
    expect(FLOW_STEPS).not.toContain("已暂停");
    expect(
      currentFlowStep("paused", { pullRequests: 0, finalizing: false }),
    ).toBe("运行");
    expect(
      currentFlowStep("reworking", { pullRequests: 0, finalizing: false }),
    ).toBe("运行");
    expect(
      currentFlowStep("cancelled", { pullRequests: 0, finalizing: false }),
    ).toBe("运行");
    expect(
      currentFlowStep("cancelled", {
        pullRequests: 0,
        finalizing: false,
        started: false,
      }),
    ).toBe("草稿");
    expect(
      currentFlowStep("cancelled", { pullRequests: 0, finalizing: true }),
    ).toBe("收尾");
    expect(
      currentFlowStep("cancelled", { pullRequests: 1, finalizing: true }),
    ).toBe("开 PR");
    expect(
      currentFlowStep("cancelled", { pullRequests: 1, finalizing: false }),
    ).toBe("验收合并");
    expect(
      currentFlowStep("paused", {
        pullRequests: 0,
        finalizing: false,
        started: false,
        confirmed: true,
      }),
    ).toBe("确认");
  });

  it("names the banner for those exception states", () => {
    expect(flowBanner("paused", "budget")).toEqual({
      kind: "paused",
      title: "已暂停",
      reason: "budget",
    });
    expect(flowBanner("cancelled", null)).toEqual({
      kind: "cancelled",
      title: "已取消",
    });
    expect(flowBanner("reworking", null)?.kind).toBe("reworking");
    expect(flowBanner("running", null)).toBeNull();
  });

  it("counts live tickets as n/m, ignoring cancelled ones", () => {
    expect(
      ticketProgress([
        { state: "done" },
        { state: "running" },
        { state: "cancelled" },
        { state: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3 });
  });
});
