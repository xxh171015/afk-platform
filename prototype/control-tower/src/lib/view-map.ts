import type {
  AcceptancePack,
  BlockedReason,
  BlockedResponse,
  FinalStep,
  PullRequest,
  Run,
  RunStage,
  Spec,
  SpecState,
  Ticket,
  TicketState,
} from "@/api/types";
import { blockedReasonGuide } from "@/lib/blocked-reasons";

export type StatusText = { label: string; code: string };

export function specStateText(_state: SpecState): StatusText {
  const labels: Record<SpecState, string> = {
    draft: "草稿", planned: "已规划", running: "运行中", finalizing: "收尾中",
    "awaiting-review": "等待验收", "partially-merged": "部分合并", reworking: "返工中",
    merged: "已合并", paused: "已暂停", cancelled: "已取消",
  };
  return { label: labels[_state], code: _state };
}

export function ticketStateText(_state: TicketState): StatusText {
  const labels: Record<TicketState, string> = {
    pending: "等待依赖", queued: "排队中", running: "运行中", merging: "合并中",
    done: "完成", blocked: "受阻", cancelled: "已取消",
  };
  return { label: labels[_state], code: _state };
}

export function truncateSha(sha: string): string {
  return sha.slice(0, 7);
}

export function isStageSlow(_elapsedMs: number, _meanMs: number): boolean {
  return _elapsedMs >= 2 * _meanMs;
}

export type WorkbenchWaitingItem = {
  kind: "ticket" | "finalization" | "pr" | "cleanup" | "readyFailure" | "spec";
  id: string;
  displayId: string;
  title: string;
  href: string;
};

export type WorkbenchRunningItem = {
  ticketId: string;
  ticketDisplayId: string;
  title: string;
  specId: string;
  specDisplayId: string;
  stage: RunStage | FinalStep;
  elapsedMs: number;
  slow: boolean;
  href: string;
};

export type WorkbenchAcceptanceItem = {
  specId: string;
  displayId: string;
  title: string;
  state: Extract<SpecState, "awaiting-review" | "partially-merged">;
  prCount: number;
  verifiedCriteria: number;
  totalCriteria: number;
  href: string;
};

export type WorkbenchMergedItem = {
  specId: string;
  displayId: string;
  title: string;
  updatedAt: string;
  href: string;
};

export type WorkbenchView = {
  waiting: WorkbenchWaitingItem[];
  running: WorkbenchRunningItem[];
  awaitingReview: WorkbenchAcceptanceItem[];
  recentlyMerged: WorkbenchMergedItem[];
  waitingCount: number;
  emptyCopy: {
    waiting: string;
    running: string;
    awaitingReview: string;
    recentlyMerged: string;
  };
};

export type WorkbenchInput = {
  specs: Spec[];
  tickets: Ticket[];
  runs: Run[];
  pullRequests: PullRequest[];
  acceptancePacks: Record<string, AcceptancePack>;
  blocked: BlockedResponse;
  now: number;
  stageMeans: Partial<Record<RunStage | FinalStep, number>>;
};

export function buildWorkbench(_input: WorkbenchInput): WorkbenchView {
  const { blocked, specs, tickets, runs, pullRequests, acceptancePacks, now, stageMeans } = _input;
  const waiting: WorkbenchWaitingItem[] = [
    ...blocked.tickets.map(t => ({ kind: "ticket" as const, id: t.id, displayId: t.displayId, title: t.title, href: `/tickets/${t.id}` })),
    ...blocked.finalizations.map(f => ({ kind: "finalization" as const, id: f.id, displayId: f.specDisplayId, title: `${f.repo ? `${f.repo} · ` : ""}${f.step} 收尾停下`, href: `/specs/${f.specId}` })),
    ...blocked.pullRequests.map(p => ({ kind: "pr" as const, id: p.id, displayId: `${p.repo}#${p.number}`, title: p.title, href: p.url })),
    ...blocked.cleanups.map(c => ({ kind: "cleanup" as const, id: c.id, displayId: c.specDisplayId, title: `清理失败 · ${c.target}`, href: `/specs/${c.specId}` })),
    ...blocked.readyFailures.map(r => ({ kind: "readyFailure" as const, id: r.id, displayId: r.specDisplayId, title: `${r.repo} 的 draft PR 没能转为 ready`, href: `/specs/${r.specId}` })),
    ...blocked.specs.map(s => ({ kind: "spec" as const, id: s.id, displayId: s.displayId, title: s.title, href: `/specs/${s.id}` })),
  ];
  const running: WorkbenchRunningItem[] = tickets.flatMap(t => {
    if (t.state !== "running") return [];
    const run = runs.find(r => r.ticketId === t.id && r.state === "running");
    if (!run) return [];
    const elapsedMs = now - Date.parse(run.startedAt);
    const mean = stageMeans[run.stage];
    return [{ ticketId: t.id, ticketDisplayId: t.displayId, title: t.title, specId: t.specId, specDisplayId: t.specDisplayId, stage: run.stage, elapsedMs, slow: mean !== undefined && isStageSlow(elapsedMs, mean), href: `/tickets/${t.id}` }];
  });
  const awaitingReview: WorkbenchAcceptanceItem[] = specs.flatMap(s => {
    if (s.state !== "awaiting-review" && s.state !== "partially-merged") return [];
    const criteria = acceptancePacks[s.id]?.criteria ?? [];
    return [{ specId: s.id, displayId: s.displayId, title: s.title, state: s.state, prCount: pullRequests.filter(p => p.specId === s.id).length, verifiedCriteria: criteria.filter(c => c.status === "verified").length, totalCriteria: criteria.length, href: `/specs/${s.id}` }];
  });
  const recentlyMerged = specs.filter(s => s.state === "merged")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(s => ({ specId: s.id, displayId: s.displayId, title: s.title, updatedAt: s.updatedAt, href: `/specs/${s.id}` }));
  return {
    waiting, running, awaitingReview, recentlyMerged,
    waitingCount: waiting.length,
    emptyCopy: {
      waiting: "没有在等你的事。平台在自己跑。",
      running: "没有正在运行的票。",
      awaitingReview: "没有等你验收的需求。",
      recentlyMerged: "还没有已合并的需求。",
    },
  };
}

export const DEFAULT_STAGE_MEAN_MS: Record<RunStage | FinalStep, number> = {
  implement: 240_000, gate: 90_000, review: 60_000, merge: 20_000,
  "gate-fix": 180_000, "review-fix": 180_000, "merge-fix": 120_000,
  e2e: 180_000, diagnose: 120_000, "final-review": 120_000,
  "final-fix": 240_000, "final-merge": 30_000, "final-e2e": 180_000,
};

export const PIPELINE_STEPS = ["草稿", "确认", "运行", "收尾", "开 PR", "验收合并"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type PipelineBanner = { kind: "paused" | "cancelled" | "reworking"; label: string } | null;
export type PipelineView = {
  currentStep: PipelineStep;
  currentIndex: number;
  allComplete: boolean;
  banner: PipelineBanner;
};
export type PipelineInput = {
  state: SpecState;
  pullRequests: { state: string }[];
  anomalyFrom?: SpecState | null;
};

export function specPipeline(_input: PipelineInput): PipelineView {
  const { state, pullRequests, anomalyFrom } = _input;
  const banners = { paused: "暂停", cancelled: "已取消", reworking: "验收返工" } as const;
  const abnormal = state === "paused" || state === "cancelled" || state === "reworking";
  const base = abnormal ? anomalyFrom ?? (state === "cancelled" ? "draft" : state === "reworking" ? "awaiting-review" : "running") : state;
  const index = base === "draft" ? 0 : base === "planned" ? 1 : base === "finalizing" ? (pullRequests.length ? 4 : 3) : base === "awaiting-review" || base === "partially-merged" || base === "merged" ? 5 : 2;
  return { currentStep: PIPELINE_STEPS[index], currentIndex: index, allComplete: state === "merged", banner: abnormal ? { kind: state, label: banners[state] } : null };
}

export const CLOSED_TIMELINE_TYPES = [
  "confirmed", "ticket-started", "gate-passed", "gate-failed", "review-findings",
  "ticket-merged-to-integration", "ticket-blocked", "finalizing-entered", "final-step-changed",
  "pr-opened", "pr-marked-ready", "acceptance-pack-generated", "tickets-appended",
  "paused", "resumed", "merged-to-main",
] as const;
export function keepClosedTimelineEvents<T extends { type: string }>(events: T[]): T[] {
  return events.filter(event => CLOSED_TIMELINE_TYPES.some(type => type === event.type));
}
export function specEtaCopy(_minutes: number): string {
  return `预计还需 ${_minutes} 分钟`;
}

export type LogAction = "读取" | "修改" | "运行命令" | "agent 说明";
export function classifyLogLine(line: string): { action: LogAction; summary: string } {
  const trimmed = line.trim();
  if (trimmed.startsWith("$")) return { action: "运行命令", summary: trimmed.replace(/^\$\s*/, "") };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj && typeof obj === "object") {
      const name = String(obj["name"] ?? "").toLowerCase();
      const type = String(obj["type"] ?? "");
      const summary = typeof obj["summary"] === "string" && obj["summary"] ? obj["summary"] : trimmed;
      if (type === "tool_call" || name) {
        if (name === "read_file" || name === "read") return { action: "读取", summary };
        if (["write", "strreplace", "str_replace", "edit", "write_file"].includes(name)) return { action: "修改", summary };
        if (["bash", "shell", "exec"].includes(name)) return { action: "运行命令", summary };
      }
      if (type === "assistant") {
        const content = (obj["message"] as { content?: { text?: string }[] } | undefined)?.content;
        const text = Array.isArray(content) && typeof content[0]?.text === "string" ? content[0].text : summary;
        return { action: "agent 说明", summary: text };
      }
    }
  } catch { /* plain text */ }
  return { action: "agent 说明", summary: trimmed };
}
export function runDetailHref(id: string): string {
  return `/runs/${id}`;
}

export type StructuredBrief = {
  reason: BlockedReason;
  step: string;
  summary: string;
  evidence: {
    failingTests?: string[];
    command?: string;
    lastLogLines?: string;
    conflictFiles?: string[];
    findingsCount?: number;
  };
  recommendedAction: string;
};

export type StructuredBriefInput = {
  reason: BlockedReason;
  stage: string;
  detail?: string | null;
  failingTests?: string[];
  command?: string;
  lastLogLines?: string;
  conflictFiles?: string[];
  findingsCount?: number;
};

export function structuredBrief(input: StructuredBriefInput): StructuredBrief {
  const guide = blockedReasonGuide[input.reason];
  const evidence: StructuredBrief["evidence"] = {};
  if (input.failingTests?.length) evidence.failingTests = input.failingTests;
  if (input.command) evidence.command = input.command;
  if (input.lastLogLines) evidence.lastLogLines = input.lastLogLines;
  if (input.conflictFiles?.length) evidence.conflictFiles = input.conflictFiles;
  if (input.findingsCount != null && input.findingsCount > 0) evidence.findingsCount = input.findingsCount;
  return {
    reason: input.reason,
    step: input.stage,
    summary: guide.explain,
    evidence,
    recommendedAction: guide.suggest,
  };
}

export function ticketToBriefInput(ticket: Ticket, extras?: { findingsCount?: number }): StructuredBriefInput | null {
  if (!ticket.blockedReason) return null;
  const detail = ticket.blockedDetail ?? "";
  const failing = [...detail.matchAll(/^\s*FAIL\s+\S+\s+>\s+(.+)$/gm)].map(m => m[1]?.trim() ?? "");
  const commandLine = detail.split("\n").find(line => line.trim().startsWith("$"));
  const input: StructuredBriefInput = {
    reason: ticket.blockedReason,
    stage: ticket.blockedRun?.stage ?? "implement",
    detail,
  };
  if (failing.length) input.failingTests = failing;
  const command = commandLine?.replace(/^\$\s*/, "").trim();
  if (command) input.command = command;
  if (detail.trim()) input.lastLogLines = detail.trim().split("\n").slice(-30).join("\n");
  if (ticket.protectedPaths.length) input.conflictFiles = [...ticket.protectedPaths];
  if (extras?.findingsCount !== undefined) input.findingsCount = extras.findingsCount;
  return input;
}
