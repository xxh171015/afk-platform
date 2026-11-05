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
  blocks: "挡住",
  contract: "契约",
};

export const runResultLabel: Record<string, string> = {
  done: "成功",
  passed: "成功",
  failed: "失败",
  running: "运行中",
  cancelled: "已取消",
  pass: "通过",
  fix: "需要修复",
  merged: "已合并",
  conflict: "合并冲突",
  "gate-failed": "门禁失败",
};

// The two axes of a review, named as the review prompts name them.
export const axisLabel: Record<string, string> = {
  standards: "Standards 轴",
  spec: "Spec 轴",
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
