import type { SpecState, TicketState } from "@afk/shared";

// Human six-step bar for a spec, not the state machine drawn as-is
// (docs/specs/experience-platform.md「信息架构」).

export const FLOW_STEPS = [
  "草稿",
  "确认",
  "运行",
  "收尾",
  "开 PR",
  "验收合并",
] as const;

export type FlowStep = (typeof FLOW_STEPS)[number];

export type FlowFacts = {
  pullRequests: number;
  finalizing: boolean;
  started?: boolean;
  confirmed?: boolean;
};

export type FlowBanner = {
  kind: "paused" | "cancelled" | "reworking";
  title: string;
  reason?: string;
};

export function ticketProgress(tickets: { state: TicketState }[]): {
  done: number;
  total: number;
} {
  const live = tickets.filter((t) => t.state !== "cancelled");
  return {
    done: live.filter((t) => t.state === "done").length,
    total: live.length,
  };
}

export function flowBanner(
  state: SpecState,
  pauseReason: string | null,
): FlowBanner | null {
  if (state === "paused")
    return {
      kind: "paused",
      title: "已暂停",
      ...(pauseReason ? { reason: pauseReason } : {}),
    };
  if (state === "cancelled") return { kind: "cancelled", title: "已取消" };
  if (state === "reworking") return { kind: "reworking", title: "返工中" };
  return null;
}

// The step the bar sits on. Exception states do not take a slot: they stay on the step entered before.
export function currentFlowStep(state: SpecState, facts: FlowFacts): FlowStep {
  switch (state) {
    case "draft":
      return "草稿";
    case "planned":
      return "确认";
    case "running":
      return "运行";
    case "finalizing":
      return facts.pullRequests > 0 ? "开 PR" : "收尾";
    case "awaiting-review":
    case "partially-merged":
    case "merged":
      return "验收合并";
    case "paused":
    case "cancelled":
    case "reworking":
      return exceptionStep(facts);
  }
}

function exceptionStep(facts: FlowFacts): FlowStep {
  if (facts.pullRequests > 0) return facts.finalizing ? "开 PR" : "验收合并";
  if (facts.finalizing) return "收尾";
  if (facts.confirmed) return facts.started === false ? "确认" : "运行";
  if (facts.started === false) return "草稿";
  return "运行";
}

export function flowStepIndex(step: FlowStep): number {
  return FLOW_STEPS.indexOf(step);
}

export function flowStepComplete(state: SpecState): boolean {
  return state === "merged";
}
