// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DETAIL_POLL_MS } from "./live.ts";
import { Onboarding } from "./Onboarding.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const server = (projects: unknown[], platformCommit: string | null = COMMIT) =>
  fakeServer({
    "GET /projects": () => ({ json: { projects } }),
    "GET /version": () => ({
      json: { platformVersion: "0.2.0", skillsSha: "x", platformCommit },
    }),
  });

describe("getting a project onto the platform from the control tower", () => {
  it("is in plain sight while there is no project: the install command pinned to the platform's commit, to copy, then /afk-setup", async () => {
    renderWithApp(<Onboarding address="https://afk.example.com" />, server([]));

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    const command = `npx skills@latest add xxh171015/afk-platform#${COMMIT}`;
    expect((await within(block).findAllByText(command)).length).toBeGreaterThan(
      0,
    );
    expect(
      within(block).getAllByRole("button", { name: `复制命令 ${command}` })
        .length,
    ).toBeGreaterThan(0);
    expect(block.textContent).toContain("/afk-setup");
    expect(within(block).getByText("https://afk.example.com")).toBeTruthy();
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
          `npx skills@latest add xxh171015/afk-platform#${COMMIT}`,
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
      await within(block).findByText(/平台说不出它对应的提交/),
    ).toBeTruthy();
    expect(block.textContent).not.toContain("npx skills");
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
          json: { projects: [{ id: 1, name: "shop" }] },
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
    expect(details.textContent).toContain(
      "AGENTS.md is not on the default branch or origin/afk/setup",
    );
  });

  it("splits the checklist into 本机 and 接入条件, all local items 尚未检查", async () => {
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, server([]));

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    expect(within(block).getByRole("region", { name: "本机" })).toBeTruthy();
    expect(
      within(block).getByRole("region", { name: "接入条件" }),
    ).toBeTruthy();
    expect(block.textContent).toContain("尚未检查");
    expect(block.textContent).toContain("plat connect http://127.0.0.1:3000");
    expect(block.textContent).toContain("plat tracker-doc");
    expect(block.textContent).toContain("test -f AGENTS.md");
    expect(block.textContent).not.toContain("就绪检查");
    expect(block.textContent).not.toContain("gate-check");
  });

  it("checks GitHub access only when 现在检查 is clicked", async () => {
    const fake = fakeServer({
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
            {
              name: "other",
              url: "https://gitlab.com/acme/other.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "gitlab",
            },
          ],
        },
      }),
      "GET /projects/1/repos/backend/access": () => ({
        json: { state: "unchecked" },
      }),
      "GET /projects/1/repos/other/access": () => ({
        json: { state: "unchecked" },
      }),
      "POST /projects/1/repos/backend/access-check": () => ({
        json: { state: "ok", checkedAt: "2026-11-01T00:00:00.000Z" },
      }),
    });
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, fake);
    const entry = await screen.findByText("接入新项目");
    expect(fake.calls).not.toContain(
      "POST /projects/1/repos/backend/access-check",
    );
    expect(fake.calls).not.toContain("GET /projects/1/repos/backend/access");
    fireEvent.click(entry);
    const checkButtons = await screen.findAllByRole("button", {
      name: "现在检查",
    });
    expect(checkButtons).toHaveLength(2);
    expect(fake.calls).toContain("GET /projects/1/repos/backend/access");
    expect(fake.calls).toContain("GET /projects/1/repos/other/access");
    expect(fake.calls).not.toContain(
      "POST /projects/1/repos/backend/access-check",
    );
    expect(screen.queryByText("这项检查仅 GitHub 可查。")).toBeNull();
    fireEvent.click(checkButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(fake.calls).toContain(
        "POST /projects/1/repos/backend/access-check",
      ),
    );
    expect(fake.calls.some((call) => call.includes("gate-check"))).toBe(false);
    expect(screen.getAllByText("test -f AGENTS.md")).toHaveLength(1);
  });

  it("shows 检查中 and disables 现在检查 while a check is still running", async () => {
    const fake = fakeServer({
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
          ],
        },
      }),
      "GET /projects/1/repos/backend/access": () => ({
        json: {
          state: "ok",
          checkedAt: "2026-11-01T00:00:00.000Z",
          files: { gates: true, integrationCompose: false },
        },
      }),
      "POST /projects/1/repos/backend/access-check": () => ({
        json: {
          state: "ok",
          checking: true,
          checkedAt: "2026-11-01T00:00:00.000Z",
          files: { gates: true, integrationCompose: false },
        },
      }),
    });
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, fake);
    fireEvent.click(await screen.findByText("接入新项目"));
    const check = await screen.findByRole("button", { name: "现在检查" });
    const row = check.closest("li") as HTMLElement;
    await waitFor(() => expect(within(row).getByText("通过")).toBeTruthy());
    fireEvent.click(check);
    await waitFor(() => expect(within(row).getByText("检查中")).toBeTruthy());
    expect((check as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the new result once the worker answers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let access: Record<string, unknown> = {
      state: "ok",
      checkedAt: "2026-11-01T00:00:00.000Z",
      files: { gates: true, integrationCompose: false },
    };
    const fake = fakeServer({
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
          ],
        },
      }),
      "GET /projects/1/repos/backend/access": () => ({ json: access }),
      "POST /projects/1/repos/backend/access-check": () => ({
        json: { ...access, checking: true },
      }),
    });
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, fake);
    fireEvent.click(await screen.findByText("接入新项目"));
    const check = await screen.findByRole("button", { name: "现在检查" });
    fireEvent.click(check);
    await waitFor(() => expect(screen.getByText("检查中")).toBeTruthy());
    access = {
      state: "ok",
      checkedAt: "2026-11-01T00:01:00.000Z",
      files: { gates: true, integrationCompose: true },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS);
    });
    const row = check.closest("li") as HTMLElement;
    await waitFor(() =>
      expect(
        within(row).getByText("门禁文件已有；联调 compose 已有"),
      ).toBeTruthy(),
    );
    expect(within(row).getByText("通过")).toBeTruthy();
    expect((check as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when the repo was last checked, to the second, and moves it on a new answer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let access: Record<string, unknown> = {
      state: "ok",
      checkedAt: "2026-11-01T00:00:00.000Z",
      files: { gates: true, integrationCompose: false },
    };
    const fake = fakeServer({
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
          ],
        },
      }),
      "GET /projects/1/repos/backend/access": () => ({ json: access }),
      "POST /projects/1/repos/backend/access-check": () => ({
        json: { ...access, checking: true },
      }),
    });
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, fake);
    fireEvent.click(await screen.findByText("接入新项目"));
    const check = await screen.findByRole("button", { name: "现在检查" });
    const row = check.closest("li") as HTMLElement;
    await waitFor(() =>
      expect(
        within(row).getByText("上次检查 2026-11-01 08:00:00"),
      ).toBeTruthy(),
    );
    fireEvent.click(check);
    await waitFor(() => expect(within(row).getByText("检查中")).toBeTruthy());
    access = {
      state: "ok",
      checkedAt: "2026-11-01T00:01:05.000Z",
      files: { gates: true, integrationCompose: false },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS);
    });
    await waitFor(() =>
      expect(
        within(row).getByText("上次检查 2026-11-01 08:01:05"),
      ).toBeTruthy(),
    );
  });

  it("does not claim a check time for a repo never checked", async () => {
    const fake = fakeServer({
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
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/shop-backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
          ],
        },
      }),
      "GET /projects/1/repos/backend/access": () => ({
        json: { state: "unchecked" },
      }),
    });
    renderWithApp(<Onboarding address="http://127.0.0.1:3000" />, fake);
    fireEvent.click(await screen.findByText("接入新项目"));
    const check = await screen.findByRole("button", { name: "现在检查" });
    const row = check.closest("li") as HTMLElement;
    await waitFor(() => expect(within(row).getByText("尚未检查")).toBeTruthy());
    expect(row.textContent).not.toContain("上次检查");
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
