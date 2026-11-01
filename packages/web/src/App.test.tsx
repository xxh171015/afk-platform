// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeServer, renderApp } from "./test-utils.tsx";

afterEach(cleanup);

const emptyWaiting = {
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
  specs: [],
};

const emptyWorkbench = {
  waiting: emptyWaiting,
  running: [],
  awaitingAcceptance: [],
  recentlyCompleted: [],
};

const server = () =>
  fakeServer({
    "GET /workbench": () => ({ json: emptyWorkbench }),
    "GET /blocked": () => ({ json: emptyWaiting }),
    "GET /specs": () => ({
      json: {
        specs: [
          {
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
        ],
      },
    }),
    "GET /specs/3": () => ({
      json: {
        spec: {
          id: 3,
          displayId: "S-3",
          slug: "s",
          title: "Third",
          type: "feature",
          body: "",
          state: "running",
          pauseReason: null,
          integrationBranches: [],
          warnings: [],
        },
        tickets: [
          {
            id: 9,
            displayId: "T-9",
            specId: 3,
            specDisplayId: "S-3",
            title: "Only ticket",
            type: "implementation",
            state: "running",
            blockedReason: null,
            repo: "backend",
            brief: null,
          },
        ],
        edges: [],
        finalizations: [],
        pullRequests: [],
        mergeOrder: { ordered: [], after: {}, unordered: [] },
        orderBroken: [],
        cleanups: [],
        readyFailures: [],
        acceptancePack: null,
        timeline: [],
        finalRuns: [],
      },
    }),
    "GET /tickets/9": () => ({
      json: {
        ticket: {
          id: 9,
          displayId: "T-9",
          specId: 3,
          specDisplayId: "S-3",
          title: "Only ticket",
          type: "implementation",
          state: "done",
          blockedReason: null,
          repo: "backend",
          brief: null,
          body: "",
          acceptanceCriteria: ["works"],
          modules: [],
          allowedProtectedPaths: [],
          contentVersion: 1,
          contractSha: null,
          fixCounts: {},
          reviewed: false,
        },
        versions: [{ version: 1, createdAt: "2026-10-28T09:00:00.000Z" }],
        upstream: [],
        downstream: [],
        runs: [],
        findings: [],
        gateResults: [],
      },
    }),
  });

describe("the app", () => {
  it("starts on the workbench, not a spec table", async () => {
    renderApp(server());
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "S-3" })).toBeNull();
  });

  it("opens a spec at /specs/<id> and the spec list at /specs", async () => {
    const { router } = renderApp(server(), "/specs/3");
    expect(await screen.findByTestId("node-T-9")).toBeTruthy();
    await router.navigate({ to: "/specs" });
    expect(await screen.findByRole("link", { name: "S-3" })).toBeTruthy();
  });

  it("opens nested spec pages at shareable addresses", async () => {
    const { router } = renderApp(server(), "/specs/3/delivery");
    expect(await screen.findByText("还没有可交付的内容")).toBeTruthy();
    await router.navigate({
      to: "/specs/$specId/description",
      params: { specId: "3" },
    });
    expect(await screen.findByText("这份需求没有正文")).toBeTruthy();
    await router.navigate({
      to: "/specs/$specId/tickets",
      params: { specId: "3" },
    });
    expect(await screen.findByRole("link", { name: "T-9" })).toBeTruthy();
    await router.navigate({
      to: "/specs/$specId/timeline",
      params: { specId: "3" },
    });
    expect(await screen.findByText("还没有时间线事件")).toBeTruthy();
  });

  it("opens a ticket at /tickets/<id>", async () => {
    renderApp(server(), "/tickets/9");
    expect(
      (await screen.findByRole("heading", { level: 2 })).textContent,
    ).toContain("T-9 Only ticket");
  });

  it("shows the queue at /waiting and counts it in the menu", async () => {
    const fake = fakeServer({
      "GET /workbench": () => ({ json: emptyWorkbench }),
      "GET /blocked": () => ({
        json: {
          tickets: [
            {
              id: 1,
              displayId: "T-1",
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
          finalizations: [],
          pullRequests: [],
          cleanups: [],
          readyFailures: [],
          specs: [
            { id: 3, displayId: "S-3", title: "Third", reason: "paused" },
          ],
        },
      }),
    });
    renderApp(fake, "/waiting");
    expect(await screen.findByTestId("blocked-T-1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "待处理 (2)" }).getAttribute("href"),
    ).toBe("/waiting");
    expect(
      screen.getByRole("link", { name: "工作台" }).getAttribute("href"),
    ).toBe("/");
    expect(
      screen.getByRole("link", { name: "需求" }).getAttribute("href"),
    ).toBe("/specs");
  });

  it("does not show a count in the menu when nothing waits", async () => {
    renderApp(server());
    expect(await screen.findByRole("link", { name: "待处理" })).toBeTruthy();
  });

  it("has a search control on every page", async () => {
    renderApp(server(), "/specs/3");
    expect(
      await screen.findByRole("button", { name: "搜索需求与票" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "搜索需求与票" }));
    expect(await screen.findByPlaceholderText("搜索需求与票")).toBeTruthy();
  });

  it("does not honour a leftover hash address like #/specs/3", async () => {
    renderApp(server(), "/");
    window.location.hash = "#/specs/3";
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(screen.queryByTestId("node-T-9")).toBeNull();
  });

  it("says so for an address it does not know", async () => {
    renderApp(server(), "/nope");
    expect(await screen.findByText("没有这个页面")).toBeTruthy();
  });

  it("goes home, to waiting and to specs with g h / g b / g s", async () => {
    const { router } = renderApp(server(), "/specs");
    expect(await screen.findByRole("link", { name: "S-3" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/waiting"),
    );
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/specs"));
  });

  it("does not fire page shortcuts while typing in a field", async () => {
    const { router } = renderApp(server(), "/specs");
    await screen.findByRole("link", { name: "S-3" });
    fireEvent.click(screen.getByRole("button", { name: "搜索需求与票" }));
    const box = await screen.findByPlaceholderText("搜索需求与票");
    fireEvent.keyDown(box, { key: "g" });
    fireEvent.keyDown(box, { key: "h" });
    expect(router.state.location.pathname).toBe("/specs");
  });

  it("opens help with ?", async () => {
    renderApp(server());
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByRole("heading", { name: "快捷键" })).toBeTruthy();
  });
});
