// Project merge policy and the first-rung auto-merge forecast (ADR 0011). Empty or omitted
// merge_policy is the same as manual: the platform does not merge unless auto-improvement is set.

export const MERGE_POLICIES = ["manual", "auto-improvement"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];
export const DEFAULT_MERGE_POLICY: MergePolicy = "manual";

export function parseMergePolicy(
  value: string | null | undefined,
): MergePolicy {
  return value === "auto-improvement" ? "auto-improvement" : "manual";
}

export function storedMergePolicy(
  value: string | null | undefined,
): MergePolicy | null {
  if (value === "auto-improvement" || value === "manual") return value;
  return null;
}

export const AUTO_MERGE_DELAY_MS = 30 * 60 * 1000;

export interface AutoMergePull {
  state: "open" | "closed" | "merged";
  draft: boolean;
  ci: "none" | "pending" | "success" | "failure";
  review: "none" | "approved" | "changes-requested";
  conflictsWithDefault: boolean;
  humanComments: number;
  headSha: string;
}

export interface AutoMergeInput {
  mergePolicy: string | null | undefined;
  specType: string;
  specState: string;
  pullRequests: AutoMergePull[];
  needsDecision: { kind?: string }[];
  awaitingReviewAt: Date | null;
  hadAutoMergeJob: boolean;
  now: Date;
}

export type AutoMergeResult =
  | { willMerge: true; mergeAt: Date; due: boolean }
  | { willMerge: false; reason: string };

function fail(reason: string): AutoMergeResult {
  return { willMerge: false, reason };
}

export function autoMerge(input: AutoMergeInput): AutoMergeResult {
  if (parseMergePolicy(input.mergePolicy) !== "auto-improvement") {
    return fail("项目合并策略不是 auto-improvement");
  }
  if (input.specType !== "improvement") {
    return fail("需求类型不是 improvement");
  }
  if (input.specState !== "awaiting-review") {
    return fail("需求不在 awaiting-review");
  }
  if (input.pullRequests.length !== 1) {
    return fail("需求不是只有一个 PR");
  }
  const pull = input.pullRequests[0];
  if (pull.state !== "open" || pull.draft) {
    return fail("PR 不是打开的非草稿");
  }
  if (pull.ci === "pending" || pull.ci === "failure") {
    return fail("CI 是 pending 或 failure");
  }
  if (pull.conflictsWithDefault) {
    return fail("PR 与默认分支冲突");
  }
  if (pull.review === "changes-requested") {
    return fail("PR 被要求修改");
  }
  if (pull.humanComments > 0) {
    return fail("PR 上有人写过评论");
  }
  if (input.needsDecision.some((item) => item.kind === "needs-human")) {
    return fail("验收包有 needs-human");
  }
  if (input.needsDecision.some((item) => item.kind === "deferred")) {
    return fail("验收包有未做掉的 deferred");
  }
  if (input.hadAutoMergeJob) {
    return fail("已经有过 auto-merge 作业");
  }
  const entered = input.awaitingReviewAt ?? input.now;
  const mergeAt = new Date(entered.getTime() + AUTO_MERGE_DELAY_MS);
  return {
    willMerge: true,
    mergeAt,
    due: input.now.getTime() >= mergeAt.getTime(),
  };
}
