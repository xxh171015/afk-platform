// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedQueue } from "./BlockedQueue.tsx";
import { fakeServer, type Handler, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const brief = (over: Record<string, unknown> = {}) => ({
  run: { id: 7, displayId: "R-7" },
  stage: "implement",
  result: "agent-gave-up",
  output: { status: "cannot-proceed", detail: "needs a decision" },
  logPath: "/runs/7/logs",
  ...over,
});

const ticket = (
  n: number,
  reason: string,
  over: Record<string, unknown> = {},
) => ({
  id: n,
  displayId: `T-${n}`,
  specId: 1,
  specDisplayId: "S-1",
  title: `Ticket ${n}`,
  type: "implementation",
  state: "blocked",
  blockedReason: reason,
  repo: "backend",
  brief: brief(),
  ...over,
});

interface Queue {
  tickets: unknown[];
  finalizations: unknown[];
  specs: unknown[];
}
const queue = (over: Partial<Queue> = {}): Queue => ({
  tickets: [],
  finalizations: [],
  specs: [],
  ...over,
});

// A queue that the actions change, like the real one: acting on a ticket takes it off the list.
function server(initial: Queue, actions: Record<string, Handler> = {}) {
  let current = initial;
  const bodies: Record<string, unknown> = {};
  const act = (key: string, reply: Handler, remove?: (q: Queue) => Queue) =>
    [
      key,
      async (request: Parameters<Handler>[0]) => {
        bodies[key] = request.body;
        const result = await reply(request);
        if ((result.status ?? 200) < 300 && remove) current = remove(current);
        return result;
      },
    ] as const;
  const withoutTicket = (id: number) => (q: Queue) => ({
    ...q,
    tickets: (q.tickets as { id: number }[]).filter((t) => t.id !== id),
  });
  const fake = fakeServer({
    "GET /blocked": () => ({ json: current }),
    ...Object.fromEntries([
      act(
        "POST /tickets/1/retry",
        () => ({ json: { state: "queued" } }),
        withoutTicket(1),
      ),
      act(
        "POST /tickets/2/approve-protected",
        () => ({ json: { approved: [".github/ci.yml"] } }),
        withoutTicket(2),
      ),
      act(
        "POST /tickets/3/cancel",
        () => ({ json: { cancelled: ["T-3"], blocked: [], skipped: [] } }),
        withoutTicket(3),
      ),
    ]),
    ...actions,
  });
  return { fake, bodies };
}

const card = (id: string) => within(screen.getByTestId(`blocked-${id}`));

describe("the queue of what waits for a person", () => {
  it("lists blocked tickets with their reason and what went wrong", async () => {
    const { fake } = server(queue({ tickets: [ticket(1, "agent-gave-up")] }));
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-1");
    expect(card("T-1").getByText("Ticket 1")).toBeTruthy();
    expect(card("T-1").getByText("agent-gave-up")).toBeTruthy();
    const note = card("T-1").getByRole("note");
    expect(note.textContent).toContain("implement ended agent-gave-up in R-7");
    expect(note.textContent).toContain("needs a decision");
    expect(
      card("T-1").getByRole("link", { name: "T-1" }).getAttribute("href"),
    ).toBe("#/tickets/1");
    expect(
      card("T-1").getByRole("link", { name: "S-1" }).getAttribute("href"),
    ).toBe("#/specs/1");
  });

  it("shows the paths the gate found for protected-path-changed and the gate's log for a failed gate", async () => {
    const { fake } = server(
      queue({
        tickets: [
          ticket(2, "protected-path-changed", {
            brief: brief({
              stage: "gate",
              result: "protected-path-changed",
              output: { unapproved: [".github/ci.yml"] },
            }),
          }),
          ticket(4, "gate-failed", {
            brief: brief({
              stage: "gate",
              result: "failed",
              output: { failureLog: "# test failed\nboom" },
            }),
          }),
        ],
      }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-2");
    expect(card("T-2").getByRole("note").textContent).toContain(
      "Protected paths: .github/ci.yml",
    );
    expect(card("T-4").getByRole("note").textContent).toContain(
      "# test failed",
    );
  });

  it("offers the approve button only for a ticket blocked by protected-path-changed", async () => {
    const { fake } = server(
      queue({
        tickets: [
          ticket(1, "agent-gave-up"),
          ticket(2, "protected-path-changed"),
        ],
      }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-2");
    expect(
      card("T-1").queryByRole("button", { name: "Approve protected paths" }),
    ).toBeNull();
    expect(
      card("T-2").getByRole("button", { name: "Approve protected paths" }),
    ).toBeTruthy();
  });

  it("does not offer a retry to a ticket that waits for one that was cancelled", async () => {
    const { fake } = server(
      queue({ tickets: [ticket(5, "upstream-cancelled", { brief: null })] }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-5");
    expect(card("T-5").queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(card("T-5").getByRole("button", { name: "Cancel…" })).toBeTruthy();
  });
});

describe("retrying", () => {
  it.each([
    ["Retry, keep the work", "continue"],
    ["Retry from scratch", "restart"],
  ])(
    "%s asks the API for mode %s, and the ticket leaves the list",
    async (label, mode) => {
      const { fake, bodies } = server(
        queue({
          tickets: [ticket(1, "gate-failed"), ticket(3, "agent-gave-up")],
        }),
      );
      renderWithApp(<BlockedQueue />, fake);
      await screen.findByTestId("blocked-T-1");
      fireEvent.click(card("T-1").getByRole("button", { name: label }));
      await waitFor(() =>
        expect(screen.queryByTestId("blocked-T-1")).toBeNull(),
      );
      expect(bodies["POST /tickets/1/retry"]).toEqual({ mode });
      expect(screen.getByTestId("blocked-T-3")).toBeTruthy(); // the others stay
    },
  );

  it("shows what the API said when it refuses, and keeps the ticket", async () => {
    const { fake } = server(queue({ tickets: [ticket(1, "gate-failed")] }), {
      "POST /tickets/1/retry": () => ({
        status: 409,
        json: { error: "retry is not allowed in running" },
      }),
    });
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-1");
    fireEvent.click(
      card("T-1").getByRole("button", { name: "Retry, keep the work" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "retry is not allowed in running",
    );
    expect(screen.getByTestId("blocked-T-1")).toBeTruthy();
  });
});

describe("approving protected paths", () => {
  it("asks the API and takes the ticket off the list", async () => {
    const { fake } = server(
      queue({ tickets: [ticket(2, "protected-path-changed")] }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-2");
    fireEvent.click(
      card("T-2").getByRole("button", { name: "Approve protected paths" }),
    );
    await waitFor(() => expect(screen.queryByTestId("blocked-T-2")).toBeNull());
    expect(fake.calls).toContain("POST /tickets/2/approve-protected");
    expect(await screen.findByText("Nothing is waiting for you.")).toBeTruthy();
  });
});

describe("cancelling", () => {
  it("needs a second click, and does nothing if you keep the ticket", async () => {
    const { fake } = server(queue({ tickets: [ticket(3, "agent-gave-up")] }));
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-3");
    fireEvent.click(card("T-3").getByRole("button", { name: "Cancel…" }));
    expect(
      card("T-3").getByRole("button", { name: "Cancel T-3 for good" }),
    ).toBeTruthy();
    fireEvent.click(card("T-3").getByRole("button", { name: "Keep it" }));
    expect(card("T-3").getByRole("button", { name: "Cancel…" })).toBeTruthy();
    expect(fake.calls).not.toContain("POST /tickets/3/cancel");
  });

  it("cancels just the ticket by default", async () => {
    const { fake, bodies } = server(
      queue({ tickets: [ticket(3, "agent-gave-up")] }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-3");
    fireEvent.click(card("T-3").getByRole("button", { name: "Cancel…" }));
    fireEvent.click(
      card("T-3").getByRole("button", { name: "Cancel T-3 for good" }),
    );
    await waitFor(() => expect(screen.queryByTestId("blocked-T-3")).toBeNull());
    expect(bodies["POST /tickets/3/cancel"]).toEqual({ cascade: false });
  });

  it("can cancel everything downstream with it", async () => {
    const { fake, bodies } = server(
      queue({ tickets: [ticket(3, "agent-gave-up")] }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-3");
    fireEvent.click(card("T-3").getByRole("button", { name: "Cancel…" }));
    fireEvent.click(card("T-3").getByRole("checkbox"));
    fireEvent.click(
      card("T-3").getByRole("button", { name: "Cancel T-3 for good" }),
    );
    await waitFor(() => expect(screen.queryByTestId("blocked-T-3")).toBeNull());
    expect(bodies["POST /tickets/3/cancel"]).toEqual({ cascade: true });
  });
});

describe("paused specs and stopped overall reviews", () => {
  const paused = {
    id: 1,
    displayId: "S-1",
    title: "Order export",
    reason: "the agent time limit of the spec was reached",
  };
  const stopped = {
    specId: 1,
    specDisplayId: "S-1",
    repo: "backend",
    step: "final-merge",
    state: "blocked",
    blockedReason: "post-merge-gate-failed",
    brief: brief({
      stage: "final-merge",
      result: "gate-failed",
      output: { failureLog: "# test failed" },
    }),
  };

  it("shows why a spec is paused and resumes it with the agent hours you give", async () => {
    let current = queue({ specs: [paused] });
    const fake = fakeServer({
      "GET /blocked": () => ({ json: current }),
      "POST /specs/1/resume": ({ body }) => {
        resumed = body;
        current = queue();
        return { json: { state: "running" } };
      },
    });
    let resumed: unknown;
    renderWithApp(<BlockedQueue />, fake);
    const spec = within(await screen.findByTestId("paused-S-1"));
    expect(
      spec.getByText(/the agent time limit of the spec was reached/),
    ).toBeTruthy();
    fireEvent.change(spec.getByLabelText("extra agent hours for S-1"), {
      target: { value: "2.5" },
    });
    fireEvent.click(spec.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByTestId("paused-S-1")).toBeNull());
    expect(resumed).toEqual({ extraSeconds: 9000 });
  });

  it("will not resume with no hours", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({ json: queue({ specs: [paused] }) }),
      }),
    );
    const spec = within(await screen.findByTestId("paused-S-1"));
    fireEvent.change(spec.getByLabelText("extra agent hours for S-1"), {
      target: { value: "0" },
    });
    expect(
      (spec.getByRole("button", { name: "Resume" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a stopped overall review and runs its step again", async () => {
    let current = queue({ finalizations: [stopped] });
    const fake = fakeServer({
      "GET /blocked": () => ({ json: current }),
      "POST /specs/1/final/retry": () => {
        current = queue();
        return { json: { retried: ["final-merge"] } };
      },
    });
    renderWithApp(<BlockedQueue />, fake);
    const item = within(await screen.findByTestId("final-S-1-backend"));
    expect(item.getByText("post-merge-gate-failed")).toBeTruthy();
    expect(item.getByRole("note").textContent).toContain("# test failed");
    fireEvent.click(
      item.getByRole("button", { name: "Run final-merge again" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("final-S-1-backend")).toBeNull(),
    );
    expect(fake.calls).toContain("POST /specs/1/final/retry");
  });

  it("shows a resume refusal", async () => {
    const fake = fakeServer({
      "GET /blocked": () => ({ json: queue({ specs: [paused] }) }),
      "POST /specs/1/resume": () => ({
        status: 409,
        json: { error: "resume is not allowed in running" },
      }),
    });
    renderWithApp(<BlockedQueue />, fake);
    fireEvent.click(
      within(await screen.findByTestId("paused-S-1")).getByRole("button", {
        name: "Resume",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "resume is not allowed in running",
    );
  });
});

describe("when there is nothing to show", () => {
  it("says nothing is waiting", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({ "GET /blocked": () => ({ json: queue() }) }),
    );
    expect(await screen.findByText("Nothing is waiting for you.")).toBeTruthy();
  });

  it("says it is loading, and says what went wrong", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({
          status: 500,
          json: { error: "database is down" },
        }),
      }),
    );
    expect(screen.getByText("Loading what is waiting for you…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the queue: database is down",
    );
  });
});
