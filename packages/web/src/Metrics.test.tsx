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
  it("shows the three blocks, empty weeks, spec links and the 3% line", async () => {
    renderWithApp(<Metrics />, server());
    expect(await screen.findByText("数据从 2026-08-24 起")).toBeTruthy();
    expect(screen.getAllByText("2026-08-24").length).toBeGreaterThan(1);
    expect(screen.getByTestId("metrics-lead-time").textContent).toContain("无");
    expect(
      screen
        .getByRole("link", { name: "S-1 Order export" })
        .getAttribute("href"),
    ).toBe("/specs/1");
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "要人处理",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "自动恢复",
    );
    expect(screen.getByTestId("metrics-attribution").textContent).toContain(
      "模型放弃",
    );
    expect(screen.getByTestId("failure-rate-line")).toBeTruthy();
    expect(screen.getByTestId("metrics-failure-rate").textContent).toContain(
      "3%",
    );
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
    const select = await screen.findByRole("combobox", { name: "项目" });
    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() => expect(projectId).toBe("1"));
  });
});
