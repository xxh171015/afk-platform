// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeServer, renderWithApp } from "./test-utils.tsx";
import {
  EMPTY_COMPLETED,
  EMPTY_REVIEW,
  EMPTY_RUNNING,
  EMPTY_WAITING,
  Workbench,
} from "./Workbench.tsx";

afterEach(cleanup);

const emptyWaiting = {
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
  specs: [],
};

const empty = {
  waiting: emptyWaiting,
  running: [],
  awaitingAcceptance: [],
  recentlyCompleted: [],
};

describe("the workbench", () => {
  it("shows a next-step hint in each empty quadrant, not a blank panel", async () => {
    renderWithApp(
      <Workbench />,
      fakeServer({ "GET /workbench": () => ({ json: empty }) }),
    );
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(screen.getByText(EMPTY_WAITING)).toBeTruthy();
    expect(screen.getByText(EMPTY_RUNNING)).toBeTruthy();
    expect(screen.getByText(EMPTY_REVIEW)).toBeTruthy();
    expect(screen.getByText(EMPTY_COMPLETED)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes a failed load from an idle board", async () => {
    renderWithApp(
      <Workbench />,
      fakeServer({
        "GET /workbench": () => ({
          status: 500,
          json: { error: "database is down" },
        }),
      }),
    );
    expect(screen.getByText("加载工作台…")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法加载工作台: database is down");
    expect(screen.queryByText(EMPTY_WAITING)).toBeNull();
  });

  it("lists waiting, running, review and recently merged items with real paths", async () => {
    renderWithApp(
      <Workbench />,
      fakeServer({
        "GET /workbench": () => ({
          json: {
            waiting: {
              ...emptyWaiting,
              tickets: [
                {
                  id: 9,
                  displayId: "T-9",
                  specId: 3,
                  specDisplayId: "S-3",
                  title: "Stuck",
                  type: "implementation",
                  state: "blocked",
                  blockedReason: "agent-gave-up",
                  repo: "backend",
                  brief: null,
                },
              ],
            },
            running: [
              {
                spec: {
                  id: 3,
                  displayId: "S-3",
                  slug: "s",
                  title: "Third",
                  type: "feature",
                  state: "running",
                  pauseReason: null,
                  project: "shop",
                  progress: {
                    total: 1,
                    done: 0,
                    active: 1,
                    blocked: 0,
                    pending: 0,
                    cancelled: 0,
                  },
                },
                tickets: [
                  {
                    id: 4,
                    displayId: "T-4",
                    title: "Export",
                    state: "running",
                    repo: "backend",
                    stage: "implement",
                    startedAt: "2026-11-01T11:00:00.000Z",
                    elapsedMs: 25 * 60_000,
                    meanMs: 10 * 60_000,
                    slow: true,
                  },
                ],
              },
            ],
            awaitingAcceptance: [
              {
                spec: {
                  id: 5,
                  displayId: "S-5",
                  slug: "r",
                  title: "Ready",
                  type: "feature",
                  state: "awaiting-review",
                  pauseReason: null,
                  project: "shop",
                  progress: {
                    total: 1,
                    done: 1,
                    active: 0,
                    blocked: 0,
                    pending: 0,
                    cancelled: 0,
                  },
                },
                pullRequestCount: 2,
                verifiedCriteria: 1,
                totalCriteria: 3,
              },
            ],
            recentlyCompleted: [
              {
                spec: {
                  id: 1,
                  displayId: "S-1",
                  slug: "done",
                  title: "Shipped",
                  type: "feature",
                  state: "merged",
                  pauseReason: null,
                  project: "shop",
                  progress: {
                    total: 1,
                    done: 1,
                    active: 0,
                    blocked: 0,
                    pending: 0,
                    cancelled: 0,
                  },
                },
                completedAt: "2026-11-01T10:00:00.000Z",
              },
            ],
          },
        }),
      }),
    );

    const waiting = within(await screen.findByTestId("quadrant-等你处理"));
    expect(
      waiting.getByRole("link", { name: "T-9" }).getAttribute("href"),
    ).toBe("/tickets/9");
    expect(waiting.getByText("模型放弃").title).toBe("agent-gave-up");

    const running = within(screen.getByTestId("quadrant-正在运行"));
    expect(
      running.getByRole("link", { name: "S-3" }).getAttribute("href"),
    ).toBe("/specs/3");
    expect(
      running.getByRole("link", { name: "T-4" }).getAttribute("href"),
    ).toBe("/tickets/4");
    expect(running.getByText(/implement/)).toBeTruthy();
    expect(running.getByText(/已运行 25 分钟/)).toBeTruthy();
    expect(running.getByText("偏慢")).toBeTruthy();

    const review = within(screen.getByTestId("quadrant-等你验收"));
    expect(review.getByRole("link", { name: "S-5" }).getAttribute("href")).toBe(
      "/specs/5",
    );
    expect(review.getByText(/2 个 PR/)).toBeTruthy();
    expect(review.getByText(/验收标准 1\/3/)).toBeTruthy();
    expect(review.getByText("待验收").title).toBe("awaiting-review");

    const done = within(screen.getByTestId("quadrant-最近完成"));
    expect(done.getByRole("link", { name: "S-1" }).getAttribute("href")).toBe(
      "/specs/1",
    );
    expect(done.getByTitle("2026-11-01 10:00:00 UTC")).toBeTruthy();
  });
});
