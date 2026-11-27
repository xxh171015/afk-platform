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
  // null until a host-sync has counted them: unknown never counts as "nobody commented".
  humanComments: number | null;
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
  // Submitted Review comments on this spec. Drafts do not count.
  reviewComments: number;
}

export type AutoMergeResult =
  | { willMerge: true; mergeAt: Date; due: boolean }
  | { willMerge: false; reason: string };

// What GET /specs/{id} and plat spec show print: the forecast plus any auto-merge event.
export interface AutoMergeStatus {
  policy: MergePolicy;
  willMerge: boolean;
  mergeAt: string | null;
  reason: string | null;
  event: {
    type: "auto-merged" | "auto-merge-failed";
    reason: string | null;
  } | null;
}

function hourMinuteInShanghai(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function autoMergeLine(
  status: AutoMergeStatus | null | undefined,
  specState: string,
): string | null {
  if (!status) return null;
  if (status.event?.type === "auto-merged") return "平台已自动合并";
  if (status.event?.type === "auto-merge-failed") {
    return status.event.reason
      ? `自动合并失败：${status.event.reason}`
      : "自动合并失败";
  }
  if (status.policy === "manual") return null;
  if (specState !== "awaiting-review") return null;
  if (status.willMerge && status.mergeAt) {
    return `将于 ${hourMinuteInShanghai(status.mergeAt)} 自动合并，在 PR 上写评论即可阻止`;
  }
  if (!status.willMerge && status.reason) {
    return `不会自动合并：${status.reason}`;
  }
  return null;
}

function fail(reason: string): AutoMergeResult {
  return { willMerge: false, reason };
}

export function autoMergeForecast(input: AutoMergeInput): AutoMergeResult {
  if (parseMergePolicy(input.mergePolicy) !== "auto-improvement") {
    return fail("项目合并策略不是 auto-improvement");
  }
  if (input.specType !== "improvement") {
    return fail("需求类型不是 improvement");
  }
  if (input.specState === "reworking") {
    return fail("返工中");
  }
  if (input.specState !== "awaiting-review") {
    return fail("需求不在 awaiting-review");
  }
  if (input.pullRequests.length !== 1) {
    return fail("需求不是只有一个 PR");
  }
  const pull = input.pullRequests[0];
  if (pull.state !== "open") {
    return fail("PR 不是打开的非草稿");
  }
  if (pull.draft) {
    return fail("返工中");
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
  if (pull.humanComments === null) {
    return fail("还不知道 PR 上有没有人评论");
  }
  if (pull.humanComments > 0) {
    return fail("PR 上有人写过评论");
  }
  if (input.reviewComments > 0) {
    return fail("平台上有人审意见");
  }
  if (input.needsDecision.some((item) => item.kind === "needs-human")) {
    return fail("验收包有 needs-human");
  }
  if (input.needsDecision.some((item) => item.kind === "deferred")) {
    return fail("验收包有未做掉的 deferred");
  }
  if (input.needsDecision.some((item) => item.kind === "host-check")) {
    return fail("需要在宿主机上验证");
  }
  if (input.hadAutoMergeJob) {
    return fail("已经有过 auto-merge 作业");
  }
  if (!input.awaitingReviewAt) {
    return fail("找不到需求进入 awaiting-review 的时间");
  }
  const mergeAt = new Date(
    input.awaitingReviewAt.getTime() + AUTO_MERGE_DELAY_MS,
  );
  return {
    willMerge: true,
    mergeAt,
    due: input.now.getTime() >= mergeAt.getTime(),
  };
}
