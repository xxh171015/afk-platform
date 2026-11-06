// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunLog } from "./RunLog.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

// A run whose log grows. Like the real API it keeps one log per attempt, answers for the newest attempt unless
// one is asked for, and reads from the offset within that attempt's log.
function growingLog(initial = "") {
  const state = {
    logs: { 1: initial } as Record<number, string>,
    attempt: 1,
    finished: false,
    asked: [] as { offset: number; attempt: string | null }[],
  };
  const server = fakeServer({
    "GET /runs/5/logs": ({ url }) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const asked = url.searchParams.get("attempt");
      state.asked.push({ offset, attempt: asked });
      const attempt = asked ? Number(asked) : state.attempt;
      const whole = state.logs[attempt] ?? "";
      const text = whole.slice(offset);
      return {
        json: {
          attempt,
          offset,
          nextOffset: offset + text.length,
          size: whole.length,
          text,
          finished: state.finished,
        },
      };
    },
  });
  return {
    state,
    server,
    write: (more: string) => {
      state.logs[state.attempt] = (state.logs[state.attempt] ?? "") + more;
    },
  };
}
const log = () => screen.getByTestId("run-log").textContent;

describe("the log of a run", () => {
  it("shows what has been written", async () => {
    const { server } = growingLog("compiling…\nall tests passed\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => {
      expect(log()).toContain("compiling…");
      expect(log()).toContain("all tests passed");
    });
  });

  it("picks up what is written later, asking from where it stopped (within a few polls)", async () => {
    const { state, server, write } = growingLog("first line\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toContain("first line"));

    write("second line\n");
    await waitFor(() => {
      expect(log()).toContain("first line");
      expect(log()).toContain("second line");
    });
    // it did not read the first line again
    expect(state.asked.some((q) => q.offset === "first line\n".length)).toBe(
      true,
    );
    expect(
      state.asked.filter((q) => q.offset === 0).length,
    ).toBeGreaterThanOrEqual(1);
    expect(log()?.match(/first line/g)).toHaveLength(1);
  });

  it("keeps polling while the run is going, even before anything is written", async () => {
    const { state, server, write } = growingLog("");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await screen.findByText("还没有日志。");
    const before = state.asked.length;
    await waitFor(() => expect(state.asked.length).toBeGreaterThan(before + 1));
    write("now there is something\n");
    await waitFor(() => expect(log()).toContain("now there is something"));
  });

  it("stops polling once the run is finished and everything has been read", async () => {
    const { state, server } = growingLog("done\n");
    state.finished = true;
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toContain("done"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = state.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.asked.length).toBe(settled);
  });

  it("starts the text over when the job moved to a new attempt", async () => {
    const { state, server, write } = growingLog("old attempt\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toContain("old attempt"));

    state.attempt = 2; // the job was handed to another worker; its log is a new file
    write("new attempt\n");
    await waitFor(() => {
      expect(log()).toContain("new attempt");
      expect(log()).not.toContain("old attempt");
    });
    // and the page never pinned the old attempt, which would have kept it on the first log for ever
    expect(state.asked.every((q) => q.attempt === null)).toBe(true);
  });

  it("says it is loading, and says what went wrong", async () => {
    const server = fakeServer({
      "GET /runs/5/logs": () => ({
        status: 404,
        json: { error: "no such run" },
      }),
    });
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    expect(screen.getByText("加载日志…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "无法加载日志: no such run",
    );
  });

  it("keeps the log it already has when a later read fails", async () => {
    let failing = false;
    const whole = "still here\n";
    const server = fakeServer({
      "GET /runs/5/logs": ({ url }) => {
        if (failing) {
          return { status: 500, json: { error: "database is down" } };
        }
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const text = whole.slice(offset);
        return {
          json: {
            attempt: 1,
            offset,
            nextOffset: offset + text.length,
            size: whole.length,
            text,
            finished: false,
          },
        };
      },
    });
    const { queryClient } = renderWithApp(
      <RunLog runId={5} pollMs={20} />,
      server,
    );
    await waitFor(() => expect(log()).toContain("still here"));
    failing = true;
    await queryClient.refetchQueries({ queryKey: ["log", 5] });
    await waitFor(() =>
      expect(
        [...queryClient.getQueryCache().findAll({ queryKey: ["log", 5] })].some(
          (query) => query.state.status === "error",
        ),
      ).toBe(true),
    );
    expect(log()).toContain("still here");
    expect(screen.queryByText(/无法加载日志/)).toBeNull();
  });

  it("splits JSON events by action and keeps the original JSON collapsed", async () => {
    const line = JSON.stringify({
      tool_call: { editToolCall: { args: { path: "src/a.ts" } } },
    });
    const { server } = growingLog(`${line}\n`);
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(screen.getByText("修改")).toBeTruthy());
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/a.ts").closest("details")?.open).toBe(false);
  });

  it("stops following after the reader scrolls up, and a new chunk does not yank the viewport", async () => {
    const { server, write } = growingLog("first line\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toContain("first line"));
    const el = screen.getByTestId("run-log");
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => 4000,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    el.scrollTop = 80;
    fireEvent.scroll(el);
    expect(screen.queryByText("跳到最新")).toBeTruthy();
    const stayed = el.scrollTop;
    write("later line\n");
    await waitFor(() => expect(log()).toContain("later line"));
    expect(el.scrollTop).toBe(stayed);
  });

  it("shows thinking as prose and keeps a long command output collapsed with a leftover count", async () => {
    const output = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const text = [
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "I will inspect git status.",
        session_id: "s1",
        timestamp_ms: 1000,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "completed",
        session_id: "s1",
        timestamp_ms: 5000,
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        session_id: "s1",
        tool_call: {
          shellToolCall: {
            description: "Show git status",
            args: { command: "git status" },
            result: { success: { stdout: output } },
          },
        },
      }),
      "",
    ].join("\n");
    const { server } = growingLog(text);
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() =>
      expect(screen.getByText("I will inspect git status.")).toBeTruthy(),
    );
    expect(screen.getByText("思考 4s")).toBeTruthy();
    expect(
      screen.getByText("I will inspect git status.").closest("pre"),
    ).toBeTruthy();
    expect(screen.getByText("Show git status").closest("details")?.open).toBe(
      false,
    );
    expect(screen.getByText("还有 5 行")).toBeTruthy();
  });
});
