import { describe, expect, it } from "vitest";

import type {
  AcceptancePack,
  BlockedResponse,
  PullRequest,
  Run,
  Spec,
  Ticket,
} from "@/api/types";
import { shortcutDestination } from "@/lib/keyboard";
import {
  buildWorkbench,
  isStageSlow,
  specStateText,
  ticketStateText,
  truncateSha,
} from "@/lib/view-map";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

const emptyBlocked: BlockedResponse = {
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
  specs: [],
};

function spec(over: Pick<Spec, "id" | "displayId" | "title" | "state"> & Partial<Spec>): Spec {
  return {
    slug: over.displayId.toLowerCase(),
    type: "feature",
    pauseReason: null,
    project: "shop",
    progress: { total: 0, done: 0, active: 0, blocked: 0, pending: 0, cancelled: 0 },
    body: "",
    repos: [],
    integrationBranch: "spec/x",
    createdAt: "2026-10-30T12:00:00.000Z",
    confirmedAt: "2026-10-31T12:00:00.000Z",
    deadlineAt: null,
    updatedAt: "2026-11-01T11:00:00.000Z",
    ...over,
  };
}

function ticket(over: Pick<Ticket, "id" | "displayId" | "specId" | "specDisplayId" | "title" | "state"> & Partial<Ticket>): Ticket {
  return {
    repo: "afk-pilot-backend",
    type: "implementation",
    body: "",
    blockedReason: null,
    blockedDetail: null,
    contentVersion: 1,
    appended: false,
    branch: "agent/x",
    headSha: null,
    contractSha: null,
    attempts: 1,
    blockedRun: null,
    protectedPaths: [],
    approvedProtectedPaths: [],
    acceptanceCriteria: [],
    updatedAt: "2026-11-01T11:00:00.000Z",
    ...over,
  };
}

function run(over: Pick<Run, "id" | "displayId" | "specId" | "ticketId" | "stage" | "state" | "startedAt"> & Partial<Run>): Run {
  return {
    attempt: 1,
    finishedAt: over.state === "running" ? null : "2026-11-01T11:50:00.000Z",
    exitCode: over.state === "running" ? null : 0,
    summary: "",
    ...over,
  };
}

function pr(over: Pick<PullRequest, "id" | "specId" | "specDisplayId" | "repo" | "number" | "state"> & Partial<PullRequest>): PullRequest {
  return {
    url: "https://github.com/shop/repo/pull/1",
    title: "PR",
    draft: false,
    ci: "success",
    review: "none",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseBranch: "main",
    headBranch: "spec/x",
    mergedAt: null,
    syncError: null,
    ...over,
  };
}

describe("Chinese status table", () => {
  it("shows awaiting-review as 等待验收 with the English code for hover", () => {
    expect(specStateText("awaiting-review")).toEqual({ label: "等待验收", code: "awaiting-review" });
  });

  it("shows the rest of the Spec states people see on the workbench in Chinese", () => {
    expect(specStateText("draft")).toEqual({ label: "草稿", code: "draft" });
    expect(specStateText("running")).toEqual({ label: "运行中", code: "running" });
    expect(specStateText("partially-merged")).toEqual({ label: "部分合并", code: "partially-merged" });
    expect(specStateText("merged")).toEqual({ label: "已合并", code: "merged" });
    expect(specStateText("paused")).toEqual({ label: "已暂停", code: "paused" });
  });

  it("shows Ticket blocked as 受阻", () => {
    expect(ticketStateText("blocked")).toEqual({ label: "受阻", code: "blocked" });
    expect(ticketStateText("running")).toEqual({ label: "运行中", code: "running" });
    expect(ticketStateText("done")).toEqual({ label: "完成", code: "done" });
  });
});

describe("SHA display", () => {
  it("keeps the first 7 characters of a 40-character SHA", () => {
    expect(truncateSha("abcdef1234567890abcdef1234567890abcdef12")).toBe("abcdef1");
  });
});

describe("slow stage", () => {
  it("is not slow at the mock mean", () => {
    expect(isStageSlow(60_000, 60_000)).toBe(false);
  });

  it("is slow at 2× the mock mean", () => {
    expect(isStageSlow(120_000, 60_000)).toBe(true);
  });

  it("is slow at 3× the mock mean", () => {
    expect(isStageSlow(180_000, 60_000)).toBe(true);
  });
});

describe("workbench quadrants", () => {
  const runningSpec = spec({ id: "spec_12", displayId: "S-12", title: "订单备注", state: "running" });
  const awaitingSpec = spec({ id: "spec_14", displayId: "S-14", title: "优惠券叠加规则", state: "awaiting-review" });
  const partialSpec = spec({ id: "spec_15", displayId: "S-15", title: "支付回调重复入账", state: "partially-merged" });
  const pausedSpec = spec({
    id: "spec_16",
    displayId: "S-16",
    title: "会员积分过期提醒",
    state: "paused",
    pauseReason: "time-budget-exceeded",
  });
  const mergedOld = spec({
    id: "spec_10",
    displayId: "S-10",
    title: "旧的已合并需求",
    state: "merged",
    updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const mergedNew = spec({
    id: "spec_11",
    displayId: "S-11",
    title: "历史订单查询",
    state: "merged",
    updatedAt: "2026-11-01T10:00:00.000Z",
  });
  const runningSpecStill = spec({ id: "spec_13", displayId: "S-13", title: "导出订单 CSV", state: "finalizing" });

  const blockedTicket = ticket({
    id: "tkt_103",
    displayId: "T-103",
    specId: runningSpec.id,
    specDisplayId: runningSpec.displayId,
    title: "下单页备注输入框",
    state: "blocked",
    blockedReason: "gate-failed",
  });
  const slowTicket = ticket({
    id: "tkt_104",
    displayId: "T-104",
    specId: runningSpec.id,
    specDisplayId: runningSpec.displayId,
    title: "订单详情页展示备注",
    state: "running",
  });
  const normalTicket = ticket({
    id: "tkt_109",
    displayId: "T-109",
    specId: runningSpec.id,
    specDisplayId: runningSpec.displayId,
    title: "备注预览",
    state: "running",
  });

  const slowRun = run({
    id: "run_slow",
    displayId: "R-1",
    specId: runningSpec.id,
    ticketId: slowTicket.id,
    stage: "implement",
    state: "running",
    startedAt: new Date(NOW - 12 * 60_000).toISOString(),
  });
  const normalRun = run({
    id: "run_ok",
    displayId: "R-2",
    specId: runningSpec.id,
    ticketId: normalTicket.id,
    stage: "gate",
    state: "running",
    startedAt: new Date(NOW - 30_000).toISOString(),
  });

  const awaitingPrs = [
    pr({ id: "pr_a", specId: awaitingSpec.id, specDisplayId: awaitingSpec.displayId, repo: "afk-pilot-backend", number: 1, state: "open" }),
    pr({ id: "pr_b", specId: awaitingSpec.id, specDisplayId: awaitingSpec.displayId, repo: "afk-pilot-frontend", number: 2, state: "open", draft: true }),
  ];

  it("puts blocked tickets and paused specs into waiting, not into running", () => {
    const view = buildWorkbench({
      specs: [runningSpec, pausedSpec],
      tickets: [blockedTicket, slowTicket],
      runs: [slowRun],
      pullRequests: [],
      acceptancePacks: {},
      blocked: {
        ...emptyBlocked,
        tickets: [blockedTicket],
        specs: [
          {
            id: pausedSpec.id,
            displayId: pausedSpec.displayId,
            slug: pausedSpec.slug,
            title: pausedSpec.title,
            type: pausedSpec.type,
            state: pausedSpec.state,
            pauseReason: pausedSpec.pauseReason,
            project: pausedSpec.project,
            progress: pausedSpec.progress,
          },
        ],
      },
      now: NOW,
      stageMeans: { implement: 4 * 60_000 },
    });
    expect(view.waiting.map((item) => item.id)).toEqual(["tkt_103", "spec_16"]);
    expect(view.running.map((item) => item.ticketId)).toEqual(["tkt_104"]);
    expect(view.waitingCount).toBe(2);
  });

  it("lists running tickets with stage, elapsed time, and 偏慢 when over 2× the mock mean", () => {
    const view = buildWorkbench({
      specs: [runningSpec],
      tickets: [slowTicket, normalTicket],
      runs: [slowRun, normalRun],
      pullRequests: [],
      acceptancePacks: {},
      blocked: emptyBlocked,
      now: NOW,
      stageMeans: { implement: 4 * 60_000, gate: 90_000 },
    });
    expect(view.running).toEqual([
      {
        ticketId: "tkt_104",
        ticketDisplayId: "T-104",
        title: "订单详情页展示备注",
        specId: "spec_12",
        specDisplayId: "S-12",
        stage: "implement",
        elapsedMs: 12 * 60_000,
        slow: true,
        href: "/tickets/tkt_104",
      },
      {
        ticketId: "tkt_109",
        ticketDisplayId: "T-109",
        title: "备注预览",
        specId: "spec_12",
        specDisplayId: "S-12",
        stage: "gate",
        elapsedMs: 30_000,
        slow: false,
        href: "/tickets/tkt_109",
      },
    ]);
  });

  it("lists awaiting-review and partially-merged specs for acceptance, with PR count and verified criteria", () => {
    const pack: AcceptancePack = {
      specId: awaitingSpec.id,
      generatedAt: "2026-11-01T00:00:00.000Z",
      summary: "",
      criteria: [
        { id: "a", text: "a", status: "verified", reason: null, evidence: null },
        { id: "b", text: "b", status: "verified", reason: null, evidence: null },
        { id: "c", text: "c", status: "unverified", reason: "the agent named no test", evidence: null },
      ],
      findings: [],
      gate: { tests: 1, skipped: 0, durationMs: 1, passed: true },
      risks: [],
      repositories: [],
    };
    const view = buildWorkbench({
      specs: [awaitingSpec, partialSpec, runningSpec],
      tickets: [],
      runs: [],
      pullRequests: awaitingPrs,
      acceptancePacks: { [awaitingSpec.id]: pack },
      blocked: emptyBlocked,
      now: NOW,
      stageMeans: {},
    });
    expect(view.awaitingReview.map((item) => item.specId)).toEqual(["spec_14", "spec_15"]);
    expect(view.awaitingReview[0]).toEqual({
      specId: "spec_14",
      displayId: "S-14",
      title: "优惠券叠加规则",
      state: "awaiting-review",
      prCount: 2,
      verifiedCriteria: 2,
      totalCriteria: 3,
      href: "/specs/spec_14",
    });
    expect(view.awaitingReview[1]).toEqual({
      specId: "spec_15",
      displayId: "S-15",
      title: "支付回调重复入账",
      state: "partially-merged",
      prCount: 0,
      verifiedCriteria: 0,
      totalCriteria: 0,
      href: "/specs/spec_15",
    });
  });

  it("lists only merged specs as recently completed, newest first, never a running Spec", () => {
    const view = buildWorkbench({
      specs: [mergedNew, mergedOld, runningSpec, awaitingSpec, runningSpecStill],
      tickets: [],
      runs: [],
      pullRequests: [],
      acceptancePacks: {},
      blocked: emptyBlocked,
      now: NOW,
      stageMeans: {},
    });
    expect(view.recentlyMerged.map((item) => item.displayId)).toEqual(["S-11", "S-10"]);
    expect(view.recentlyMerged.every((item) => item.href.startsWith("/specs/"))).toBe(true);
  });

  it("returns the empty-state sentences when a quadrant has no items", () => {
    const view = buildWorkbench({
      specs: [],
      tickets: [],
      runs: [],
      pullRequests: [],
      acceptancePacks: {},
      blocked: emptyBlocked,
      now: NOW,
      stageMeans: {},
    });
    expect(view.waiting).toEqual([]);
    expect(view.running).toEqual([]);
    expect(view.awaitingReview).toEqual([]);
    expect(view.recentlyMerged).toEqual([]);
    expect(view.emptyCopy).toEqual({
      waiting: "没有在等你的事。平台在自己跑。",
      running: "没有正在运行的票。",
      awaitingReview: "没有等你验收的需求。",
      recentlyMerged: "还没有已合并的需求。",
    });
  });
});

describe("workbench shortcuts", () => {
  it("maps g h to the workbench, g b to 待处理, g s to specs", () => {
    expect(shortcutDestination("g", "h")).toBe("/");
    expect(shortcutDestination("g", "b")).toBe("/waiting");
    expect(shortcutDestination("g", "s")).toBe("/specs");
    expect(shortcutDestination("g", "o")).toBeUndefined();
    expect(shortcutDestination("g", "w")).toBeUndefined();
    expect(shortcutDestination("", "h")).toBeUndefined();
  });
});
