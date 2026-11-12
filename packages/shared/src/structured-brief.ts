import type { BlockedReason } from "./ticket-state.ts";

// A blocked ticket or wrap-up step as a person reads it: Chinese summary, evidence
// with empty keys omitted, and copyable plat commands with the display id filled in.

export type StructuredBriefEvidence = {
  failingTests?: string[];
  command?: string;
  lastLogLines?: string;
  conflictFiles?: string[];
  findingsCount?: number;
};

export type StructuredBriefCommand = {
  label: string;
  command: string;
};

export type StructuredBrief = {
  reason: string;
  step: string;
  summary: string;
  evidence: StructuredBriefEvidence;
  recommendedAction: string;
  commands: StructuredBriefCommand[];
  ticketDraft?: string;
};

export type StructuredBriefSource = {
  stage: string;
  result: string | null;
  output?: unknown;
  run: { id: number; displayId: string };
  attempts?: ReadonlyArray<{
    diagnosis?: {
      failingTests?: string[];
      evidence?: string;
    } | null;
  }>;
};

export type StructuredBriefInput = {
  reason: string;
  specDisplayId: string;
  ticketDisplayId?: string;
  repo?: string;
  contractBlockedBy?: readonly string[];
  wrapUpStep?: string;
  brief: StructuredBriefSource | null;
};

const SUMMARY: Record<BlockedReason, string> = {
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
  "branch-moved": "运行期间票分支被推过了",
  "sandbox-oom": "沙箱内存不足",
  "tests-removed": "删了测试",
};

const RECOMMENDED_ACTION: Record<BlockedReason, string> = {
  "gate-failed": "看失败的测试，修好后带说明重试，保留已有提交",
  "post-merge-gate-failed": "看合并后门禁，修好后重试这一步",
  "merge-conflict": "处理冲突文件后重试合并",
  "protected-path-changed": "确认这些路径可以改，或改允许名单后重试",
  "contract-copy-mismatch": "把契约副本改回钉住的版本，或走改契约流程",
  "no-commits": "从零重试，让模型再提交",
  "agent-gave-up": "看它卡住的地方，带一句话说明后继续",
  "contract-change-needed": "先改提供方契约票，再继续",
  "invalid-output": "改正文或从零重试",
  timeout: "带说明重试，或从零重试",
  "integration-loop-exceeded": "看诊断后决定放行或取消",
  "integration-unknown-side": "看证据后指定责任仓库或取消",
  "integration-environment-failed": "先修好环境再重试",
  "upstream-cancelled": "取消这张票，或导入替代票",
  "job-failed": "看作业失败原因，环境或额度恢复后直接重试",
  "branch-moved": "看谁推了票分支，决定从远端继续后再试",
  "sandbox-oom": "把沙箱内存调大后再试",
  "tests-removed": "确认这些测试可以去掉，批准后从门禁接着跑",
};

export function structuredBrief(input: StructuredBriefInput): StructuredBrief {
  const reason = input.reason as BlockedReason;
  const result: StructuredBrief = {
    reason: input.reason,
    step: input.brief?.stage ?? "",
    summary: SUMMARY[reason] ?? input.reason,
    evidence: evidenceOf(input.reason, input.brief),
    recommendedAction: RECOMMENDED_ACTION[reason] ?? "看这次 Run 后决定下一步",
    commands: commandsOf(input),
  };
  const ticketDraft = ticketDraftOf(input, result.summary);
  if (ticketDraft) result.ticketDraft = ticketDraft;
  return result;
}

const CONTINUE_WITH_NOTE = new Set<string>([
  "gate-failed",
  "timeout",
  "invalid-output",
  "agent-gave-up",
  "post-merge-gate-failed",
  "merge-conflict",
  "contract-copy-mismatch",
]);

function commandsOf(input: StructuredBriefInput): StructuredBriefCommand[] {
  const ticket = input.ticketDisplayId;
  if (!ticket) {
    if (input.reason === "tests-removed") {
      return [
        {
          label: "批准删掉的测试",
          command: `plat spec approve-removed-tests ${input.specDisplayId}`,
        },
      ];
    }
    const retry = {
      label: "再跑收尾",
      command: `plat spec retry-final ${input.specDisplayId}`,
    };
    if (input.wrapUpStep === "final-e2e") {
      return [
        retry,
        {
          label: "跳过联调仍然开 PR",
          command: `plat spec waive-final ${input.specDisplayId}`,
        },
      ];
    }
    return [retry];
  }
  if (CONTINUE_WITH_NOTE.has(input.reason)) {
    return [
      {
        label: "带说明继续",
        command: `plat ticket retry ${ticket} --mode continue --note "…"`,
      },
    ];
  }
  if (input.reason === "no-commits") {
    return [
      {
        label: "从头重试",
        command: `plat ticket retry ${ticket} --mode restart`,
      },
    ];
  }
  if (input.reason === "protected-path-changed") {
    return [
      {
        label: "批准保护路径",
        command: `plat ticket approve-protected ${ticket}`,
      },
      {
        label: "再重试",
        command: `plat ticket retry ${ticket} --mode continue`,
      },
    ];
  }
  if (input.reason === "tests-removed") {
    return [
      {
        label: "批准删掉的测试",
        command: `plat ticket approve-removed-tests ${ticket}`,
      },
    ];
  }
  if (input.reason === "contract-change-needed") {
    return [
      {
        label: "追加契约票",
        command: `plat tickets import ${input.specDisplayId} ~/.afk/planning/${input.specDisplayId}/append/ --append`,
      },
    ];
  }
  if (
    input.reason === "integration-loop-exceeded" ||
    input.reason === "integration-unknown-side"
  ) {
    return [
      {
        label: "再跑开 PR 前联调",
        command: `plat spec retry-final ${input.specDisplayId}`,
      },
      {
        label: "取消这张票",
        command: `plat ticket cancel ${ticket}`,
      },
    ];
  }
  if (input.reason === "job-failed") {
    // the worker could not run the stage: nothing for the agent to change, so no note
    return [
      {
        label: "恢复后重试",
        command: `plat ticket retry ${ticket} --mode continue`,
      },
    ];
  }
  if (input.reason === "branch-moved") {
    return [
      {
        label: "从远端继续",
        command: `plat ticket retry ${ticket} --mode continue`,
      },
    ];
  }
  if (input.reason === "sandbox-oom") {
    return [
      {
        label: "调大内存后重试",
        command: `plat ticket retry ${ticket} --mode continue`,
      },
    ];
  }
  if (input.reason === "integration-environment-failed") {
    return [
      {
        label: "修好环境后重试",
        command: `plat ticket retry ${ticket} --mode continue`,
      },
    ];
  }
  if (input.reason === "upstream-cancelled") {
    return [
      {
        label: "取消这张票",
        command: `plat ticket cancel ${ticket}`,
      },
    ];
  }
  return [];
}

function ticketDraftOf(
  input: StructuredBriefInput,
  summary: string,
): string | undefined {
  if (input.reason !== "contract-change-needed") return undefined;
  const ticket = input.ticketDisplayId;
  const repo = input.repo;
  if (!ticket || !repo) return undefined;
  const out = asRecord(input.brief?.output);
  const detail = typeof out?.detail === "string" ? out.detail : summary;
  const blockedBy = input.contractBlockedBy ?? [];
  const blockedByLine =
    blockedBy.length > 0 ? `blocked_by: [${blockedBy.join(", ")}]\n` : "";
  return `---
title: 改契约以继续 ${ticket}
repo: ${repo}
type: contract
modules: ["**"]
${blockedByLine}blocks: [${ticket}]
---

## Parent

${input.specDisplayId}

## What to build

${detail}

## Acceptance criteria

- [ ] 按 What to build 改契约，使 ${ticket} 能继续
`;
}

function evidenceOf(
  reason: string,
  source: StructuredBriefSource | null,
): StructuredBriefEvidence {
  if (!source) return {};
  const out = asRecord(source.output);
  const evidence: StructuredBriefEvidence = {};
  const failingTests =
    stringArray(out?.failingTests) ??
    source.attempts?.flatMap(
      (attempt) => attempt.diagnosis?.failingTests ?? [],
    );
  if (failingTests && failingTests.length > 0) {
    evidence.failingTests = failingTests;
  }
  const command =
    typeof out?.command === "string"
      ? out.command
      : firstString(stringArray(out?.reasons));
  if (command) evidence.command = command;
  const lastLogLines =
    typeof out?.failureLog === "string"
      ? out.failureLog
      : typeof out?.detail === "string"
        ? out.detail
        : typeof out?.evidence === "string"
          ? out.evidence
          : (firstString(
              source.attempts
                ?.map((attempt) => attempt.diagnosis?.evidence)
                .filter((text): text is string => typeof text === "string"),
            ) ??
            unapprovedLines(out) ??
            (reason === "branch-moved" && typeof out?.error === "string"
              ? out.error
              : undefined));
  if (lastLogLines) evidence.lastLogLines = lastLogLines;
  const conflictFiles =
    stringArray(out?.conflictFiles) ??
    stringArray(out?.files) ??
    (reason === "merge-conflict"
      ? filesFromLog(
          typeof out?.failureLog === "string" ? out.failureLog : undefined,
        )
      : undefined);
  if (conflictFiles && conflictFiles.length > 0) {
    evidence.conflictFiles = conflictFiles;
  }
  const findingsCount = Array.isArray(out?.findings)
    ? out.findings.length
    : typeof out?.findingsCount === "number"
      ? out.findingsCount
      : undefined;
  if (findingsCount && findingsCount > 0)
    evidence.findingsCount = findingsCount;
  return evidence;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length > 0 ? items : undefined;
}

function firstString(items: string[] | undefined): string | undefined {
  return items?.[0];
}

function unapprovedLines(
  out: Record<string, unknown> | undefined,
): string | undefined {
  const paths = stringArray(out?.unapproved);
  return paths?.join("\n");
}

function filesFromLog(log: string | undefined): string[] | undefined {
  if (!log) return undefined;
  const files = log.split("\n").flatMap((line) => {
    const match = /^- (.+)$/.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  return files.length > 0 ? files : undefined;
}
