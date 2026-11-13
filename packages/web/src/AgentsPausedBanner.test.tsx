// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsPausedBanner } from "./AgentsPausedBanner.tsx";
import { emptyWorkbench, fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

describe("the agents-paused banner", () => {
  it("is silent while agents take work", async () => {
    const server = fakeServer({
      "GET /workbench": () => ({ json: emptyWorkbench }),
    });
    renderWithApp(<AgentsPausedBanner />, server);
    await waitFor(() => expect(server.calls).toContain("GET /workbench"));
    expect(screen.queryByTestId("agents-paused-banner")).toBeNull();
  });

  it("says why agents stopped, and resumes them", async () => {
    let paused = true;
    const server = fakeServer({
      "GET /workbench": () => ({
        json: {
          ...emptyWorkbench,
          status: {
            ...emptyWorkbench.status,
            agentsPaused: paused
              ? {
                  since: "2026-11-10T17:04:45Z",
                  reason: "ActionRequiredError: You're out of usage.",
                  nextProbeAt: null,
                }
              : null,
          },
        },
      }),
      "POST /agents/resume": () => {
        paused = false;
        return { json: { resumed: true } };
      },
    });
    renderWithApp(<AgentsPausedBanner />, server);
    const banner = await screen.findByTestId("agents-paused-banner");
    expect(banner.textContent).toContain("Agent 已暂停");
    expect(banner.textContent).toContain("You're out of usage.");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(screen.queryByTestId("agents-paused-banner")).toBeNull(),
    );
    expect(server.calls).toContain("POST /agents/resume");
  });

  it("says when the platform tries the provider again on its own", async () => {
    const server = fakeServer({
      "GET /workbench": () => ({
        json: {
          ...emptyWorkbench,
          status: {
            ...emptyWorkbench.status,
            agentsPaused: {
              since: "2026-11-10T17:04:45Z",
              reason: "Cursor 额度用完，充值或换模型后再试",
              nextProbeAt: "2026-11-10T17:19:45Z",
            },
          },
        },
      }),
    });
    renderWithApp(<AgentsPausedBanner />, server);
    const banner = await screen.findByTestId("agents-paused-banner");
    expect(banner.textContent).toContain("2026-11-11 01:19 自动再试一次");
  });

  it("says a refused key waits for a person", async () => {
    const server = fakeServer({
      "GET /workbench": () => ({
        json: {
          ...emptyWorkbench,
          status: {
            ...emptyWorkbench.status,
            agentsPaused: {
              since: "2026-11-10T17:04:45Z",
              reason: "Cursor 密钥失效或没有权限",
              nextProbeAt: null,
            },
          },
        },
      }),
    });
    renderWithApp(<AgentsPausedBanner />, server);
    const banner = await screen.findByTestId("agents-paused-banner");
    expect(banner.textContent).not.toContain("自动再试");
  });
});
