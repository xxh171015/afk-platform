import { structuredBrief } from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
import { composeNotice, noticesFromTransition, type Shot } from "./notices.ts";

afterEach(() => {
  delete process.env.AFK_PAGE_URL;
});

const base: Shot = {
  specId: 4,
  specTitle: "导出订单",
  specState: "running",
  pauseReason: null,
  tickets: [
    {
      id: 7,
      title: "写 CSV",
      state: "running",
      blockedReason: null,
    },
  ],
  finals: [{ key: "final-review:1", state: "active", blockedReason: null }],
  prs: [],
  cleanupFailed: false,
  readyFailedPullIds: [],
  hostKind: "github",
  tokenMerged: false,
};

describe("composeNotice", () => {
  it("puts the kind in the title and the display id, reason and page URL in the body", () => {
    expect(
      composeNotice({
        kind: "ticket-blocked",
        displayId: "T-7",
        title: "写 CSV",
        reason: "门禁失败",
        path: "/tickets/7",
      }),
    ).toEqual({
      title: "票卡住",
      body: "T-7 写 CSV：门禁失败\nhttp://127.0.0.1:5173/tickets/7",
    });
  });

  it("uses AFK_PAGE_URL when it is set", () => {
    process.env.AFK_PAGE_URL = "http://127.0.0.1:4173/";
    expect(
      composeNotice({
        kind: "spec-merged",
        displayId: "S-4",
        title: "导出订单",
        reason: "已全部合并",
        path: "/specs/4",
      }).body,
    ).toBe("S-4 导出订单：已全部合并\nhttp://127.0.0.1:4173/specs/4");
  });
});

describe("noticesFromTransition", () => {
  it("fires ticket-blocked once when a ticket enters blocked, and not again while it stays there", () => {
    const blocked: Shot = {
      ...base,
      tickets: [
        {
          id: 7,
          title: "写 CSV",
          state: "blocked",
          blockedReason: "gate-failed",
        },
      ],
    };
    const summary = structuredBrief({
      reason: "gate-failed",
      specDisplayId: "S-4",
      ticketDisplayId: "T-7",
      brief: null,
    }).summary;
    expect(summary).toBe("门禁失败");
    expect(noticesFromTransition(base, blocked)).toEqual([
      {
        title: "票卡住",
        body: `T-7 写 CSV：${summary}\nhttp://127.0.0.1:5173/tickets/7`,
      },
    ]);
    expect(noticesFromTransition(blocked, blocked)).toEqual([]);
  });

  it("fires final-blocked when a finishing step enters blocked", () => {
    const after: Shot = {
      ...base,
      specState: "finalizing",
      finals: [
        {
          key: "final-review:1",
          state: "blocked",
          blockedReason: "job-failed",
        },
      ],
    };
    expect(noticesFromTransition(base, after)).toEqual([
      {
        title: "收尾卡住",
        body: "S-4 导出订单：作业失败\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
  });

  it("fires spec-paused, awaiting-review and spec-merged on those spec transitions", () => {
    expect(
      noticesFromTransition(base, {
        ...base,
        specState: "paused",
        pauseReason: "budget-exhausted",
      }),
    ).toEqual([
      {
        title: "需求已暂停",
        body: "S-4 导出订单：agent 时间用完\nhttp://127.0.0.1:5173/specs/4",
      },
    ]);
    expect(
      noticesFromTransition(
        { ...base, specState: "finalizing" },
        { ...base, specState: "awaiting-review" },
      ),
    ).toEqual([
      {
        title: "可以来验收了",
        body: "S-4 导出订单：验收包和 PR 已齐\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
    expect(
      noticesFromTransition(
        { ...base, specState: "awaiting-review" },
        { ...base, specState: "merged" },
      ),
    ).toEqual([
      {
        title: "需求已合并",
        body: "S-4 导出订单：已全部合并\nhttp://127.0.0.1:5173/specs/4",
      },
    ]);
  });

  it("fires pr-ready only for a merge-order draft that turned ready", () => {
    const draft: Shot = {
      ...base,
      specState: "awaiting-review",
      prs: [
        {
          id: 2,
          repo: "frontend",
          state: "open",
          draft: true,
          syncError: null,
          mergeOrderDraft: true,
        },
      ],
    };
    const ready: Shot = {
      ...draft,
      prs: [
        {
          id: 2,
          repo: "frontend",
          state: "open",
          draft: false,
          syncError: null,
          mergeOrderDraft: true,
        },
      ],
    };
    expect(noticesFromTransition(draft, ready)).toEqual([
      {
        title: "PR 已转 ready",
        body: "S-4 导出订单：frontend 的草稿已转 ready\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
    const notOrder: Shot = {
      ...base,
      prs: [
        {
          id: 1,
          repo: "backend",
          state: "open",
          draft: true,
          syncError: null,
          mergeOrderDraft: false,
        },
      ],
    };
    expect(
      noticesFromTransition(notOrder, {
        ...notOrder,
        prs: [{ ...notOrder.prs[0], draft: false }],
      }),
    ).toEqual([]);
  });

  it("fires waiting-other once per remaining queue change, without merging them", () => {
    const before: Shot = {
      ...base,
      specState: "awaiting-review",
      prs: [
        {
          id: 1,
          repo: "backend",
          state: "open",
          draft: false,
          syncError: null,
          mergeOrderDraft: false,
        },
      ],
    };
    const after: Shot = {
      ...before,
      prs: [
        {
          id: 1,
          repo: "backend",
          state: "closed",
          draft: false,
          syncError: null,
          mergeOrderDraft: false,
        },
      ],
      cleanupFailed: true,
      readyFailedPullIds: [2],
    };
    expect(noticesFromTransition(before, after)).toEqual([
      {
        title: "待处理",
        body: "S-4 导出订单：PR 被关\nhttp://127.0.0.1:5173/waiting",
      },
      {
        title: "待处理",
        body: "S-4 导出订单：清理失败\nhttp://127.0.0.1:5173/waiting",
      },
      {
        title: "待处理",
        body: "S-4 导出订单：转 ready 三次失败\nhttp://127.0.0.1:5173/waiting",
      },
    ]);
  });

  it("does not fire waiting-other when a pull request is closed on a merged spec", () => {
    const before: Shot = {
      ...base,
      specState: "merged",
      prs: [
        {
          id: 1,
          repo: "backend",
          state: "open",
          draft: false,
          syncError: null,
          mergeOrderDraft: false,
        },
      ],
    };
    expect(
      noticesFromTransition(before, {
        ...before,
        prs: [{ ...before.prs[0], state: "closed" }],
      }),
    ).toEqual([]);
  });

  it("fires waiting-other when a followed pull request becomes unreadable", () => {
    const before: Shot = {
      ...base,
      specState: "awaiting-review",
      prs: [
        {
          id: 1,
          repo: "backend",
          state: "open",
          draft: false,
          syncError: null,
          mergeOrderDraft: false,
        },
      ],
    };
    expect(
      noticesFromTransition(before, {
        ...before,
        prs: [{ ...before.prs[0], syncError: "404" }],
      }),
    ).toEqual([
      {
        title: "待处理",
        body: "S-4 导出订单：PR 读不出\nhttp://127.0.0.1:5173/waiting",
      },
    ]);
  });

  it("says MR on GitLab, including when the platform token merged one", () => {
    const gitlab: Shot = { ...base, hostKind: "gitlab" };
    expect(
      noticesFromTransition(
        { ...gitlab, specState: "finalizing" },
        { ...gitlab, specState: "awaiting-review" },
      ),
    ).toEqual([
      {
        title: "可以来验收了",
        body: "S-4 导出订单：验收包和 MR 已齐\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
    const draft: Shot = {
      ...gitlab,
      specState: "awaiting-review",
      prs: [
        {
          id: 2,
          repo: "frontend",
          state: "open",
          draft: true,
          syncError: null,
          mergeOrderDraft: true,
        },
      ],
    };
    expect(
      noticesFromTransition(draft, {
        ...draft,
        prs: [{ ...draft.prs[0], draft: false }],
      }),
    ).toEqual([
      {
        title: "MR 已转 ready",
        body: "S-4 导出订单：frontend 的草稿已转 ready\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
    expect(
      noticesFromTransition(gitlab, { ...gitlab, tokenMerged: true }),
    ).toEqual([
      {
        title: "待处理",
        body: "S-4 导出订单：平台账号合并了 MR\nhttp://127.0.0.1:5173/specs/4/delivery",
      },
    ]);
  });
});
