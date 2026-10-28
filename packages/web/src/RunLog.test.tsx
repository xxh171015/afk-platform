// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunLog } from "./RunLog.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

// A run whose log grows: the server answers for whatever has been written so far.
function growingLog(initial = "") {
  const state = {
    text: initial,
    finished: false,
    attempt: 1,
    asked: [] as { offset: number; attempt: string | null }[],
  };
  const server = fakeServer({
    "GET /runs/5/logs": ({ url }) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      state.asked.push({ offset, attempt: url.searchParams.get("attempt") });
      const text = state.text.slice(offset);
      return {
        json: {
          attempt: state.attempt,
          offset,
          nextOffset: offset + text.length,
          size: state.text.length,
          text,
          finished: state.finished,
        },
      };
    },
  });
  return { state, server };
}
const log = () => screen.getByTestId("run-log").textContent;

describe("the log of a run", () => {
  it("shows what has been written", async () => {
    const { server } = growingLog("compiling…\nall tests passed\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toBe("compiling…\nall tests passed\n"));
  });

  it("picks up what is written later, asking from where it stopped (within a few polls)", async () => {
    const { state, server } = growingLog("first line\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toBe("first line\n"));

    state.text += "second line\n";
    await waitFor(() => expect(log()).toBe("first line\nsecond line\n"));
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
    const { state, server } = growingLog("");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await screen.findByText("Nothing logged yet.");
    const before = state.asked.length;
    await waitFor(() => expect(state.asked.length).toBeGreaterThan(before + 1));
    state.text = "now there is something\n";
    await waitFor(() => expect(log()).toBe("now there is something\n"));
  });

  it("stops polling once the run is finished and everything has been read", async () => {
    const { state, server } = growingLog("done\n");
    state.finished = true;
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toBe("done\n"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = state.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.asked.length).toBe(settled);
  });

  it("starts the text over when the job moved to a new attempt", async () => {
    const { state, server } = growingLog("old attempt\n");
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    await waitFor(() => expect(log()).toBe("old attempt\n"));

    state.attempt = 2;
    state.text = "new attempt\n";
    await waitFor(() => expect(log()).toBe("new attempt\n"));
  });

  it("says it is loading, and says what went wrong", async () => {
    const server = fakeServer({
      "GET /runs/5/logs": () => ({
        status: 404,
        json: { error: "no such run" },
      }),
    });
    renderWithApp(<RunLog runId={5} pollMs={20} />, server);
    expect(screen.getByText("Loading the log…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the log: no such run",
    );
  });
});
