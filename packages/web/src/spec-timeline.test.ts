import { describe, expect, it } from "vitest";
import {
  groupTimeline,
  parseReviewFindingMeta,
  TIMELINE_KINDS,
  timelineLabel,
  visibleTimeline,
} from "./spec-timeline.ts";

describe("the spec timeline", () => {
  it("keeps only the events the spec named, in the order they arrived", () => {
    const shown = visibleTimeline([
      { kind: "confirm-plan", at: "1" },
      { kind: "job-heartbeat", at: "2" },
      { kind: "gate", at: "3" },
      { kind: "log-chunk", at: "4" },
      { kind: "merged", at: "5" },
    ]);
    expect(shown.map((e) => e.kind)).toEqual([
      "confirm-plan",
      "gate",
      "merged",
    ]);
  });

  it("says MR on GitLab for pull-request events", () => {
    expect(timelineLabel("pr-opened", "gitlab")).toBe("开 MR");
    expect(timelineLabel("pr-ready", "gitlab")).toBe("MR 转 ready");
    expect(timelineLabel("pr-opened", "github")).toBe("开 PR");
    expect(timelineLabel("merged", "gitlab")).toBe("合并进 main");
  });

  it("names every kind the spec listed and no others", () => {
    expect(TIMELINE_KINDS).toEqual([
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
      "auto-retry",
    ]);
  });

  it("groups each ticket into one rail instead of listing every gate and review", () => {
    const at = "2026-11-01T10:00:00.000Z";
    const tickets = Array.from({ length: 11 }, (_, i) => ({
      id: i + 1,
      displayId: `T-${i + 1}`,
      title: `Ticket ${i + 1}`,
    }));
    const events = [
      { kind: "confirm-plan" as const, at, text: "确认拆分" },
      ...tickets.flatMap((t) => [
        {
          kind: "ticket-start" as const,
          at,
          text: `${t.displayId} 开始`,
          ticketId: t.id,
        },
        {
          kind: "gate" as const,
          at: "2026-11-01T10:01:00.000Z",
          text: `${t.displayId} 门禁通过`,
          ticketId: t.id,
        },
        {
          kind: "review" as const,
          at: "2026-11-01T10:02:00.000Z",
          text: `${t.displayId} review 0 条意见`,
          ticketId: t.id,
        },
        {
          kind: "ticket-merge" as const,
          at: "2026-11-01T10:03:00.000Z",
          text: `${t.displayId} 合并进集成分支`,
          ticketId: t.id,
        },
      ]),
      {
        kind: "pr-opened" as const,
        at: "2026-11-01T11:00:00.000Z",
        text: "开 PR #1",
      },
    ];
    const days = groupTimeline(events, tickets);
    const rails = days.flatMap((d) => d.rails);
    const ticketRails = rails.filter((r) => r.type === "ticket");
    const eventRails = rails.filter((r) => r.type === "event");
    expect(ticketRails).toHaveLength(11);
    expect(eventRails).toHaveLength(2);
    expect(rails.length).toBeLessThan(20);
    for (const rail of ticketRails) {
      if (rail.type !== "ticket") continue;
      expect(rail.hadTrouble).toBe(false);
      expect(rail.summary).toContain("已合并");
      expect(rail.summary).toContain("门禁通过");
    }
  });

  it("records the last review run and finding count on each ticket rail", () => {
    const meta = parseReviewFindingMeta({
      kind: "review",
      runId: 9,
      text: "T-3 review 5 条意见",
    });
    expect(meta).toEqual({ runId: 9, count: 5 });
    expect(
      parseReviewFindingMeta({
        kind: "review",
        runId: 1,
        text: "T-1 review 0 条意见",
      }),
    ).toEqual({ runId: 1, count: 0 });

    const tickets = [{ id: 1, displayId: "T-1", title: "One" }];
    const days = groupTimeline(
      [
        {
          kind: "review",
          at: "2026-11-01T10:00:00.000Z",
          text: "T-1 review 3 条意见",
          ticketId: 1,
          runId: 22,
        },
        {
          kind: "ticket-merge",
          at: "2026-11-01T11:00:00.000Z",
          text: "T-1 合并进集成分支",
          ticketId: 1,
        },
      ],
      tickets,
    );
    const rail = days[0]?.rails.find((r) => r.type === "ticket");
    expect(rail?.type).toBe("ticket");
    if (rail?.type !== "ticket") return;
    expect(rail.lastReview).toEqual({ runId: 22, count: 3 });
  });

  it("opens a ticket rail by default when it blocked or failed a gate", () => {
    const tickets = [{ id: 58, displayId: "T-58", title: "Link 写入" }];
    const days = groupTimeline(
      [
        {
          kind: "gate",
          at: "2026-11-01T10:00:00.000Z",
          text: "T-58 门禁失败",
          ticketId: 58,
          runId: 1,
        },
        {
          kind: "ticket-blocked",
          at: "2026-11-01T10:05:00.000Z",
          text: "T-58 卡住：gate-failed",
          ticketId: 58,
        },
        {
          kind: "action",
          at: "2026-11-01T10:10:00.000Z",
          text: "重试 T-58",
          ticketId: 58,
        },
        {
          kind: "ticket-merge",
          at: "2026-11-01T12:00:00.000Z",
          text: "T-58 合并进集成分支",
          ticketId: 58,
        },
      ],
      tickets,
    );
    const rail = days[0]?.rails.find((r) => r.type === "ticket");
    expect(rail?.type).toBe("ticket");
    if (rail?.type !== "ticket") return;
    expect(rail.hadTrouble).toBe(true);
    expect(rail.summary).toContain("卡住");
    expect(rail.summary).toContain("后合并");
  });
});
