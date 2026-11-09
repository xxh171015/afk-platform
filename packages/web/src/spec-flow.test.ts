import { describe, expect, it } from "vitest";
import {
  currentFlowStep,
  FLOW_STEPS,
  flowBanner,
  flowStepCaption,
  flowStepComplete,
  flowStepHref,
  flowStepLabel,
  flowStepLocation,
  flowStepReached,
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
    expect(flowBanner("paused", "budget-exhausted")).toEqual({
      kind: "paused",
      title: "已暂停",
      reason: "agent 时间用完",
    });
    expect(flowBanner("cancelled", null)).toEqual({
      kind: "cancelled",
      title: "已取消",
    });
    expect(flowBanner("reworking", null)?.kind).toBe("reworking");
    expect(flowBanner("running", null)).toBeNull();
  });

  it("hangs a caption and a tab address on each step", () => {
    expect(flowStepHref("草稿", 4)).toBe("/specs/4#flow-draft");
    expect(flowStepHref("确认", 4)).toBe("/specs/4#flow-confirm");
    expect(flowStepHref("运行", 4)).toBe("/specs/4/tickets");
    expect(flowStepHref("收尾", 4)).toBe("/specs/4/delivery#delivery-finalize");
    expect(flowStepHref("开 PR", 4)).toBe("/specs/4/delivery#delivery-prs");
    expect(flowStepHref("验收合并", 4)).toBe("/specs/4/delivery#delivery-pack");
    expect(flowStepReached(2, 2, false)).toBe(true);
    expect(flowStepReached(3, 2, false)).toBe(false);
    expect(flowStepReached(5, 2, true)).toBe(true);
    expect(flowStepLocation("overview", "", "运行")).toBe("草稿");
    expect(flowStepLocation("overview", "#flow-confirm", "运行")).toBe("确认");
    expect(flowStepLocation("tickets", "", "运行")).toBe("运行");
    expect(flowStepLocation("delivery", "#delivery-prs", "验收合并")).toBe(
      "开 PR",
    );
    expect(flowStepLocation("timeline", "", "运行")).toBeNull();
    expect(
      flowStepCaption("运行", {
        ticketDone: 1,
        ticketTotal: 4,
        blocked: 1,
        planningSha: false,
      }),
    ).toBe("1/4 · 卡住 1");
    expect(
      flowStepCaption("验收合并", {
        ticketDone: 4,
        ticketTotal: 4,
        blocked: 0,
        planningSha: true,
        pack: true,
        orderBroken: true,
      }),
    ).toBe("合并顺序被打破");
  });

  it("says 开 MR on GitLab", () => {
    expect(flowStepLabel("开 PR", "gitlab")).toBe("开 MR");
    expect(flowStepLabel("开 PR", "github")).toBe("开 PR");
    expect(flowStepLabel("收尾", "gitlab")).toBe("收尾");
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
