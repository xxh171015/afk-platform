import type { BlockedReason } from "@afk/shared";

// Stage names next to the English code (docs/specs/experience-platform.md).
export const stageLabel: Record<string, string> = {
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

export const ticketTypeLabel: Record<string, string> = {
  contract: "契约票",
  implementation: "实现票",
  integration: "联调票",
  fix: "修复票",
  system: "系统票",
};

export const specTypeLabel: Record<string, string> = {
  feature: "功能",
  bug: "缺陷",
  improvement: "改进",
};

export const edgeKindLabel: Record<string, string> = {
  blocks: "阻塞依赖",
  contract: "契约依赖（等契约 SHA）",
};

export const resolutionLabel: Record<string, string> = {
  unhandled: "未处理",
  fixed: "已修复",
  "acceptance-pack": "留给验收包",
};

export const prCiLabel: Record<string, string> = {
  none: "无 CI",
  pending: "CI 运行中",
  success: "CI 通过",
  failure: "CI 失败",
};

export const prReviewLabel: Record<string, string> = {
  none: "未评审",
  approved: "已批准",
  "changes-requested": "要求修改",
};

export const reasonGuide: Record<
  BlockedReason,
  { retryable: boolean; explain: string; suggest: string }
> = {
  "gate-failed": {
    retryable: true,
    explain: "门禁失败，自动修复次数用尽",
    suggest: "看失败测试和日志，改正文或带说明重试",
  },
  "post-merge-gate-failed": {
    retryable: true,
    explain: "合并到集成分支后门禁失败",
    suggest: "看失败原因，再跑一次这一步",
  },
  "merge-conflict": {
    retryable: true,
    explain: "合并冲突，无法自动解决",
    suggest: "说明怎么合，或改正文后重试",
  },
  "protected-path-changed": {
    retryable: true,
    explain: "改动了受保护路径，需要人工批准",
    suggest: "确认路径后批准，或改正文去掉这些改动",
  },
  "contract-copy-mismatch": {
    retryable: true,
    explain: "契约副本与上游契约 SHA 不一致",
    suggest: "核对契约后再试",
  },
  "no-commits": {
    retryable: true,
    explain: "agent 未产生任何提交",
    suggest: "带说明重试，或改正文把任务写清楚",
  },
  "agent-gave-up": {
    retryable: true,
    explain: "agent 主动放弃",
    suggest: "看简报，带一句话说明后继续",
  },
  "contract-change-needed": {
    retryable: true,
    explain: "需要修改契约才能继续",
    suggest: "改契约票，或说明为什么不必改",
  },
  "invalid-output": {
    retryable: true,
    explain: "agent 输出格式无效",
    suggest: "重试；反复出现就改正文",
  },
  timeout: {
    retryable: true,
    explain: "运行超时",
    suggest: "再跑一次，或把范围写小一点",
  },
  "integration-loop-exceeded": {
    retryable: true,
    explain: "联调修复轮次超过上限",
    suggest: "看诊断，改正文或带说明重试",
  },
  "integration-unknown-side": {
    retryable: true,
    explain: "联调失败但无法判断是哪一端的问题",
    suggest: "指定仓库后再试",
  },
  "integration-environment-failed": {
    retryable: true,
    explain: "联调环境启动失败",
    suggest: "看环境日志，修好后再跑",
  },
  "upstream-cancelled": {
    retryable: false,
    explain: "上游票已取消",
    suggest: "取消这张，或导入替代票",
  },
  "job-failed": {
    retryable: true,
    explain: "平台任务执行失败",
    suggest: "再跑一次；反复失败就看 worker 日志",
  },
};
