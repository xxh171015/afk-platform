// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  durationApiMs: null,
  tokenUsage: null,
  contractShas: null,
  refShas: null,
  startedAt: "2026-10-28T10:00:00.000Z",
  finishedAt: "2026-10-28T10:02:26.000Z",
  prompt: null,
  output: null,
  commits: [],
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
      name: /R-4/,
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
    expect(screen.getByTestId("run-usage").textContent).toBe("—");
    expect(screen.getByRole("link", { name: /T-9/ }).getAttribute("href")).toBe(
      "/tickets/9",
    );
    await waitFor(() =>
      expect(screen.getByTestId("run-log").textContent).toContain("src/a.ts"),
    );
    expect(screen.getByText("读取")).toBeTruthy();
    expect(screen.getByText("运行命令")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "提示词" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "结构化输出" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "提交" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "提交" }));
    expect(await screen.findByText("没有提交记录")).toBeTruthy();
  });

  it("shows this run's token usage, API duration and CLI version", async () => {
    renderWithApp(
      <RunDetail runId={4} logPollMs={20} />,
      fakeServer({
        "GET /runs/4": () => ({
          json: run({
            cursorCliVersion: "2026.10.22-27dcf5f",
            durationApiMs: 120_000,
            tokenUsage: {
              inputTokens: 143000,
              outputTokens: 33000,
              cacheReadTokens: 5110000,
              cacheWriteTokens: 12000,
            },
          }),
        }),
        "GET /runs/4/logs": () => finishedLog(""),
      }),
    );
    await screen.findByRole("heading", { level: 1, name: /R-4/ });
    expect(screen.getByText("API 耗时")).toBeTruthy();
    expect(screen.getByText("120 s")).toBeTruthy();
    expect(screen.getByText("2026.10.22-27dcf5f")).toBeTruthy();
    expect(screen.getByTestId("run-usage").textContent).toContain(
      "输入 143,000",
    );
    expect(screen.getByTestId("run-usage").textContent).toContain(
      "输出 33,000",
    );
    expect(screen.getByTestId("run-usage").textContent).toContain(
      "缓存读 5,110,000",
    );
    expect(screen.getByTestId("run-usage").textContent).toContain(
      "缓存写 12,000",
    );
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
    const specLinks = await screen.findAllByRole("link", { name: /S-1/ });
    expect(specLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/specs/1",
    ]);
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
    await screen.findByRole("heading", { name: /R-4/ });
    failing = true;
    await queryClient.refetchQueries({ queryKey: ["run", 4] });
    await waitFor(() =>
      expect(queryClient.getQueryState(["run", 4])?.status).toBe("error"),
    );
    expect(screen.getByRole("heading", { name: /R-4/ })).toBeTruthy();
    expect(screen.queryByText(/无法加载这次运行/)).toBeNull();
  });

  it("keeps the three tabs and shows empty states when prompt, output and commits are missing", async () => {
    renderWithApp(
      <RunDetail runId={4} />,
      fakeServer({
        "GET /runs/4": () => ({ json: run() }),
        "GET /runs/4/logs": () => finishedLog(""),
      }),
    );
    expect(await screen.findByRole("tab", { name: "提示词" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "结构化输出" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "提交" })).toBeTruthy();
    expect(screen.getByText("没有提示词")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "结构化输出" }));
    expect(await screen.findByText("没有结构化输出")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "提交" }));
    expect(await screen.findByText("没有提交记录")).toBeTruthy();
  });

  it("shows the prompt, a JSON tree of the structured output, and only SHAs for commits", async () => {
    renderWithApp(
      <RunDetail runId={4} />,
      fakeServer({
        "GET /runs/4": () => ({
          json: run({
            prompt: "## 没有人回答你\n\n- 自己决定\n\noverlay + implement",
            output: { outcome: "done", files: ["src/a.ts"] },
            commits: ["abcdef1234567890"],
          }),
        }),
        "GET /runs/4/logs": () => finishedLog(""),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "没有人回答你" }),
    ).toBeTruthy();
    expect(screen.queryByText("## 没有人回答你")).toBeNull();
    expect(screen.getByText("overlay + implement")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "结构化输出" }));
    expect(await screen.findByText(/outcome/)).toBeTruthy();
    expect(screen.getByText(/"done"/)).toBeTruthy();
    expect(screen.queryByText("nextAction")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "提交" }));
    expect(await screen.findByRole("button", { name: /abcdef1/ })).toBeTruthy();
    expect(screen.queryByText(/implement the export/)).toBeNull();
  });
});
