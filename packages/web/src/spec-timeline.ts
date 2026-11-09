import { type HostKind, pullAbbrev } from "@afk/shared";

// Timeline events a spec page may show. Anything else stays off the screen
// (docs/specs/experience-platform.md「信息架构」).

export const TIMELINE_KINDS = [
  "confirm-plan",
  "ticket-start",
  "gate",
  "review",
  "ticket-merge",
  "ticket-blocked",
  "finalization",
  "pr-opened",
  "pr-ready",
  "pack",
  "ticket-appended",
  "pause",
  "resume",
  "merged",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_LABELS: Record<TimelineKind, string> = {
  "confirm-plan": "确认拆分",
  "ticket-start": "票开始",
  gate: "门禁",
  review: "Review",
  "ticket-merge": "票合并进集成分支",
  "ticket-blocked": "票卡住",
  finalization: "收尾",
  "pr-opened": "开 PR",
  "pr-ready": "PR 转 ready",
  pack: "验收包生成",
  "ticket-appended": "追加票",
  pause: "暂停",
  resume: "恢复",
  merged: "合并进 main",
};

export function timelineLabel(kind: TimelineKind, hostKind: HostKind): string {
  const pr = pullAbbrev(hostKind);
  if (kind === "pr-opened") return `开 ${pr}`;
  if (kind === "pr-ready") return `${pr} 转 ready`;
  return TIMELINE_LABELS[kind];
}

export function isTimelineKind(kind: string): kind is TimelineKind {
  return (TIMELINE_KINDS as readonly string[]).includes(kind);
}

export function visibleTimeline<T extends { kind: string }>(events: T[]): T[] {
  return events.filter((event) => isTimelineKind(event.kind));
}
