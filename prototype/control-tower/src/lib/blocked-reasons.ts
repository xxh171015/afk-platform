// 每个 blocked 原因码的「人话」解释和处理建议。
import type { BlockedReason } from "@/api/types";

export interface ReasonGuide {
  /** 发生了什么 */
  explain: string;
  /** 建议你怎么做 */
  suggest: string;
  /** 重试有没有意义 */
  retryable: boolean;
}

export const blockedReasonGuide: Record<BlockedReason, ReasonGuide> = {
  "gate-failed": {
    explain: "门禁失败，agent 已经修过一次（gate-fix），仍然没过。",
    suggest: "先看门禁日志确认失败原因，再重试；若是用例本身有误，可改票后从头重试。",
    retryable: true,
  },
  "post-merge-gate-failed": {
    explain: "单票门禁通过了，但合进集成分支后门禁失败——多半是和其它票的改动互相影响。",
    suggest: "看合并后门禁的日志，保留已有工作重试。",
    retryable: true,
  },
  "merge-conflict": {
    explain: "合并到集成分支时冲突，merge-fix 之后仍然冲突。",
    suggest: "确认冲突来自哪张票；保留工作重试通常就够，冲突较大时从头重试。",
    retryable: true,
  },
  "protected-path-changed": {
    explain: "改动触及了保护路径，平台不会自动合并，需要人确认。",
    suggest: "检查下面列出的未批准路径：没问题就批准，否则重试让 agent 绕开这些路径。",
    retryable: true,
  },
  "contract-copy-mismatch": {
    explain: "使用方仓库里的契约副本，和这张票钉住的契约 SHA 不一致。",
    suggest: "确认上游契约票是否被改过；同步契约副本后保留工作重试。",
    retryable: true,
  },
  "no-commits": {
    explain: "运行结束了，但没有产生任何 commit，通常是 agent 卡在向人提问上。",
    suggest: "看最后一次运行日志里 agent 在问什么，把答案写进票（plat ticket edit）后重试。",
    retryable: true,
  },
  "agent-gave-up": {
    explain: "agent 明确声明做不下去了。",
    suggest: "读简报里 agent 给出的理由；补充票的说明后重试，或取消这张票。",
    retryable: true,
  },
  "contract-change-needed": {
    explain: "agent 认为现有契约无法满足这张票，需要改契约。",
    suggest: "用 plat 追加一张契约票，让这张票依赖它；或确认契约无需改动后重试。",
    retryable: true,
  },
  "invalid-output": {
    explain: "agent 的结构化输出缺失，或不符合 schema。",
    suggest: "一般是偶发问题，保留工作重试即可；反复出现请检查 agent 配置。",
    retryable: true,
  },
  timeout: {
    explain: "超过了空闲时间或墙钟时间上限。",
    suggest: "看日志判断是卡死还是任务太大；太大的话拆票，否则保留工作重试。",
    retryable: true,
  },
  "integration-loop-exceeded": {
    explain: "联调已经修了两轮，仍然失败。",
    suggest: "看联调诊断，判断问题出在哪一端；人工澄清后重试或追加修复票。",
    retryable: true,
  },
  "integration-unknown-side": {
    explain: "联调失败，但诊断查不出是哪个仓库的问题。",
    suggest: "看联调日志自己判断归属，在对应仓库追加修复票，再重试联调。",
    retryable: true,
  },
  "integration-environment-failed": {
    explain: "联调环境起不来（构建、健康检查或服务名问题），连续三次。",
    suggest: "问题在环境不在代码：检查联调环境配置后重试。",
    retryable: true,
  },
  "upstream-cancelled": {
    explain: "它依赖的上游票已经被取消。",
    suggest: "它等的票已取消，重试只会永远等下去。取消这张，或导入替代票。",
    retryable: false,
  },
  "job-failed": {
    explain: "worker 连续三次没能跑起来，问题在执行环境，不在票本身。",
    suggest: "检查 worker / 沙箱是否健康，恢复后保留工作重试。",
    retryable: true,
  },
};
