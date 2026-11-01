// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const run = (over: Record<string, unknown> = {}) => ({
  id: 4,
  displayId: "R-4",
  specId: 1,
  specDisplayId: "S-1",
  ticketId: 9,
  ticketDisplayId: "T-9",
  stage: "implement",
  attempt: 2,
  result: "done",
  durationMs: 146_000,
  agent: "cursor",
  model: "auto",
  skillsSha: null,
  axis: null,
  cursorCliVersion: null,
  contractShas: null,
  refShas: null,
  startedAt: "2026-10-28T10:00:00.000Z",
  finishedAt: "2026-10-28T10:02:26.000Z",
  ...over,
});

const finishedLog = (text: string) => ({
  json: {
    attempt: 1,
    offset: 0,
    nextOffset: text.length,
    size: text.length,
    text,
    finished: true,
  },
});

describe("the run page", () => {
  it("shows stage, attempt, result and duration before the log", async () => {
    const log = [
      "implement: running the agent on agent/T-9",
      JSON.stringify({
        tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
      }),
    ].join("\n");
    renderWithApp(
      <RunDetail runId={4} logPollMs={20} />,
      fakeServer({
        "GET /runs/4": () => ({ json: run() }),
        "GET /runs/4/logs": () => finishedLog(log),
      }),
    );
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "R-4",
    });
    expect(heading).toBeTruthy();
    expect(screen.getByText("阶段")).toBeTruthy();
    expect(screen.getByText("implement")).toBeTruthy();
    expect(screen.getByText("次数")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("结果")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("耗时")).toBeTruthy();
    expect(screen.getByText("146 s")).toBeTruthy();
    expect(screen.getByRole("link", { name: /T-9/ }).getAttribute("href")).toBe(
      "/tickets/9",
    );
    await waitFor(() =>
      expect(screen.getByTestId("run-log").textContent).toContain("src/a.ts"),
    );
    expect(screen.getByText("读取")).toBeTruthy();
    expect(screen.getByText("运行命令")).toBeTruthy();
  });

  it("links a finishing run with no ticket back to the spec", async () => {
    renderWithApp(
      <RunDetail runId={4} />,
      fakeServer({
        "GET /runs/4": () => ({
          json: run({
            ticketId: null,
            ticketDisplayId: null,
            stage: "final-review",
            result: "passed",
          }),
        }),
        "GET /runs/4/logs": () => finishedLog(""),
      }),
    );
    expect(
      (await screen.findByRole("link", { name: /S-1/ })).getAttribute("href"),
    ).toBe("/specs/1");
  });

  it("keeps showing the run when a later GET fails", async () => {
    let failing = false;
    const server = fakeServer({
      "GET /runs/4": () =>
        failing
          ? { status: 500, json: { error: "database is down" } }
          : { json: run() },
      "GET /runs/4/logs": () => finishedLog(""),
    });
    const { queryClient } = renderWithApp(<RunDetail runId={4} />, server);
    await screen.findByRole("heading", { name: "R-4" });
    failing = true;
    await queryClient.refetchQueries({ queryKey: ["run", 4] });
    await waitFor(() =>
      expect(queryClient.getQueryState(["run", 4])?.status).toBe("error"),
    );
    expect(screen.getByRole("heading", { name: "R-4" })).toBeTruthy();
    expect(screen.queryByText(/Could not load the run/)).toBeNull();
  });
});
