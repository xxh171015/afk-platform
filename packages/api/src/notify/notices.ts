import { formatDisplayId } from "@afk/shared";
import { pageUrl } from "../page-url.ts";

// One macOS banner per listed transition: title is the kind, body is display id + title + one-line reason
// and a page URL. Not a structured brief and not the pack
// (docs/specs/experience-platform.md「通知」).

export const NOTICE_KINDS = [
  "ticket-blocked",
  "final-blocked",
  "spec-paused",
  "awaiting-review",
  "pr-ready",
  "spec-merged",
  "waiting-other",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_TITLES: Record<NoticeKind, string> = {
  "ticket-blocked": "票卡住",
  "final-blocked": "收尾卡住",
  "spec-paused": "需求已暂停",
  "awaiting-review": "可以来验收了",
  "pr-ready": "PR 已转 ready",
  "spec-merged": "需求已合并",
  "waiting-other": "待处理",
};

const BLOCKED_REASON_LABELS: Record<string, string> = {
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
};

export interface Notice {
  title: string;
  body: string;
}

export interface NoticeDraft {
  kind: NoticeKind;
  displayId: string;
  title: string;
  reason: string;
  path: string;
}

export function composeNotice(draft: NoticeDraft): Notice {
  return {
    title: NOTICE_TITLES[draft.kind],
    body: `${draft.displayId} ${draft.title}：${draft.reason}\n${pageUrl(draft.path)}`,
  };
}

export interface ShotTicket {
  id: number;
  title: string;
  state: string;
  blockedReason: string | null;
}

export interface ShotFinal {
  key: string;
  state: string;
  blockedReason: string | null;
}

export interface ShotPull {
  id: number;
  repo: string;
  state: string;
  draft: boolean;
  syncError: string | null;
  mergeOrderDraft: boolean;
}

export interface Shot {
  specId: number;
  specTitle: string;
  specState: string;
  pauseReason: string | null;
  tickets: ShotTicket[];
  finals: ShotFinal[];
  prs: ShotPull[];
  cleanupFailed: boolean;
  readyFailedPullIds: number[];
}

function blockedLabel(reason: string | null): string {
  if (!reason) return "已卡住";
  return BLOCKED_REASON_LABELS[reason] ?? reason;
}

function isWaitingPull(shot: Shot, pull: ShotPull): boolean {
  return (
    pull.state !== "merged" &&
    shot.specState !== "merged" &&
    shot.specState !== "cancelled"
  );
}

export function noticesFromTransition(before: Shot, after: Shot): Notice[] {
  const out: Notice[] = [];
  const spec = formatDisplayId("spec", after.specId);

  for (const ticket of after.tickets) {
    const prev = before.tickets.find((row) => row.id === ticket.id);
    if (ticket.state !== "blocked" || prev?.state === "blocked") continue;
    out.push(
      composeNotice({
        kind: "ticket-blocked",
        displayId: formatDisplayId("ticket", ticket.id),
        title: ticket.title,
        reason: blockedLabel(ticket.blockedReason),
        path: `/tickets/${ticket.id}`,
      }),
    );
  }

  for (const step of after.finals) {
    const prev = before.finals.find((row) => row.key === step.key);
    if (step.state !== "blocked" || prev?.state === "blocked") continue;
    out.push(
      composeNotice({
        kind: "final-blocked",
        displayId: spec,
        title: after.specTitle,
        reason: blockedLabel(step.blockedReason),
        path: `/specs/${after.specId}/delivery`,
      }),
    );
  }

  if (after.specState === "paused" && before.specState !== "paused") {
    out.push(
      composeNotice({
        kind: "spec-paused",
        displayId: spec,
        title: after.specTitle,
        reason: after.pauseReason ?? "已暂停",
        path: `/specs/${after.specId}`,
      }),
    );
  }

  if (
    after.specState === "awaiting-review" &&
    before.specState !== "awaiting-review"
  ) {
    out.push(
      composeNotice({
        kind: "awaiting-review",
        displayId: spec,
        title: after.specTitle,
        reason: "验收包和 PR 已齐",
        path: `/specs/${after.specId}/delivery`,
      }),
    );
  }

  for (const pull of after.prs) {
    const prev = before.prs.find((row) => row.id === pull.id);
    if (prev?.draft && !pull.draft && prev.mergeOrderDraft) {
      out.push(
        composeNotice({
          kind: "pr-ready",
          displayId: spec,
          title: after.specTitle,
          reason: `${pull.repo} 的草稿已转 ready`,
          path: `/specs/${after.specId}/delivery`,
        }),
      );
    }
  }

  if (after.specState === "merged" && before.specState !== "merged") {
    out.push(
      composeNotice({
        kind: "spec-merged",
        displayId: spec,
        title: after.specTitle,
        reason: "已全部合并",
        path: `/specs/${after.specId}`,
      }),
    );
  }

  for (const pull of after.prs) {
    const prev = before.prs.find((row) => row.id === pull.id);
    if (!isWaitingPull(after, pull)) continue;
    if (pull.state === "closed" && prev?.state !== "closed") {
      out.push(
        composeNotice({
          kind: "waiting-other",
          displayId: spec,
          title: after.specTitle,
          reason: "PR 被关",
          path: "/waiting",
        }),
      );
    } else if (pull.syncError && !prev?.syncError) {
      out.push(
        composeNotice({
          kind: "waiting-other",
          displayId: spec,
          title: after.specTitle,
          reason: "PR 读不出",
          path: "/waiting",
        }),
      );
    }
  }

  if (after.cleanupFailed && !before.cleanupFailed) {
    out.push(
      composeNotice({
        kind: "waiting-other",
        displayId: spec,
        title: after.specTitle,
        reason: "清理失败",
        path: "/waiting",
      }),
    );
  }

  for (const pullId of after.readyFailedPullIds) {
    if (before.readyFailedPullIds.includes(pullId)) continue;
    out.push(
      composeNotice({
        kind: "waiting-other",
        displayId: spec,
        title: after.specTitle,
        reason: "转 ready 三次失败",
        path: "/waiting",
      }),
    );
  }

  return out;
}
