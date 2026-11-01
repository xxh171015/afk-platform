// 枚举 → 中文含义。枚举值本身原样显示，这里只提供旁注/tooltip。
import type {
  BlockedReason,
  EdgeKind,
  FinalStep,
  FindingResolution,
  PrCi,
  PrReview,
  RunStage,
  SpecState,
  SpecType,
  TicketState,
  TicketType,
} from "@/api/types";

export const specStateLabel: Record<SpecState, string> = {
  draft: "草稿",
  planned: "已规划",
  running: "运行中",
  finalizing: "收尾中",
  "awaiting-review": "等待验收",
  "partially-merged": "部分合并",
  reworking: "返工中",
  merged: "已合并",
  paused: "已暂停",
  cancelled: "已取消",
};

export const ticketStateLabel: Record<TicketState, string> = {
  pending: "等待依赖",
  queued: "排队中",
  running: "运行中",
  merging: "合并中",
  done: "完成",
  blocked: "受阻",
  cancelled: "已取消",
};

export const ticketTypeLabel: Record<TicketType, string> = {
  contract: "契约票",
  implementation: "实现票",
  integration: "联调票",
  fix: "修复票",
  system: "系统票",
};

export const specTypeLabel: Record<SpecType, string> = {
  feature: "功能",
  bug: "缺陷",
  improvement: "改进",
};

export const edgeKindLabel: Record<EdgeKind, string> = {
  blocks: "阻塞依赖",
  contract: "契约依赖（等契约 SHA）",
};

export const reasonLabel: Record<BlockedReason, string> = {
  "gate-failed": "门禁失败，自动修复次数用尽",
  "post-merge-gate-failed": "合并到集成分支后门禁失败",
  "merge-conflict": "合并冲突，无法自动解决",
  "protected-path-changed": "改动了受保护路径，需要人工批准",
  "contract-copy-mismatch": "契约副本与上游契约 SHA 不一致",
  "no-commits": "agent 未产生任何提交",
  "agent-gave-up": "agent 主动放弃",
  "contract-change-needed": "需要修改契约才能继续",
  "invalid-output": "agent 输出格式无效",
  timeout: "运行超时",
  "integration-loop-exceeded": "联调修复轮次超过上限",
  "integration-unknown-side": "联调失败但无法判断是哪一端的问题",
  "integration-environment-failed": "联调环境启动失败",
  "upstream-cancelled": "上游票已取消",
  "job-failed": "平台任务执行失败",
};

export const stageLabel: Record<RunStage | FinalStep, string> = {
  implement: "实现",
  gate: "门禁",
  review: "自审",
  merge: "合并",
  "gate-fix": "门禁修复",
  "review-fix": "自审修复",
  "merge-fix": "合并修复",
  e2e: "端到端测试",
  diagnose: "诊断",
  "final-e2e": "收尾 e2e",
  "final-review": "终审",
  "final-fix": "终审修复",
  "final-merge": "最终合并",
};

export const resolutionLabel: Record<FindingResolution, string> = {
  unhandled: "未处理",
  fixed: "已修复",
  "acceptance-pack": "留给验收包",
};

export const prCiLabel: Record<PrCi, string> = { none: "无 CI", pending: "CI 运行中", success: "CI 通过", failure: "CI 失败" };
export const prReviewLabel: Record<PrReview, string> = { none: "未评审", approved: "已批准", "changes-requested": "要求修改" };
