// @vitest-environment jsdom
import { lastWeekStarts } from "@afk/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "./lib/theme.ts";
import { Metrics } from "./Metrics.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const emptyWeek = (weekStart: string) => ({
  weekStart,
  leadTime: {
    ended: 0,
    medianMs: null,
    agentMs: 0,
    gateMs: 0,
    queuedMs: 0,
    waitingMs: 0,
    specs: [],
  },
  attribution: { recovered: [], needsHuman: [] },
  failureRate: {
    ended: 0,
    platform: null,
    external: null,
    jobPlatform: null,
  },
  success: {
    mergedPulls: 0,
    mergeRate: null,
    humanCommitsRate: null,
    untouchedRate: null,
  },
  agentsPauses: [] as { pausedMinutes: number; automatic: boolean }[],
});

const weekStarts = lastWeekStarts(new Date("2026-11-09T12:00:00+08:00"));
const weeks = weekStarts.map((weekStart, i) =>
  i < weekStarts.length - 1
    ? emptyWeek(weekStart)
    : {
        weekStart,
        leadTime: {
          ended: 1,
          medianMs: 3_600_000,
          agentMs: 1_800_000,
          gateMs: 600_000,
          queuedMs: 400_000,
          waitingMs: 800_000,
          specs: [
            {
              id: 1,
              displayId: "S-1",
              title: "Order export",
              totalMs: 3_600_000,
            },
          ],
        },
        attribution: {
          recovered: [{ source: "external", reason: "job-failed", count: 1 }],
          needsHuman: [{ source: "agent", reason: "agent-gave-up", count: 1 }],
        },
        failureRate: {
          ended: 2,
          platform: 0,
          external: 0,
          jobPlatform: 0.1,
        },
        success: {
          mergedPulls: 2,
          mergeRate: 0.5,
          humanCommitsRate: 0.25,
          untouchedRate: 1,
        },
        agentsPauses: [
          { pausedMinutes: 15, automatic: true },
          { pausedMinutes: 125, automatic: false },
        ],
      },
);

const server = () =>
  fakeServer({
    "GET /metrics": () => ({ json: { since: "2026-08-24", weeks } }),
    "GET /projects": () => ({
      json: { projects: [{ id: 1, name: "shop" }] },
    }),
  });

describe("the metrics page", () => {
  it("shows 工期, 失败归因, 平台故障率, 成功标准, spec links and the 3% line", async () => {
    renderWithApp(<Metrics />, server());
    expect(await screen.findByText("数据从 2026-08-24 起")).toBeTruthy();
    expect(screen.getByTestId("metrics-success").textContent).toContain(
      "2026-08-24",
    );
    expect(screen.getByTestId("lead-time-chart")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "S-1 Order export" })
        .getAttribute("href"),
    ).toBe("/specs/1");
    expect(screen.getByTestId("metrics-lead-time").textContent).not.toContain(
      "无",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "要人处理",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "自动恢复",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "模型放弃",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).not.toContain(
      weekStarts[0],
    );
    expect(screen.getByTestId("failure-rate-line")).toBeTruthy();
    expect(screen.getByTestId("metrics-failure-rate").textContent).toContain(
      "3%",
    );
    expect(screen.getByTestId("metrics-failure-rate").textContent).toContain(
      weekStarts[0]?.slice(5),
    );
    const success = screen.getByTestId("metrics-success");
    expect(success.textContent).toContain("合并的 MR / PR");
    expect(success.textContent).toContain("无人插手");
    expect(success.textContent).toContain("50.0%");
    expect(success.textContent).toContain("25.0%");
    expect(success.textContent).toContain("100.0%");
  });

  it("lists the weeks the agents were paused, with each pause's length and how it ended", async () => {
    renderWithApp(<Metrics />, server());
    const pauses = await screen.findByTestId("metrics-agents-pauses");
    expect(pauses.textContent).toContain(weekStarts.at(-1));
    expect(pauses.textContent).toContain("暂停 2 次，自动恢复 1 次");
    expect(pauses.textContent).toContain("15m 00s 自动恢复");
    expect(pauses.textContent).toContain("2h 05m 手动恢复");
    expect(pauses.textContent).not.toContain(weekStarts[0]);
  });

  it("keeps the 3% line in both themes", async () => {
    applyTheme("light");
    renderWithApp(<Metrics />, server());
    expect(await screen.findByTestId("failure-rate-line")).toBeTruthy();
    applyTheme("dark");
    expect(screen.getByTestId("failure-rate-line")).toBeTruthy();
  });

  it("lets the project filter be all or one project", async () => {
    let projectId: string | null = null;
    const fake = fakeServer({
      "GET /metrics": ({ url }) => {
        projectId = url.searchParams.get("projectId");
        return { json: { since: "2026-08-24", weeks } };
      },
      "GET /projects": () => ({
        json: { projects: [{ id: 1, name: "shop" }] },
      }),
    });
    renderWithApp(<Metrics />, fake);
    fireEvent.click(await screen.findByRole("tab", { name: "shop" }));
    await waitFor(() => expect(projectId).toBe("1"));
  });

  it("defaults to the latest week with ended specs and switches the list on click", async () => {
    const first = weekStarts[0] as string;
    const custom = weeks.map((week, i) =>
      i === 0
        ? {
            ...week,
            leadTime: {
              ...week.leadTime,
              ended: 1,
              specs: [
                {
                  id: 2,
                  displayId: "S-2",
                  title: "Old spec",
                  totalMs: 1,
                },
              ],
            },
          }
        : week,
    );
    const fake = fakeServer({
      "GET /metrics": () => ({ json: { since: "2026-08-24", weeks: custom } }),
      "GET /projects": () => ({
        json: { projects: [{ id: 1, name: "shop" }] },
      }),
    });
    renderWithApp(<Metrics />, fake);
    expect(
      await screen.findByRole("link", { name: "S-1 Order export" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "S-2 Old spec" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `工期 ${first}` }));
    expect(screen.getByRole("link", { name: "S-2 Old spec" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "S-1 Order export" })).toBeNull();
  });
});
