// Change request (GLOSSARY): one submit of a spec's Review comment drafts.

export const CHANGE_REQUEST_STATES = ["active", "done", "superseded"] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export const CHANGE_REQUEST_IN_REWORK = "正在返工，等它结束再提交。";
export const CHANGE_REQUEST_NOT_AWAITING = "需求不在等人验收。";
export const CHANGE_REQUEST_NO_DRAFTS = "没有草稿可提交。";
export const CHANGE_REQUEST_PR_NOT_OPEN = "有草稿所属的 PR 不是 open。";

export function changeRequestPartiallyMergedMessage(
  specDisplayId: string,
): string {
  return `已有 PR 合并，不能再提交修改要求。还要改的部分，请在规划机器上建一个指向 ${specDisplayId} 的 bug 需求。`;
}

export function changeRequestBlockedMessage(
  specState: string,
  specDisplayId: string,
): string | null {
  if (specState === "partially-merged")
    return changeRequestPartiallyMergedMessage(specDisplayId);
  if (specState === "finalizing" || specState === "reworking")
    return CHANGE_REQUEST_IN_REWORK;
  if (specState !== "awaiting-review") return CHANGE_REQUEST_NOT_AWAITING;
  return null;
}

export interface StaleReviewDraft {
  displayId: string;
  writtenOn: string;
  currentHead: string;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function staleChangeRequestPrompt(
  stale: readonly StaleReviewDraft[],
): string {
  const n = stale.length;
  const written = [
    ...new Set(stale.map((row) => shortSha(row.writtenOn))),
  ].join("、");
  const current = [
    ...new Set(stale.map((row) => shortSha(row.currentHead))),
  ].join("、");
  return `${n} 条意见写在 \`${written}\` 上，PR 现在是 \`${current}\`；agent 会看到意见写下时的那几行代码。仍然提交？`;
}
