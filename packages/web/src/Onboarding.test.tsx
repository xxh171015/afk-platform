// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const server = (projects: unknown[], platformCommit: string | null = COMMIT) =>
  fakeServer({
    "GET /projects": () => ({
      json: {
        projects: (projects as { id: number; name: string }[]).map((p) => ({
          feishuChatId: null,
          ...p,
        })),
      },
    }),
    "GET /version": () => ({
      json: { platformVersion: "0.2.0", skillsSha: "x", platformCommit },
    }),
  });

describe("getting a project onto the platform from the control tower", () => {
  it("is in plain sight while there is no project: the install command pinned to the platform's commit, to copy, then /afk-setup", async () => {
    renderWithApp(<Onboarding address="https://afk.example.com" />, server([]));

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    // one command, the platform's address in it: nothing to choose, nothing to be asked
    const command = "curl -fsSL https://afk.example.com/setup.sh | sh";
    expect((await within(block).findAllByText(command)).length).toBeGreaterThan(
      0,
    );
    expect(
      within(block).getAllByRole("button", { name: `复制命令 ${command}` })
        .length,
    ).toBeGreaterThan(0);
    expect(block.textContent).toContain("Cursor 或 Claude Code");
    expect(block.textContent).toContain("/afk-setup");
    expect(block.textContent).not.toContain("平台地址时填");
    expect(block.textContent).not.toContain("npx skills");
    expect(block.textContent).not.toContain("只能在平台所在的机器上用");
  });

  it("says the command only works on the platform's machine when the address is local", async () => {
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, server([]));

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    expect(block.textContent).toContain("只能在平台所在的机器上用");
  });

  it("folds away once there is a project, and can still be found", async () => {
    renderWithApp(
      <Onboarding address="http://localhost:3000" />,
      server([{ id: 1, name: "shop" }]),
    );

    const entry = await screen.findByText("接入新项目");
    const details = entry.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.queryByRole("region", { name: "接入第一个项目" })).toBeNull();
    expect(
      (
        await within(details).findAllByText(
          "curl -fsSL http://localhost:3000/setup.sh | sh",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("gives no unpinned command when the platform does not say its commit", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      server([], null),
    );

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    expect(
      await within(block).findByText(
        "curl -fsSL http://127.0.0.1:3000/setup.sh | sh",
      ),
    ).toBeTruthy();
    expect(block.textContent).not.toContain("npx skills");
  });

  it("shows no checks to run by hand before plat doctor has stored a report", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      server([{ id: 1, name: "shop" }]),
    );

    const entry = await screen.findByText("接入新项目");
    const details = entry.closest("details") as HTMLDetailsElement;
    await within(details).findByText(
      "curl -fsSL http://127.0.0.1:3000/setup.sh | sh",
    );
    expect(within(details).queryByRole("region", { name: "本机" })).toBeNull();
    expect(details.textContent).not.toContain("plat connect");
    expect(details.textContent).not.toContain("plat tracker-doc");
    expect(details.textContent).not.toContain("test -f AGENTS.md");
  });

  it("shows an error and retry when the projects cannot be listed", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      fakeServer({
        "GET /projects": () => ({ status: 500, json: { error: "down" } }),
        "GET /version": () => ({
          json: {
            platformVersion: "0.2.0",
            skillsSha: "x",
            platformCommit: COMMIT,
          },
        }),
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法读取项目: down");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("接入新项目")).toBeNull();
  });

  it("shows the machine, results and time after plat doctor has stored a report", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      fakeServer({
        "GET /projects": () => ({
          json: { projects: [{ id: 1, name: "shop", feishuChatId: null }] },
        }),
        "GET /version": () => ({
          json: {
            platformVersion: "0.2.0",
            skillsSha: "x",
            platformCommit: COMMIT,
          },
        }),
        "GET /projects/1/doctor-report": () => ({
          json: {
            report: {
              machine: "dev-mac",
              checkedAt: "2026-11-11T05:00:00.000Z",
              items: [
                { id: "skills", title: "skills", status: "ok" },
                {
                  id: "plat",
                  title: "plat",
                  status: "fail",
                  detail: "this plat is from platform 0.1.0",
                  command: "plat update",
                },
                {
                  id: "tracker-doc",
                  title: "Tracker doc",
                  status: "fail",
                  detail: "docs/agents/issue-tracker.md is out of date",
                  command: "run the afk-setup skill",
                },
                {
                  id: "agents-md",
                  title: "AGENTS.md",
                  status: "fail",
                  detail:
                    "AGENTS.md is not on the default branch or origin/afk/setup",
                  command: "run the afk-setup skill",
                },
              ],
            },
          },
        }),
      }),
    );
    const entry = await screen.findByText("接入新项目");
    const details = entry.closest("details") as HTMLDetailsElement;
    expect(await within(details).findByText(/dev-mac 已检查/)).toBeTruthy();
    expect(details.textContent).toContain("2026-11-11 13:00:00");
    expect(details.textContent).toContain("通过");
    expect(details.textContent).toContain("this plat is from platform 0.1.0");
    expect(details.textContent).toContain("plat update");
    expect(details.textContent).toContain(
      "docs/agents/issue-tracker.md is out of date",
    );
  });

  it("lists connected projects without Feishu or repo checks inside onboarding", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      server([{ id: 1, name: "shop" }]),
    );
    const connected = await screen.findByRole("region", {
      name: "已接入的项目",
    });
    expect(within(connected).getByText("shop")).toBeTruthy();
    expect(
      within(connected)
        .getByRole("link", { name: "设置" })
        .getAttribute("href"),
    ).toContain("/projects/1");
    fireEvent.click(screen.getByText("接入新项目"));
    const details = screen.getByText("接入新项目").closest("details");
    expect(details).not.toBeNull();
    if (!details) return;
    expect(within(details).queryByText("飞书")).toBeNull();
    expect(
      within(details).queryByRole("button", { name: "现在检查" }),
    ).toBeNull();
    expect(within(connected).getByText("未配飞书群")).toBeTruthy();
  });

  it("fills in a chat id from the project page when the list omits it", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      fakeServer({
        "GET /projects": () => ({
          json: { projects: [{ id: 1, name: "shop" }] },
        }),
        "GET /version": () => ({
          json: {
            platformVersion: "0.2.0",
            skillsSha: "x",
            platformCommit: COMMIT,
          },
        }),
        "GET /projects/1": () => ({
          json: {
            id: 1,
            name: "shop",
            defaultAgent: null,
            feishuChatId: "oc_shop",
            repos: [],
          },
        }),
      }),
    );
    const connected = await screen.findByRole("region", {
      name: "已接入的项目",
    });
    expect(within(connected).getByText("已配飞书群")).toBeTruthy();
  });

  it("marks a project as 已配飞书群 when the list includes a chat id", async () => {
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      server([{ id: 1, name: "shop", feishuChatId: "oc_shop" }]),
    );
    const connected = await screen.findByRole("region", {
      name: "已接入的项目",
    });
    expect(within(connected).getByText("已配飞书群")).toBeTruthy();
    expect(within(connected).queryByText("未配飞书群")).toBeNull();
  });

  it("lets a person retry when the platform cannot be reached", async () => {
    let tries = 0;
    renderWithApp(
      <Onboarding address="http://127.0.0.1:3000" />,
      fakeServer({
        "GET /projects": () => ({ json: { projects: [] } }),
        "GET /version": () => {
          tries += 1;
          if (tries === 1) return { status: 500, json: { error: "down" } };
          return {
            json: {
              platformVersion: "0.2.0",
              skillsSha: "x",
              platformCommit: COMMIT,
            },
          };
        },
      }),
    );
    const access = await screen.findByRole("region", { name: "接入条件" });
    await waitFor(() => expect(access.textContent).toContain("失败"));
    fireEvent.click(within(access).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(access.textContent).toContain("通过"));
  });
});
