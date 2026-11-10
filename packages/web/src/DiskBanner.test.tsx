// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiskBanner } from "./DiskBanner.tsx";
import { emptyWorkbench, fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

describe("the disk remaining-space banner", () => {
  it("is silent when there is enough space, muted under 10 GiB, and red under 5 GiB", async () => {
    renderWithApp(
      <DiskBanner />,
      fakeServer({
        "GET /workbench": () => ({
          json: {
            ...emptyWorkbench,
            status: { ...emptyWorkbench.status, diskLevel: "ok" },
          },
        }),
      }),
    );
    expect(screen.queryByTestId("disk-banner")).toBeNull();

    cleanup();
    renderWithApp(
      <DiskBanner />,
      fakeServer({
        "GET /workbench": () => ({
          json: {
            ...emptyWorkbench,
            status: { ...emptyWorkbench.status, diskLevel: "warn" },
          },
        }),
      }),
    );
    expect((await screen.findByTestId("disk-banner")).textContent).toBe(
      "磁盘剩余不足 10 GiB",
    );
    expect(screen.getByTestId("disk-banner").className).not.toMatch(
      /state-blocked/,
    );

    cleanup();
    renderWithApp(
      <DiskBanner />,
      fakeServer({
        "GET /workbench": () => ({
          json: {
            ...emptyWorkbench,
            status: { ...emptyWorkbench.status, diskLevel: "stop" },
          },
        }),
      }),
    );
    expect((await screen.findByTestId("disk-banner")).textContent).toBe(
      "磁盘剩余不足 5 GiB，worker 已停止领取新作业",
    );
    expect(screen.getByTestId("disk-banner").className).toMatch(
      /state-blocked/,
    );
  });
});
