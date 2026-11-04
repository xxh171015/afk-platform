// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Onboarding } from "./Onboarding.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const server = (projects: unknown[]) =>
  fakeServer({
    "GET /projects": () => ({ json: { projects } }),
    "GET /version": () => ({
      json: {
        platformVersion: "0.2.0",
        skillsSha: "x",
        platformCommit: COMMIT,
      },
    }),
  });

describe("getting a project onto the platform from the control tower", () => {
  it("is in plain sight while there is no project: the install command pinned to the platform's commit, to copy, then /afk-setup", async () => {
    renderWithApp(<Onboarding address="https://afk.example.com" />, server([]));

    const block = await screen.findByRole("region", { name: "接入第一个项目" });
    const command = `npx skills@latest add xxh171015/afk-platform#${COMMIT}`;
    expect(within(block).getByText(command)).toBeTruthy();
    expect(
      within(block).getByRole("button", { name: `复制命令 ${command}` }),
    ).toBeTruthy();
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
    expect(entry.closest("details")?.open).toBe(false);
    expect(screen.queryByRole("region", { name: "接入第一个项目" })).toBeNull();
  });
});
