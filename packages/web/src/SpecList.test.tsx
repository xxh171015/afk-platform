// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
    const draft = within(
      rows.find((row) => row.textContent?.includes("S-2")) as HTMLElement,
    );
    expect(draft.getByText("S-2")).toBeTruthy();
    expect(draft.getByTitle("draft").textContent).toBe("草稿");
    expect(draft.getByText("other")).toBeTruthy();
    expect(draft.getByText("0/0 已完成")).toBeTruthy();

    const running = within(
      rows.find((row) =>
        row.textContent?.includes("Order export"),
      ) as HTMLElement,
    );
    expect(running.getByText("Order export")).toBeTruthy();
    expect(running.getByTitle("running").textContent).toBe("运行中");
    expect(running.getByText("1/4 已完成，1 张卡住")).toBeTruthy();
    const bar = running.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
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
