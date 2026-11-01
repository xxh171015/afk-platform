import type { BlockedReason } from "@afk/shared";
import { blockedReasonLabel } from "./status.ts";

// Ticket top and waiting card share this mapping of a blocked brief
// (docs/specs/experience-platform.md「结构化简报」). Empty evidence keys stay off the screen.

export type StructuredBrief = {
  reason: BlockedReason | string;
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

export interface BriefSource {
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
}

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
  "job-failed": "看作业失败原因，环境好了再重试",
};

export function structuredBrief(
  reason: string,
  source: BriefSource,
): StructuredBrief {
  return {
    reason,
    step: source.stage,
    summary: blockedReasonLabel(reason),
    evidence: evidenceOf(reason, source),
    recommendedAction:
      RECOMMENDED_ACTION[reason as BlockedReason] ?? "看这次 Run 后决定下一步",
  };
}

function evidenceOf(
  reason: string,
  source: BriefSource,
): StructuredBrief["evidence"] {
  const out = asRecord(source.output);
  const evidence: StructuredBrief["evidence"] = {};
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
            ) ?? unapprovedLines(out));
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
