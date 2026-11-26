// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { emptyWorkbench, fakeServer, renderApp } from "./test-utils.tsx";

afterEach(cleanup);

function server() {
  return fakeServer({
    "GET /workbench": () => ({ json: emptyWorkbench }),
    "GET /projects": () => ({ json: { projects: [{ id: 1, name: "AFK" }] } }),
    "GET /projects/1": () => ({
      json: { project: { id: 1, name: "AFK" }, repos: [] },
    }),
    "GET /specs": () => ({ json: { specs: [], nextCursor: null } }),
  });
}

describe("workspace navigation", () => {
  it("marks the current destination and keeps icon navigation named when collapsed", async () => {
    renderApp(server(), "/specs");
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(
      within(nav)
        .getByRole("link", { name: "需求" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "工作台" })
        .getAttribute("aria-current"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(
      within(nav).getByRole("link", { name: "需求" }).getAttribute("title"),
    ).toBe("需求");
    fireEvent.click(screen.getByRole("button", { name: "展开侧边栏" }));
    expect(
      within(nav).getByRole("link", { name: "需求" }).textContent,
    ).toContain("需求");
  });

  it("opens shortcut help from a visible control", async () => {
    renderApp(server());
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "快捷键帮助" }));
    const dialog = screen.getByRole("dialog", { name: "快捷键" });
    expect(within(dialog).getByText("g h")).toBeTruthy();
    expect(within(dialog).getByText("审查页")).toBeTruthy();
    expect(within(dialog).getByText("j")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the mobile navigation after choosing a destination", async () => {
    const { router } = renderApp(server());
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    const dialog = screen.getByRole("dialog", { name: "工作区导航" });
    fireEvent.click(within(dialog).getByRole("link", { name: "需求" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/specs"));
    expect(screen.queryByRole("dialog", { name: "工作区导航" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "需求" })).toBeTruthy();
  });

  it("dismisses the mobile navigation with Escape and restores its trigger", async () => {
    renderApp(server());
    const trigger = await screen.findByRole("button", { name: "打开导航" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "工作区导航" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the theme control in sync after changing it in mobile navigation", async () => {
    document.documentElement.classList.add("dark");
    renderApp(server());
    fireEvent.click(await screen.findByRole("button", { name: "打开导航" }));
    const dialog = screen.getByRole("dialog", { name: "工作区导航" });
    fireEvent.click(within(dialog).getByRole("button", { name: "切换到亮色" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "切换到暗色" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
