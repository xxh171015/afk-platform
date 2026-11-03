// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpecList } from "./SpecList.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const spec = (over: Record<string, unknown> = {}) => ({
  id: 1,
  displayId: "S-1",
  slug: "order-export",
  title: "Order export",
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
    total: 4,
    done: 1,
    active: 1,
    blocked: 1,
    pending: 1,
    cancelled: 0,
  },
  ...over,
});

describe("the spec list", () => {
  it("shows every spec with its state and how far it has got", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        json: {
          specs: [
            spec({
              id: 2,
              displayId: "S-2",
              title: "Second",
              state: "draft",
              project: "other",
              repos: [],
              progress: {
                total: 0,
                done: 0,
                active: 0,
                blocked: 0,
                pending: 0,
                cancelled: 0,
              },
            }),
            spec(),
          ],
        },
      }),
    });
    renderWithApp(<SpecList />, server);

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3); // header and two specs
    expect(rows[0]?.textContent).toMatch(
      /编号.*标题.*项目.*类型.*状态.*进度.*开始.*结束/,
    );
    const draft = within(
      rows.find((row) => row.textContent?.includes("S-2")) as HTMLElement,
    );
    expect(draft.getByText("S-2")).toBeTruthy();
    expect(draft.getByTitle("draft").textContent).toBe("草稿");
    expect(draft.getByText("尚未导入票")).toBeTruthy();
    expect(draft.getByText("0/0 已完成")).toBeTruthy();

    const running = within(
      rows.find((row) =>
        row.textContent?.includes("Order export"),
      ) as HTMLElement,
    );
    expect(running.getByText("acme/shop-backend")).toBeTruthy();
    expect(running.getByTitle("acme/shop-backend")).toBeTruthy();
    expect(running.getByText("Order export")).toBeTruthy();
    expect(running.getByText("2026-10-28 09:00")).toBeTruthy();
    expect(running.getByText("—")).toBeTruthy();
    expect(running.getByTitle("running").textContent).toBe("运行中");
    expect(running.getByText("1/4 已完成，1 张卡住")).toBeTruthy();
    const bar = running.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
  });

  it("shows the merged end time instead of a dash", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        json: {
          specs: [
            spec({
              state: "merged",
              endedAt: "2026-11-01T10:00:00.000Z",
              progress: {
                total: 1,
                done: 1,
                active: 0,
                blocked: 0,
                pending: 0,
                cancelled: 0,
              },
            }),
          ],
        },
      }),
    });
    renderWithApp(<SpecList />, server);
    const row = within(
      (await screen.findAllByRole("row")).find((item) =>
        item.textContent?.includes("Order export"),
      ) as HTMLElement,
    );
    expect(row.getByText("2026-10-28 09:00")).toBeTruthy();
    expect(row.getByText("2026-11-01 18:00")).toBeTruthy();
    expect(row.queryByText("—")).toBeNull();
  });

  it("links each spec to its page", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        json: { specs: [spec({ id: 7, displayId: "S-7" })] },
      }),
    });
    renderWithApp(<SpecList />, server);
    const link = await screen.findByRole("link", { name: "S-7" });
    expect(link.getAttribute("href")).toBe("/specs/7");
  });

  it("does not mention blocked tickets when there are none", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        json: {
          specs: [
            spec({
              progress: {
                total: 2,
                done: 2,
                active: 0,
                blocked: 0,
                pending: 0,
                cancelled: 0,
              },
              state: "finalizing",
            }),
          ],
        },
      }),
    });
    renderWithApp(<SpecList />, server);
    expect(await screen.findByText("2/2 已完成")).toBeTruthy();
    expect(screen.queryByText(/卡住/)).toBeNull();
  });

  it("filters the project column by GitHub owner/name", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        json: {
          specs: [
            spec(),
            spec({
              id: 2,
              displayId: "S-2",
              title: "Other app",
              repos: [
                {
                  name: "app",
                  url: "https://github.com/other/app.git",
                  hostKind: "github",
                },
              ],
            }),
          ],
        },
      }),
    });
    renderWithApp(<SpecList />, server);
    await screen.findByText("Order export");
    fireEvent.click(screen.getByLabelText("按项目筛选"));
    fireEvent.click(await screen.findByRole("option", { name: "other/app" }));
    expect(screen.queryByText("Order export")).toBeNull();
    expect(screen.getByText("Other app")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "other/app" }).getAttribute("href"),
    ).toBe("https://github.com/other/app");
  });

  it("says so when there is nothing yet", async () => {
    renderWithApp(
      <SpecList />,
      fakeServer({ "GET /specs": () => ({ json: { specs: [] } }) }),
    );
    expect(await screen.findByText("还没有需求")).toBeTruthy();
  });

  it("says it is loading, and then says what went wrong when the API fails", async () => {
    const server = fakeServer({
      "GET /specs": () => ({
        status: 500,
        json: { error: "database is down" },
      }),
    });
    renderWithApp(<SpecList />, server);
    expect(screen.getByText("加载需求…")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法加载需求: database is down");
  });

  it("keeps showing the list when a later GET fails", async () => {
    let failing = false;
    const server = fakeServer({
      "GET /specs": () =>
        failing
          ? { status: 500, json: { error: "database is down" } }
          : { json: { specs: [spec()] } },
    });
    const { queryClient } = renderWithApp(<SpecList />, server);
    await screen.findByText("Order export");
    failing = true;
    await queryClient.refetchQueries({ queryKey: ["specs"] });
    await waitFor(() =>
      expect(queryClient.getQueryState(["specs"])?.status).toBe("error"),
    );
    expect(screen.getByText("Order export")).toBeTruthy();
    expect(screen.queryByText(/无法加载需求/)).toBeNull();
  });
});
