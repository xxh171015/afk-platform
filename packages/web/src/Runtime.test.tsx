// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./Runtime.tsx";
import { emptyRuntime, fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

describe("the runtime page", () => {
  it("shows the instance id and a running job linked to its run", async () => {
    renderWithApp(
      <Runtime />,
      fakeServer({
        "GET /runtime": () => ({
          json: {
            ...emptyRuntime,
            summary: { running: 1, queued: 0 },
            jobs: {
              running: [
                {
                  id: 7,
                  type: "agent-run",
                  state: "running",
                  attempt: 1,
                  leaseOwner: "w1",
                  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
                  lockKey: null,
                  notBefore: null,
                  label: "implement · T-1 · backend",
                  stage: "implement",
                  specId: 1,
                  specDisplayId: "S-1",
                  ticketId: 1,
                  ticketDisplayId: "T-1",
                  runId: 3,
                },
              ],
              queued: [],
            },
            workers: [
              {
                id: "w1",
                reportedAt: "2026-01-01T00:00:00.000Z",
                freeBytes: 20_000_000_000,
                cleaned: { sandboxLogs: 0, salvage: 0, snapshots: 0 },
                heldJobId: 7,
              },
            ],
          },
        }),
      }),
    );
    const runLink = await screen.findByRole("link", { name: "R-3" });
    expect(document.body.textContent).toContain("abcdef");
    expect(runLink.getAttribute("href")).toBe("/runs/3");
    expect(screen.getByText("持租")).toBeTruthy();
    expect(screen.getAllByText("#7").length).toBeGreaterThan(0);
  });
});