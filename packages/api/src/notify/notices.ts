import {
  formatDisplayId,
  type HostKind,
  pauseReasonLabel,
  pullAbbrev,
  structuredBrief,
} from "@afk/shared";
import { pageUrl } from "../page-url.ts";

// One macOS banner per listed transition: title is the kind, body is display id + title + one-line reason
// and a page URL. A ticket-blocked (or final-blocked) reason is structuredBrief.summary, so the banner
// says the same thing as the page and plat blocked (docs/specs/experience-platform.md「通知」).

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

export function noticeTitle(
  kind: NoticeKind,
  hostKind: HostKind = "github",
): string {
  if (kind === "pr-ready") return `${pullAbbrev(hostKind)} 已转 ready`;
  return NOTICE_TITLES[kind];
}

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

export function composeNotice(
  draft: NoticeDraft,
  hostKind: HostKind = "github",
): Notice {
  return {
    title: noticeTitle(draft.kind, hostKind),
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
  hostKind: HostKind;
  tokenMerged: boolean;
}

function blockedSummary(
  reason: string | null,
  specDisplayId: string,
  ticketDisplayId?: string,
): string {
  if (!reason) return "已卡住";
  return structuredBrief({
    reason,
    specDisplayId,
    ticketDisplayId,
    brief: null,
  }).summary;
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
  const hostKind = after.hostKind ?? "github";
  const pr = pullAbbrev(hostKind);
  const notice = (draft: NoticeDraft) => composeNotice(draft, hostKind);

  for (const ticket of after.tickets) {
    const prev = before.tickets.find((row) => row.id === ticket.id);
    if (ticket.state !== "blocked" || prev?.state === "blocked") continue;
    out.push(
      notice({
        kind: "ticket-blocked",
        displayId: formatDisplayId("ticket", ticket.id),
        title: ticket.title,
        reason: blockedSummary(
          ticket.blockedReason,
          spec,
          formatDisplayId("ticket", ticket.id),
        ),
        path: `/tickets/${ticket.id}`,
      }),
    );
  }

  for (const step of after.finals) {
    const prev = before.finals.find((row) => row.key === step.key);
    if (step.state !== "blocked" || prev?.state === "blocked") continue;
    out.push(
      notice({
        kind: "final-blocked",
        displayId: spec,
        title: after.specTitle,
        reason: blockedSummary(step.blockedReason, spec),
        path: `/specs/${after.specId}/delivery`,
      }),
    );
  }

  if (after.specState === "paused" && before.specState !== "paused") {
    out.push(
      notice({
        kind: "spec-paused",
        displayId: spec,
        title: after.specTitle,
        reason: pauseReasonLabel(after.pauseReason),
        path: `/specs/${after.specId}`,
      }),
    );
  }

  if (
    after.specState === "awaiting-review" &&
    before.specState !== "awaiting-review"
  ) {
    out.push(
      notice({
        kind: "awaiting-review",
        displayId: spec,
        title: after.specTitle,
        reason: `验收包和 ${pr} 已齐`,
        path: `/specs/${after.specId}/delivery`,
      }),
    );
  }

  for (const pull of after.prs) {
    const prev = before.prs.find((row) => row.id === pull.id);
    if (prev?.draft && !pull.draft && prev.mergeOrderDraft) {
      out.push(
        notice({
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
      notice({
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
        notice({
          kind: "waiting-other",
          displayId: spec,
          title: after.specTitle,
          reason: `${pr} 被关`,
          path: "/waiting",
        }),
      );
    } else if (pull.syncError && !prev?.syncError) {
      out.push(
        notice({
          kind: "waiting-other",
          displayId: spec,
          title: after.specTitle,
          reason: `${pr} 读不出`,
          path: "/waiting",
        }),
      );
    }
  }

  if (after.cleanupFailed && !before.cleanupFailed) {
    out.push(
      notice({
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
      notice({
        kind: "waiting-other",
        displayId: spec,
        title: after.specTitle,
        reason: "转 ready 三次失败",
        path: "/waiting",
      }),
    );
  }

  if (after.tokenMerged && !before.tokenMerged) {
    out.push(
      notice({
        kind: "waiting-other",
        displayId: spec,
        title: after.specTitle,
        reason: `平台账号合并了 ${pr}`,
        path: `/specs/${after.specId}/delivery`,
      }),
    );
  }

  return out;
}
