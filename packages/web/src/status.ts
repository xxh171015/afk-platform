import type { BlockedReason, SpecState, TicketState } from "@afk/shared";

// Status badges: Chinese on the face, English code in `title` (docs/specs/experience-platform.md).

export const SPEC_STATE_LABELS: Record<SpecState, string> = {
  draft: "草稿",
  planned: "已确认",
  running: "运行中",
  finalizing: "收尾",
  "awaiting-review": "待验收",
  "partially-merged": "部分已合并",
  reworking: "返工中",
  merged: "已合并",
  paused: "已暂停",
  cancelled: "已取消",
};

export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  merging: "合并中",
  done: "已完成",
  blocked: "已卡住",
  cancelled: "已取消",
};

export const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  "gate-failed": "门禁失败",
  "post-merge-gate-failed": "合并后门禁失败",
  "merge-conflict": "合并冲突",
  "protected-path-changed": "改了受保护路径",
  "contract-copy-mismatch": "契约副本不一致",
  "no-commits": "没有提交",
  "agent-gave-up": "模型放弃",
  "contract-change-needed": "需要改契约",
  "invalid-output": "输出不合法",
  timeout: "超时",
  "integration-loop-exceeded": "联调轮次用尽",
  "integration-unknown-side": "联调分不清责任仓库",
  "integration-environment-failed": "联调环境起不来",
  "upstream-cancelled": "上游已取消",
  "job-failed": "作业失败",
};

export const PR_STATE_LABELS: Record<string, string> = {
  open: "打开",
  merged: "已合并",
  closed: "关闭未合并",
};

export function specStateLabel(state: string): string {
  return SPEC_STATE_LABELS[state as SpecState] ?? state;
}

export function ticketStateLabel(state: string): string {
  return TICKET_STATE_LABELS[state as TicketState] ?? state;
}

export function blockedReasonLabel(reason: string): string {
  return BLOCKED_REASON_LABELS[reason as BlockedReason] ?? reason;
}

export function prStateLabel(state: string): string {
  return PR_STATE_LABELS[state] ?? state;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
