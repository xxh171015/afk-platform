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

export function flowStepHref(step: FlowStep, specId: number): string {
  switch (step) {
    case "草稿":
      return `/specs/${specId}#flow-draft`;
    case "确认":
      return `/specs/${specId}#flow-confirm`;
    case "运行":
      return `/specs/${specId}/tickets`;
    case "收尾":
      return `/specs/${specId}/delivery#delivery-finalize`;
    case "开 PR":
      return `/specs/${specId}/delivery#delivery-prs`;
    case "验收合并":
      return `/specs/${specId}/delivery#delivery-pack`;
  }
}

export function flowStepReached(
  index: number,
  currentIndex: number,
  complete: boolean,
): boolean {
  return complete || index <= currentIndex;
}

export type FlowTab =
  | "overview"
  | "description"
  | "tickets"
  | "delivery"
  | "timeline";

// Which step the open tab / hash corresponds to. Description and timeline are not on the bar.
export function flowStepLocation(
  section: FlowTab,
  hash: string,
  lifecycle: FlowStep,
): FlowStep | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (section === "overview") return id === "flow-confirm" ? "确认" : "草稿";
  if (section === "tickets") return "运行";
  if (section === "delivery") {
    if (id === "delivery-finalize") return "收尾";
    if (id === "delivery-prs") return "开 PR";
    if (id === "delivery-pack") return "验收合并";
    if (
      lifecycle === "收尾" ||
      lifecycle === "开 PR" ||
      lifecycle === "验收合并"
    )
      return lifecycle;
    return "验收合并";
  }
  return null;
}

export type FlowCaptionFacts = {
  ticketDone: number;
  ticketTotal: number;
  blocked: number;
  planningSha: boolean;
  confirmAt?: string;
  finalStep?: string | null;
  prSummary?: string | null;
  pack?: boolean;
  orderBroken?: boolean;
};

export function flowStepCaption(
  step: FlowStep,
  facts: FlowCaptionFacts,
): string | null {
  switch (step) {
    case "草稿":
      if (facts.ticketTotal === 0)
        return facts.planningSha ? "已有规划提交" : "未导入票";
      return `${facts.ticketTotal} 张票${facts.planningSha ? " · 已有规划提交" : ""}`;
    case "确认":
      return facts.confirmAt ?? null;
    case "运行":
      return `${facts.ticketDone}/${facts.ticketTotal}${
        facts.blocked > 0 ? ` · 卡住 ${facts.blocked}` : ""
      }`;
    case "收尾":
      return facts.finalStep ?? null;
    case "开 PR":
      return facts.prSummary ?? null;
    case "验收合并":
      if (facts.orderBroken) return "合并顺序被打破";
      return facts.pack ? "验收包已生成" : null;
  }
}
