// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, renderApp } from "./test-utils.tsx";

afterEach(cleanup);

const emptyWaiting = {
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
  planning: [],
  specs: [],
  items: [],
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
    "GET /metrics": () => ({
      json: {
        since: null,
        weeks: Array.from({ length: 12 }, () => ({
          weekStart: "2026-11-09",
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
        })),
      },
    }),
    "GET /projects": () => ({ json: { projects: [] } }),
    "GET /search": () => ({
      json: {
        specs: [
          {
            id: 3,
            displayId: "S-3",
            title: "Third",
            state: "running",
            matched: ["id"],
          },
        ],
        tickets: [],
      },
    }),
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
            repos: [
              {
                name: "backend",
                url: "https://github.com/acme/shop-backend.git",
                hostKind: "github",
              },
            ],
            startedAt: "2026-10-28T01:00:00.000Z",
            endedAt: null,
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
        nextCursor: null,
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              hostKind: "github",
            },
          ],
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
          repoUrl: "https://github.com/acme/shop-backend.git",
          hostKind: "github",
          brief: null,
          body: "## What to build\n\nShip the only ticket.\n",
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
        runs: [
          {
            id: 4,
            displayId: "R-4",
            stage: "implement",
            attempt: 1,
            result: "done",
            durationMs: 1000,
            agent: null,
            model: null,
            skillsSha: null,
            axis: null,
            cursorCliVersion: null,
            contractShas: null,
            refShas: null,
            startedAt: "2026-10-28T10:00:00.000Z",
            finishedAt: "2026-10-28T10:00:01.000Z",
          },
        ],
        findings: [],
        gateResults: [],
      },
    }),
    "GET /runs/4": () => ({
      json: {
        id: 4,
        displayId: "R-4",
        specId: 3,
        specDisplayId: "S-3",
        ticketId: 9,
        ticketDisplayId: "T-9",
        stage: "implement",
        attempt: 1,
        result: "done",
        durationMs: 1000,
        agent: null,
        model: null,
        skillsSha: null,
        axis: null,
        cursorCliVersion: null,
        contractShas: null,
        refShas: null,
        startedAt: "2026-10-28T10:00:00.000Z",
        finishedAt: "2026-10-28T10:00:01.000Z",
        prompt: null,
        output: null,
        commits: [],
        repoUrl: "https://github.com/acme/shop-backend.git",
        hostKind: "github",
      },
    }),
    "GET /runs/4/logs": () => ({
      json: {
        attempt: 1,
        offset: 0,
        nextOffset: 0,
        size: 0,
        text: "",
        finished: true,
      },
    }),
  });

describe("the app", () => {
  it("starts on the workbench, not a spec table", async () => {
    renderApp(server());
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "S-3" })).toBeNull();
    expect(screen.queryByText("shop")).toBeNull();
  });

  it("remembers light and dark in afk-theme, not the system", async () => {
    const mem: Record<string, string> = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => mem[key] ?? null,
        setItem: (key: string, value: string) => {
          mem[key] = value;
        },
        removeItem: (key: string) => {
          delete mem[key];
        },
      },
    });
    document.documentElement.classList.add("dark");
    renderApp(server());
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "切换到亮色" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mem["afk-theme"]).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "切换到暗色" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mem["afk-theme"]).toBe("dark");
  });

  it("opens a ticket sheet from a graph node without leaving the spec", async () => {
    const { router } = renderApp(server(), "/specs/3");
    fireEvent.click(await screen.findByTestId("node-T-9"));
    expect(await screen.findByText("Ship the only ticket.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "R-4" }).getAttribute("href")).toBe(
      "/runs/4",
    );
    expect(
      (await screen.findByRole("link", { name: "打开票详情" })).getAttribute(
        "href",
      ),
    ).toBe("/tickets/9");
    expect(router.state.location.pathname).toBe("/specs/3");
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
    expect(
      (await screen.findAllByRole("link", { name: "T-9" })).length,
    ).toBeGreaterThan(0);
    await router.navigate({
      to: "/specs/$specId/timeline",
      params: { specId: "3" },
    });
    expect(await screen.findByText("还没有时间线事件")).toBeTruthy();
  });

  it("opens a ticket at /tickets/<id>", async () => {
    renderApp(server(), "/tickets/9");
    expect(
      (await screen.findByRole("heading", { level: 1, name: /T-9/ }))
        .textContent,
    ).toContain("T-9");
    expect(screen.getAllByText("Only ticket").length).toBeGreaterThan(0);
  });

  it("opens a run at /runs/<id>", async () => {
    renderApp(server(), "/runs/4");
    expect(await screen.findByRole("heading", { name: /R-4/ })).toBeTruthy();
    expect(screen.getByText("implement")).toBeTruthy();
    expect(screen.getByText("次数")).toBeTruthy();
  });

  it("opens a run from ⌘K when you type R-n", async () => {
    const { router } = renderApp(server(), "/");
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "搜索需求与票" }));
    const box = await screen.findByPlaceholderText("搜索需求与票");
    fireEvent.change(box, { target: { value: "R-4" } });
    fireEvent.click(await screen.findByRole("option", { name: "R-4" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/4"));
    expect(await screen.findByRole("heading", { name: /R-4/ })).toBeTruthy();
  });

  it("shows the queue at /waiting and counts it in the menu", async () => {
    const waiting = {
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
      specs: [{ id: 3, displayId: "S-3", title: "Third", reason: "paused" }],
      items: [
        { kind: "ticket", id: 1 },
        { kind: "pausedSpec", id: 3 },
      ],
    };
    const fake = fakeServer({
      "GET /workbench": () => ({
        json: { ...emptyWorkbench, waiting },
      }),
      "GET /blocked": () => ({ json: waiting }),
    });
    renderApp(fake, "/waiting");
    expect(await screen.findByTestId("blocked-T-1")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: "待处理 (2)" })[0]
        ?.getAttribute("href"),
    ).toBe("/waiting");
    expect(
      screen.getAllByRole("link", { name: "工作台" })[0]?.getAttribute("href"),
    ).toBe("/");
    expect(
      screen.getAllByRole("link", { name: "需求" })[0]?.getAttribute("href"),
    ).toBe("/specs");
    expect(
      screen.getAllByRole("link", { name: "度量" })[0]?.getAttribute("href"),
    ).toBe("/metrics");
  });

  it("counts waiting from the workbench without loading briefs", async () => {
    const fake = fakeServer({
      "GET /workbench": () => ({
        json: {
          ...emptyWorkbench,
          waiting: {
            ...emptyWaiting,
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
              },
            ],
            items: [{ kind: "ticket", id: 1 }],
          },
        },
      }),
      "GET /projects": () => ({
        json: { projects: [{ id: 1, name: "shop" }] },
      }),
      "GET /version": () => ({
        json: {
          platformVersion: "0.2.0",
          skillsSha: "x",
          platformCommit: "abc",
        },
      }),
    });
    renderApp(fake, "/");
    expect(
      (await screen.findAllByRole("link", { name: "待处理 (1)" })).length,
    ).toBeGreaterThan(0);
    expect(fake.calls).not.toContain("GET /blocked");
  });

  it("does not show a count in the menu when nothing waits", async () => {
    renderApp(server());
    expect(
      (await screen.findAllByRole("link", { name: "待处理" })).length,
    ).toBeGreaterThan(0);
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

  it("goes home, to waiting, specs and metrics with g h / g b / g s / g m", async () => {
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
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/metrics"),
    );
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

  it("shows Linear-style crumbs with sibling specs and overflow actions", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const fake = fakeServer({
      "GET /workbench": () => ({ json: emptyWorkbench }),
      "GET /blocked": () => ({ json: emptyWaiting }),
      "GET /search": () => ({
        json: {
          specs: [
            {
              id: 2,
              displayId: "S-2",
              title: "Second",
              state: "draft",
              matched: ["id"],
            },
            {
              id: 3,
              displayId: "S-3",
              title: "Third",
              state: "running",
              matched: ["id"],
            },
          ],
          tickets: [],
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
            repos: [
              {
                name: "backend",
                url: "https://github.com/acme/shop-backend.git",
                hostKind: "github",
              },
            ],
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
            state: "pending",
            blockedReason: null,
            repo: "backend",
            repoUrl: "https://github.com/acme/shop-backend.git",
            hostKind: "github",
            brief: null,
            body: "",
            file: "---\nid: T-9\n---\n",
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
    const { router } = renderApp(fake, "/specs/3");
    const crumbs = await screen.findByTestId("entity-crumbs");
    expect(
      (await within(crumbs).findByRole("link", { name: "acme" })).getAttribute(
        "href",
      ),
    ).toBe("https://github.com/acme");
    expect(
      within(crumbs).getByRole("link", { name: "需求" }).getAttribute("href"),
    ).toBe("/specs");
    await waitFor(() =>
      expect(within(crumbs).getByTestId("crumb-siblings").dataset.count).toBe(
        "2",
      ),
    );
    expect(fake.calls).toContain("GET /search");
    expect(fake.calls).not.toContain("GET /specs");
    const siblings = within(crumbs).getByTestId("crumb-siblings");
    fireEvent.pointerDown(siblings, { button: 0 });
    expect(
      (
        await screen.findByRole("menuitem", { name: /S-2 Second/ })
      ).getAttribute("href"),
    ).toBe("/specs/2");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(
      within(crumbs).getByRole("button", { name: "更多操作" }),
      {
        button: 0,
      },
    );
    expect(
      (
        await screen.findByRole("menuitem", { name: "在 GitHub 打开" })
      ).getAttribute("href"),
    ).toBe("https://github.com/acme/shop-backend");
    expect(
      screen.getByRole("menuitem", { name: "时间线" }).getAttribute("href"),
    ).toBe("/specs/3/timeline");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制编号" }));
    expect(writeText).toHaveBeenCalledWith("S-3");

    await router.navigate({
      to: "/tickets/$ticketId",
      params: { ticketId: "9" },
    });
    const ticketCrumbs = await screen.findByTestId("entity-crumbs");
    expect(within(ticketCrumbs).getByText("S-3")).toBeTruthy();
    expect(within(ticketCrumbs).getByText("T-9")).toBeTruthy();
    expect(
      within(ticketCrumbs).getAllByRole("button", { name: "切换兄弟项" }),
    ).toHaveLength(2);
    fireEvent.pointerDown(
      within(ticketCrumbs).getByRole("button", { name: "更多操作" }),
      { button: 0 },
    );
    expect(
      await screen.findByRole("menuitem", { name: "改正文" }),
    ).toBeTruthy();
  });

  it("says 在 GitLab 打开 when the spec's repos are on GitLab", async () => {
    const fake = fakeServer({
      "GET /workbench": () => ({ json: emptyWorkbench }),
      "GET /blocked": () => ({ json: emptyWaiting }),
      "GET /search": () => ({ json: { specs: [], tickets: [] } }),
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
            repos: [
              {
                name: "backend",
                url: "https://gitlab.com/acme/shop-backend.git",
                hostKind: "gitlab",
              },
            ],
          },
          tickets: [],
          edges: [],
          finalizations: [],
          pullRequests: [],
          mergeOrder: { ordered: [], after: {}, unordered: [] },
          orderBroken: [],
          acceptancePack: null,
          timeline: [],
          finalRuns: [],
        },
      }),
    });
    renderApp(fake, "/specs/3");
    const crumbs = await screen.findByTestId("entity-crumbs");
    fireEvent.pointerDown(
      within(crumbs).getByRole("button", { name: "更多操作" }),
      { button: 0 },
    );
    expect(
      (
        await screen.findByRole("menuitem", { name: "在 GitLab 打开" })
      ).getAttribute("href"),
    ).toBe("https://gitlab.com/acme/shop-backend");
  });

  it("opens help with ?", async () => {
    renderApp(server());
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByRole("heading", { name: "快捷键" })).toBeTruthy();
  });
});
