// A git push the worker already attempted: the remote was unreachable, the branch moved,
// or the host refused permission. The worker retries only a network blip in the same job;
// the API maps the other two onto blocked reasons (docs/design.md「推送出口与检测」).

export const BRANCH_MOVED_BRIEF = "运行期间票分支被推过了";
export const HOST_PERMISSION_BRIEF =
  "代码托管拒绝推送：保护分支或没有写权限，检查 bot 在仓库上的权限";

export type PushErrorKind =
  | "network"
  | "branch-moved"
  | "host-permission"
  | "other";

export type PushFailureTips = {
  remoteTip?: string;
  startedFrom?: string;
};

// Copied from the worker's former NETWORK_PUSH: a flake we wait out and push again.
const NETWORK =
  /could not resolve host|failed to connect|connection refused|connection reset|connection timed out|timed out|etimedout|econnreset|enotfound|eai_again|couldn't connect|tls handshake timeout|the requested url returned error: 5\d\d|\bhttp 5\d\d\b|rpc failed; http 5\d\d/i;

const BRANCH_MOVED =
  /non-fast-forward|fetch first|stale info|updates were rejected because/i;

const HOST_PERMISSION =
  /GH006|protected branch|permission to .+ denied|not allowed to push|insufficient permission/i;

// Push errors the worker already classified (API and finalize paths must not re-infer from raw git text).
export function reportedPushError(error: string): PushErrorKind | null {
  // Merge already retried a racing integration branch; that leftover git text is not a ticket-branch move.
  if (!/it kept moving/.test(error)) {
    if (error.includes(BRANCH_MOVED_BRIEF)) return "branch-moved";
  }
  if (error.includes(HOST_PERMISSION_BRIEF)) return "host-permission";
  return null;
}

export function classifyPushError(error: string): PushErrorKind {
  const reported = reportedPushError(error);
  if (reported) return reported;
  // Merge already retried a racing integration branch; that leftover git text is not a ticket-branch move.
  if (!/it kept moving/.test(error)) {
    if (BRANCH_MOVED.test(error)) return "branch-moved";
  }
  if (HOST_PERMISSION.test(error)) return "host-permission";
  if (NETWORK.test(error)) return "network";
  return "other";
}

export function isNetworkPushError(error: string): boolean {
  return classifyPushError(error) === "network";
}

export function formatPushFailure(
  error: string,
  tips: PushFailureTips = {},
): string {
  const kind = classifyPushError(error);
  if (kind === "branch-moved") {
    if (error.includes(BRANCH_MOVED_BRIEF)) return error;
    const lines = [BRANCH_MOVED_BRIEF];
    if (tips.remoteTip !== undefined)
      lines.push(`远端 tip: ${tips.remoteTip || "(none)"}`);
    if (tips.startedFrom !== undefined)
      lines.push(`本轮起点: ${tips.startedFrom || "(none)"}`);
    lines.push(error);
    return lines.join("\n");
  }
  if (kind === "host-permission") return HOST_PERMISSION_BRIEF;
  return error;
}
