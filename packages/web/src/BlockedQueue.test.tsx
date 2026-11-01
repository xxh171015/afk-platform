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
  pullRequests: unknown[];
  cleanups: unknown[];
  readyFailures: unknown[];
  specs: unknown[];
}
const queue = (over: Partial<Queue> = {}): Queue => ({
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
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
    expect(card("T-1").getByTitle("agent-gave-up").textContent).toBe(
      "模型放弃",
    );
    const note = card("T-1").getByRole("note");
    expect(note.textContent).toContain("implement ended agent-gave-up in R-7");
    expect(note.textContent).toContain("needs a decision");
    expect(
      card("T-1").getByRole("link", { name: "T-1" }).getAttribute("href"),
    ).toBe("/tickets/1");
    expect(
      card("T-1").getByRole("link", { name: "S-1" }).getAttribute("href"),
    ).toBe("/specs/1");
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

describe("while an action is under way", () => {
  it("keeps the buttons disabled until the refreshed list arrives, so a second click cannot hit a ticket that has moved on", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    let moved = false;
    const fake = fakeServer({
      "GET /blocked": async () => {
        reads += 1;
        if (moved) await gate; // the refresh after the action is slow
        return {
          json: moved
            ? queue()
            : queue({ tickets: [ticket(1, "gate-failed")] }),
        };
      },
      "POST /tickets/1/retry": () => {
        moved = true;
        return { json: { state: "queued" } };
      },
    });
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-1");
    fireEvent.click(
      card("T-1").getByRole("button", { name: "Retry, keep the work" }),
    );
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2)); // the refresh has started
    for (const name of [
      "Retry, keep the work",
      "Retry from scratch",
      "Cancel…",
    ]) {
      expect(
        (card("T-1").getByRole("button", { name }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
    release();
    await waitFor(() => expect(screen.queryByTestId("blocked-T-1")).toBeNull());
  });

  it("shows the message of the latest failure, not an older one", async () => {
    const { fake } = server(queue({ tickets: [ticket(1, "gate-failed")] }), {
      "POST /tickets/1/retry": () => ({
        status: 409,
        json: { error: "the retry was refused" },
      }),
      "POST /tickets/1/cancel": () => ({
        status: 409,
        json: { error: "the cancel was refused" },
      }),
    });
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-1");
    fireEvent.click(
      card("T-1").getByRole("button", { name: "Retry, keep the work" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "the retry was refused",
    );
    fireEvent.click(card("T-1").getByRole("button", { name: "Cancel…" }));
    fireEvent.click(
      card("T-1").getByRole("button", { name: "Cancel T-1 for good" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "the cancel was refused",
      ),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("clears the cascade box when you back out of a cancel", async () => {
    const { fake } = server(queue({ tickets: [ticket(3, "agent-gave-up")] }));
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-3");
    fireEvent.click(card("T-3").getByRole("button", { name: "Cancel…" }));
    fireEvent.click(card("T-3").getByRole("checkbox"));
    fireEvent.click(card("T-3").getByRole("button", { name: "Keep it" }));
    fireEvent.click(card("T-3").getByRole("button", { name: "Cancel…" }));
    expect(
      (card("T-3").getByRole("checkbox") as HTMLInputElement).checked,
    ).toBe(false);
  });
});

describe("when a refresh fails", () => {
  it("keeps showing the queue it has, instead of wiping the page", async () => {
    let failing = false;
    const fake = fakeServer({
      "GET /blocked": () =>
        failing
          ? { status: 500, json: { error: "database is down" } }
          : { json: queue({ tickets: [ticket(1, "gate-failed")] }) },
    });
    const { queryClient } = renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-1");
    fireEvent.click(card("T-1").getByRole("button", { name: "Cancel…" }));

    failing = true;
    const reads = fake.calls.length;
    await queryClient.refetchQueries({ queryKey: ["blocked"] }); // the next poll
    expect(fake.calls.length).toBeGreaterThan(reads);
    await waitFor(() =>
      expect(queryClient.getQueryState(["blocked"])?.status).toBe("error"),
    );
    expect(screen.getByTestId("blocked-T-1")).toBeTruthy();
    expect(
      card("T-1").getByRole("button", { name: "Cancel T-1 for good" }),
    ).toBeTruthy(); // the open confirm is still there
    expect(screen.queryByText(/Could not load the queue/)).toBeNull();
  });
});

describe("a ticket that waits for a cancelled one", () => {
  it("says why there is no retry", async () => {
    const { fake } = server(
      queue({ tickets: [ticket(5, "upstream-cancelled", { brief: null })] }),
    );
    renderWithApp(<BlockedQueue />, fake);
    await screen.findByTestId("blocked-T-5");
    expect(
      card("T-5").getByText(
        /was cancelled, so trying again would only wait for ever/,
      ),
    ).toBeTruthy();
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

  it("lets the hours field be emptied and typed again, and only accepts what the API accepts", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({ json: queue({ specs: [paused] }) }),
      }),
    );
    const spec = within(await screen.findByTestId("paused-S-1"));
    const field = spec.getByLabelText(
      "extra agent hours for S-1",
    ) as HTMLInputElement;
    const resume = spec.getByRole("button", {
      name: "Resume",
    }) as HTMLButtonElement;
    const ok = (value: string) => {
      fireEvent.change(field, { target: { value } });
      return !resume.disabled;
    };
    expect(ok("")).toBe(false); // emptied, not snapped back to 0
    expect(field.value).toBe("");
    expect(ok("2")).toBe(true);
    expect(ok("0.0001")).toBe(false); // rounds to no seconds at all
    expect(ok("0.01")).toBe(true); // 36 seconds
    expect(ok("-1")).toBe(false);
    expect(ok("168")).toBe(true);
    expect(ok("169")).toBe(false); // more than the API takes
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
    expect(item.getByTitle("post-merge-gate-failed").textContent).toBe(
      "合并后门禁失败",
    );
    expect(item.getByRole("note").textContent).toContain("# test failed");
    fireEvent.click(
      item.getByRole("button", { name: "Run final-merge again" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("final-S-1-backend")).toBeNull(),
    );
    expect(fake.calls).toContain("POST /specs/1/final/retry");
  });

  it("shows the e2e before the pull requests, and lets a person run it again or open the pull requests anyway", async () => {
    let current = queue({
      finalizations: [
        {
          ...stopped,
          repo: "(integration)",
          step: "final-e2e",
          blockedReason: "final-e2e-failed",
        },
      ],
    });
    const fake = fakeServer({
      "GET /blocked": () => ({ json: current }),
      "POST /specs/1/final/waive": () => {
        current = queue();
        return { json: { waived: true } };
      },
    });
    renderWithApp(<BlockedQueue />, fake);
    const item = within(await screen.findByTestId("final-S-1-(integration)"));
    expect(item.getByText("final-e2e-failed")).toBeTruthy();
    expect(item.getByText(/e2e before the pull requests/)).toBeTruthy();
    expect(
      item.getByRole("button", { name: "Run final-e2e again" }),
    ).toBeTruthy();
    fireEvent.click(
      item.getByRole("button", { name: "Open the pull requests anyway" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("final-S-1-(integration)")).toBeNull(),
    );
    expect(fake.calls).toContain("POST /specs/1/final/waive");
  });

  it("offers no way past an overall review of a repo", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({ json: queue({ finalizations: [stopped] }) }),
      }),
    );
    const item = within(await screen.findByTestId("final-S-1-backend"));
    expect(
      item.queryByRole("button", { name: "Open the pull requests anyway" }),
    ).toBeNull();
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

describe("pull requests a person has to look at", () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    specId: 1,
    specDisplayId: "S-1",
    repo: "backend",
    number: 7,
    url: "https://github.com/me/shop/pull/7",
    state: "closed",
    syncError: null,
    ...over,
  });

  it("says a pull request was closed without merge, and what a person can do about it", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({ json: queue({ pullRequests: [pull()] }) }),
      }),
    );
    const item = within(await screen.findByTestId("pull-S-1-backend"));
    expect(item.getByText(/关闭未合并/)).toBeTruthy();
    expect(
      item.getByRole("link", { name: "backend #7" }).getAttribute("href"),
    ).toBe("https://github.com/me/shop/pull/7");
    expect(item.getByRole("link", { name: "S-1" }).getAttribute("href")).toBe(
      "/specs/1",
    );
    expect(
      item.getByText(/Reopen it on the host, rework the spec, or cancel it/),
    ).toBeTruthy();
  });

  it("shows both when a closed pull request also cannot be read", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({
          json: queue({
            pullRequests: [pull({ syncError: "GitHub answered 404" })],
          }),
        }),
      }),
    );
    const item = within(await screen.findByTestId("pull-S-1-backend"));
    expect(item.getByText("关闭未合并")).toBeTruthy();
    expect(
      item.getByText(/could not be read: GitHub answered 404/),
    ).toBeTruthy();
  });

  it("shows why a pull request cannot be read", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({
          json: queue({
            pullRequests: [
              pull({ state: "open", syncError: "GitHub answered 404" }),
            ],
          }),
        }),
      }),
    );
    const item = within(await screen.findByTestId("pull-S-1-backend"));
    expect(
      item.getByText(/could not be read: GitHub answered 404/),
    ).toBeTruthy();
    expect(item.queryByText(/关闭未合并/)).toBeNull();
  });
});

describe("a clean-up that did not finish", () => {
  it("is listed with its error, and says what to do", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({
          json: queue({
            cleanups: [
              {
                specId: 1,
                specDisplayId: "S-1",
                error: "GitHub answered 503",
              },
            ],
          }),
        }),
      }),
    );
    const item = within(await screen.findByTestId("cleanup-S-1"));
    expect(item.getByText(/GitHub answered 503/)).toBeTruthy();
    expect(item.getByText(/plat spec cleanup S-1/)).toBeTruthy();
  });
});

describe("a draft pull request that could not be turned ready", () => {
  it("is listed with its error, and says it is still a draft", async () => {
    renderWithApp(
      <BlockedQueue />,
      fakeServer({
        "GET /blocked": () => ({
          json: queue({
            readyFailures: [
              {
                specId: 1,
                specDisplayId: "S-1",
                repo: "frontend",
                number: 2,
                url: "https://github.com/me/shop-frontend/pull/2",
                error: "GitHub refused to mark pull request 2 ready (403)",
              },
            ],
          }),
        }),
      }),
    );
    const item = within(await screen.findByTestId("ready-S-1-frontend"));
    expect(item.getByText(/refused to mark pull request 2 ready/)).toBeTruthy();
    expect(item.getByText(/still a draft/)).toBeTruthy();
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
