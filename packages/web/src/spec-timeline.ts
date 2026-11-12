import { type HostKind, pullAbbrev } from "@afk/shared";
import { formatShanghaiDay } from "./time.ts";

// Timeline events a spec page may show. Must match packages/api/src/tickets/timeline.ts
// (docs/specs/experience-platform.md「信息架构」, S-28 时间线读事件表).

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
  "action",
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
  action: "人的操作",
};

const STANDALONE_KINDS = new Set<TimelineKind>([
  "confirm-plan",
  "finalization",
  "pr-opened",
  "pr-ready",
  "pack",
  "merged",
  "pause",
  "resume",
]);

const TICKET_DISPLAY = /T-(\d+)/;

export type TimelineEvent = {
  kind: TimelineKind | string;
  at?: string;
  text?: string;
  runId?: number;
  ticketId?: number;
  failureSource?: string;
};

export type TimelineTicketRef = {
  id: number;
  displayId: string;
  title: string;
};

export type TimelineStandaloneRail = {
  type: "event";
  at: string;
  event: TimelineEvent;
};

export type ReviewFindingMeta = {
  runId: number;
  count: number;
};

export type TimelineTicketRail = {
  type: "ticket";
  at: string;
  ticketId: number;
  displayId: string;
  title: string;
  summary: string;
  lastReview: ReviewFindingMeta | null;
  /** Gate failed, blocked, or human retry — show a cue while collapsed */
  hadTrouble: boolean;
  events: TimelineEvent[];
};

const REVIEW_COUNT = /(\d+)\s*条意见/;

export function parseReviewFindingMeta(
  event: TimelineEvent,
): ReviewFindingMeta | null {
  if (event.kind !== "review" || event.runId == null) return null;
  const match = REVIEW_COUNT.exec(event.text ?? "");
  if (!match) return null;
  return { runId: event.runId, count: Number(match[1]) };
}

export type TimelineRail = TimelineStandaloneRail | TimelineTicketRail;

export type TimelineDay = {
  day: string;
  rails: TimelineRail[];
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

function resolveTicketId(
  event: TimelineEvent,
  byDisplay: Map<string, number>,
): number | null {
  if (event.ticketId != null) return event.ticketId;
  const text = event.text ?? "";
  const match = TICKET_DISPLAY.exec(text);
  if (!match) return null;
  const displayId = `T-${match[1]}`;
  return byDisplay.get(displayId) ?? null;
}

function eventSortAt(event: TimelineEvent): string {
  return event.at ?? "";
}

function isStuckGroup(events: TimelineEvent[]): boolean {
  for (const event of events) {
    if (event.kind === "ticket-blocked") return true;
    if (event.kind === "gate" && (event.text ?? "").includes("失败"))
      return true;
    if (event.kind === "action" && (event.text ?? "").includes("重试")) {
      return true;
    }
  }
  return false;
}

function buildSummary(events: TimelineEvent[], stuck: boolean): string {
  const merged = events.some((e) => e.kind === "ticket-merge");
  const blockedCount = events.filter((e) => e.kind === "ticket-blocked").length;
  const gates = events.filter((e) => e.kind === "gate");
  const lastGate = gates.at(-1);
  const reviews = events.filter((e) => e.kind === "review");
  const lastReview = reviews.at(-1);

  if (stuck) {
    const parts = [`卡住 ${blockedCount} 次`];
    if (merged) parts.push("后合并");
    else if (lastGate?.text?.includes("失败")) parts.push("门禁未过");
    else parts.push("进行中");
    const gateBit =
      lastGate && !merged
        ? lastGate.text?.includes("通过")
          ? "· 门禁通过"
          : lastGate.text?.includes("失败")
            ? "· 门禁失败"
            : ""
        : merged && lastGate
          ? lastGate.text?.includes("通过")
            ? "· 门禁通过"
            : ""
          : "";
    return `${parts.join(" · ")}${gateBit}`.trim();
  }

  const parts: string[] = [];
  if (merged) parts.push("已合并");
  if (lastGate?.text?.includes("通过")) parts.push("门禁通过");
  else if (lastGate?.text?.includes("失败")) parts.push("门禁失败");
  if (lastReview) {
    const m = (lastReview.text ?? "").match(/(\d+)\s*条意见/);
    if (m) parts.push(`review ${m[1]} 条意见`);
  }
  return parts.length > 0 ? parts.join(" · ") : "进行中";
}

export function groupTimeline(
  events: TimelineEvent[],
  tickets: TimelineTicketRef[],
): TimelineDay[] {
  const byDisplay = new Map(tickets.map((t) => [t.displayId, t.id] as const));
  const byId = new Map(tickets.map((t) => [t.id, t] as const));
  const ticketBuckets = new Map<number, TimelineEvent[]>();
  const standalone: TimelineEvent[] = [];

  for (const event of events) {
    const kind = event.kind;
    if (isTimelineKind(kind) && STANDALONE_KINDS.has(kind)) {
      standalone.push(event);
      continue;
    }
    const ticketId = resolveTicketId(event, byDisplay);
    if (ticketId == null) {
      standalone.push(event);
      continue;
    }
    const list = ticketBuckets.get(ticketId) ?? [];
    list.push(event);
    ticketBuckets.set(ticketId, list);
  }

  const rails: TimelineRail[] = [];

  for (const event of standalone) {
    const at = eventSortAt(event);
    if (!at) continue;
    rails.push({ type: "event", at, event });
  }

  for (const [ticketId, groupEvents] of ticketBuckets) {
    const sorted = [...groupEvents].sort((a, b) =>
      eventSortAt(a).localeCompare(eventSortAt(b)),
    );
    const at = eventSortAt(sorted[0]);
    if (!at) continue;
    const meta = byId.get(ticketId);
    const displayId = meta?.displayId ?? `T-${ticketId}`;
    const title = meta?.title ?? "";
    const stuck = isStuckGroup(sorted);
    const reviewEvents = sorted.filter((e) => e.kind === "review");
    rails.push({
      type: "ticket",
      at,
      ticketId,
      displayId,
      title,
      summary: buildSummary(sorted, stuck),
      lastReview: (() => {
        const last = reviewEvents.at(-1);
        return last ? parseReviewFindingMeta(last) : null;
      })(),
      hadTrouble: stuck,
      events: sorted,
    });
  }

  rails.sort(
    (a, b) => a.at.localeCompare(b.at) || a.type.localeCompare(b.type),
  );

  const days = new Map<string, TimelineRail[]>();
  for (const rail of rails) {
    const day = formatShanghaiDay(rail.at) || "未知日期";
    const bucket = days.get(day) ?? [];
    bucket.push(rail);
    days.set(day, bucket);
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayRails]) => ({ day, rails: dayRails }));
}
