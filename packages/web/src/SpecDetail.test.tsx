// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpecDetail } from "./SpecDetail.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const ticket = (
  n: number,
  state: string,
  over: Record<string, unknown> = {},
) => ({
  id: n,
  displayId: `T-${n}`,
  specId: 1,
  specDisplayId: "S-1",
  title: `Ticket ${n}`,
  type: "implementation",
  state,
  blockedReason: null,
  repo: "backend",
  refs: [],
  environment: [],
  appended: false,
  brief: null,
  ...over,
});

const view = (
  over: {
    spec?: Record<string, unknown>;
    tickets?: unknown[];
    edges?: unknown[];
    finalizations?: unknown[];
    pullRequests?: unknown[];
    acceptancePack?: unknown;
  } = {},
) => ({
  spec: {
    id: 1,
    displayId: "S-1",
    slug: "order-export",
    title: "Order export",
    type: "feature",
    body: "",
    state: "draft",
    pauseReason: null,
    integrationBranches: [],
    warnings: [],
    ...over.spec,
  },
  tickets: over.tickets ?? [
    ticket(1, "pending"),
    ticket(2, "pending"),
    ticket(3, "pending"),
  ],
  edges: over.edges ?? [
    { from: "T-1", to: "T-2", kind: "blocks" },
    { from: "T-1", to: "T-3", kind: "contract" },
  ],
  finalizations: over.finalizations ?? [],
  mergeOrder: { ordered: [], after: {}, unordered: [] },
  orderBroken: [],
  pullRequests: over.pullRequests ?? [],
  acceptancePack: over.acceptancePack ?? null,
});

const node = (id: string) => screen.getByTestId(`node-${id}`);

describe("the spec page", () => {
  it("draws a node per ticket, coloured by the ticket's state", async () => {
    const server = fakeServer({
      "GET /specs/1": () => ({
        json: view({
          spec: { state: "running" },
          tickets: [
            ticket(1, "done"),
            ticket(2, "blocked", { blockedReason: "agent-gave-up" }),
            ticket(3, "running"),
            ticket(4, "pending"),
          ],
          edges: [],
        }),
      }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);

    await screen.findByTestId("node-T-1");
    expect(node("T-1").getAttribute("data-state")).toBe("done");
    expect(node("T-2").getAttribute("data-state")).toBe("blocked");
    expect(node("T-3").getAttribute("data-state")).toBe("running");
    expect(node("T-4").getAttribute("data-state")).toBe("pending");
    expect(node("T-2").textContent).toContain("blocked (agent-gave-up)");
    expect(node("T-1").textContent).toContain("Ticket 1");
    // each state has its own look: a blocked node is not drawn like a done one
    const borders = ["T-1", "T-2", "T-3", "T-4"].map(
      (id) => (node(id) as HTMLElement).style.borderColor,
    );
    expect(new Set(borders).size).toBe(4);
  });

  it("names the repo of each ticket on its node in the graph", async () => {
    const server = fakeServer({
      "GET /specs/1": () => ({
        json: view({
          tickets: [
            ticket(1, "done", { repo: "backend" }),
            ticket(2, "pending", { repo: "payments" }),
          ],
          edges: [{ from: "T-1", to: "T-2", kind: "contract" }],
        }),
      }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);

    await screen.findByTestId("node-T-1");
    expect(node("T-1").textContent).toContain("backend");
    expect(node("T-2").textContent).toContain("payments");
  });

  it("marks the tickets that were appended after the plan was confirmed", async () => {
    const server = fakeServer({
      "GET /specs/1": () => ({
        json: view({
          tickets: [
            ticket(1, "done"),
            ticket(2, "pending", { appended: true }),
          ],
          edges: [],
        }),
      }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);

    await screen.findByTestId("node-T-1");
    expect(node("T-1").textContent).not.toContain("appended");
    expect(node("T-2").textContent).toContain("appended");
  });

  it("shows which pull request waits for which, and that it is a draft until then", async () => {
    const pullRequests = [
      {
        order: 1,
        waitsFor: [],
        repo: "backend",
        number: 7,
        url: "https://github.com/me/shop-backend/pull/7",
        state: "open",
        draft: false,
        ci: "success",
        review: "none",
        syncError: null,
      },
      {
        order: 2,
        waitsFor: ["backend"],
        repo: "frontend",
        number: 8,
        url: "https://github.com/me/shop-frontend/pull/8",
        state: "open",
        draft: true,
        ci: "none",
        review: "none",
        syncError: null,
      },
      {
        order: 3,
        waitsFor: [],
        repo: "docs",
        number: 9,
        url: "https://github.com/me/shop-docs/pull/9",
        state: "open",
        draft: false,
        ci: "none",
        review: "none",
        syncError: null,
      },
    ];
    const server = fakeServer({
      "GET /specs/1": () => ({
        json: {
          ...view({ spec: { state: "awaiting-review" }, pullRequests }),
          mergeOrder: {
            ordered: ["backend", "frontend"],
            after: { backend: [], frontend: ["backend"] },
            unordered: ["docs"],
          },
          orderBroken: [{ repo: "frontend", skipped: ["backend"] }],
        },
      }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);
    fireEvent.click(await screen.findByRole("tab", { name: "交付" }));

    const frontend = (await screen.findByText(/frontend #8/)).closest("li");
    expect(frontend?.textContent).toContain("(draft)");
    expect(frontend?.textContent).toContain("after backend");
    expect(screen.getByText(/No order between: docs/)).toBeTruthy();
    expect(screen.getByTestId("order-broken").textContent).toContain(
      "frontend was merged before backend",
    );
  });

  it("lists the tickets and their states beside the text", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({
            tickets: [ticket(1, "blocked", { blockedReason: "gate-failed" })],
            edges: [],
          }),
        }),
      }),
    );
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "LI" &&
          /T-1 Ticket 1 \[backend\] — gate-failed/.test(
            element.textContent ?? "",
          ),
      ),
    ).toBeTruthy();
  });

  it("shows the pull requests in merge order and the acceptance pack: what backs each criterion, findings, doubts, gates", async () => {
    const pullRequests = [
      {
        order: 1,
        waitsFor: [],
        repo: "backend",
        number: 7,
        url: "https://github.com/me/shop/pull/7",
        state: "open",
        draft: false,
        ci: "success",
        review: "approved",
        syncError: null,
      },
      {
        order: 2,
        waitsFor: [],
        repo: "frontend",
        number: 3,
        url: "https://github.com/me/shop-web/pull/3",
        state: "open",
        draft: true,
        ci: "pending",
        review: "none",
        syncError: "GitHub answered 502",
      },
    ];
    const acceptancePack = {
      generatedAt: "2026-10-28T10:00:00.000Z",
      mergeOrder: {
        ordered: ["backend", "frontend"],
        after: { backend: [], frontend: ["backend"] },
        unordered: [],
      },
      orderBroken: [],
      repos: [
        {
          repo: "backend",
          pullRequest: pullRequests[0],
          gate: {
            commitSha: "0123456789abcdef",
            testsTotal: 3,
            testsSkipped: 1,
            durationMs: 4000,
            steps: [{ name: "test", exitCode: 0, ms: 2500 }],
          },
          tickets: [
            {
              displayId: "T-1",
              title: "Ticket 1",
              appended: false,
              criteria: [
                {
                  text: "exports orders",
                  tests: ["exports a csv"],
                  status: "verified",
                  reason: null,
                },
                {
                  text: "has a header",
                  tests: [],
                  status: "unverified",
                  reason: "the agent named no test",
                },
              ],
            },
          ],
          findings: [
            {
              ticket: "T-1",
              run: "R-3",
              stage: "review",
              kind: "suggestion",
              body: "rename x",
              resolution: "acceptance-pack",
            },
          ],
          uncertainties: [{ source: "T-1 implement", text: "date format?" }],
          protectedPathApprovals: [
            { ticket: "T-1", paths: [".github/ci.yml"] },
          ],
        },
        {
          repo: "frontend",
          pullRequest: pullRequests[1],
          gate: null,
          tickets: [
            {
              displayId: "T-2",
              title: "Ticket 2",
              appended: true,
              criteria: [],
            },
          ],
          findings: [],
          uncertainties: [],
          protectedPathApprovals: [],
        },
      ],
      cancelledTickets: [
        { displayId: "T-3", title: "Dropped", repo: "backend" },
      ],
      agentSeconds: 12,
    };
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({
            spec: { state: "awaiting-review" },
            tickets: [ticket(1, "done")],
            edges: [],
            pullRequests,
            acceptancePack,
          }),
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "交付" }));
    const prs = (await screen.findAllByText(/CI /)).map((e) => e.textContent);
    expect(prs[0]).toContain("CI success, review approved");
    expect(prs[1]).toContain("CI pending, review none");
    expect(
      screen.getByText(/could not be read: GitHub answered 502/),
    ).toBeTruthy();
    expect(screen.getByText("backend #7").getAttribute("href")).toBe(
      "https://github.com/me/shop/pull/7",
    );
    const criterion = (text: string) =>
      screen.getByText(text, { exact: false }).closest("li") as HTMLElement;
    expect(criterion("exports orders").getAttribute("data-status")).toBe(
      "verified",
    );
    expect(criterion("has a header").getAttribute("data-status")).toBe(
      "unverified",
    );
    expect(criterion("has a header").textContent).toContain(
      "the agent named no test",
    );
    expect(screen.getByText(/rename x/)).toBeTruthy();
    expect(screen.getByText(/T-1 implement: date format\?/)).toBeTruthy();
    expect(
      screen.getByText(/Gate: 01234567: 3 tests, 1 skipped, 4.0 s/),
    ).toBeTruthy();
    expect(screen.getByText(/\.github\/ci.yml/)).toBeTruthy();
    // the pack opens with the merge order and has a section for each repo, in that order
    expect(screen.getByTestId("pack-merge-order").textContent).toContain(
      "backend → frontend",
    );
    const sections = screen.getAllByTestId(/^pack-repo-/);
    expect(sections.map((e) => e.getAttribute("data-testid"))).toEqual([
      "pack-repo-backend",
      "pack-repo-frontend",
    ]);
    expect(sections[1]?.textContent).toContain("appended");
    expect(screen.getByText("Cancelled tickets")).toBeTruthy();
    expect(screen.getByText(/Dropped/).closest("li")?.textContent).toContain(
      "cancelled",
    );
  });

  it("says a pull request closed on the host was closed without merge", async () => {
    const pullRequests = [
      {
        order: 1,
        waitsFor: [],
        repo: "backend",
        number: 7,
        url: "https://github.com/me/shop/pull/7",
        state: "closed",
        draft: false,
        ci: "success",
        review: "none",
        syncError: null,
      },
    ];
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({ spec: { state: "awaiting-review" }, pullRequests }),
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "交付" }));
    expect(await screen.findByText("closed without merge")).toBeTruthy();
  });

  it("has no pull request or pack section before there is one", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({ "GET /specs/1": () => ({ json: view() }) }),
    );
    await screen.findByText("Tickets");
    expect(screen.queryByText("Acceptance pack")).toBeNull();
    expect(screen.queryByText("Pull requests")).toBeNull();
  });

  it("shows the warnings the import left", async () => {
    const warnings = [
      {
        type: "module-overlap",
        tickets: ["a", "b"],
        repoId: 1,
        message:
          "tickets a and b touch overlapping modules in the same repo but neither depends on the other",
      },
    ];
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({ json: view({ spec: { warnings } }) }),
      }),
    );
    expect(
      await screen.findByText(/tickets a and b touch overlapping modules/),
    ).toBeTruthy();
  });

  it("says so when there are no warnings", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({ "GET /specs/1": () => ({ json: view() }) }),
    );
    expect(await screen.findByText("No warnings.")).toBeTruthy();
  });

  it("links every ticket to its own page, from the graph and from the list", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({
            tickets: [ticket(1, "done"), ticket(2, "pending")],
            edges: [],
          }),
        }),
      }),
    );
    await screen.findByTestId("node-T-2");
    const links = screen.getAllByRole("link", { name: "T-2" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "#/tickets/2",
      "#/tickets/2",
    ]);
  });

  it("shows the title, the state, and why a spec was paused", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({
            spec: {
              state: "paused",
              pauseReason: "the agent time limit of the spec was reached",
            },
          }),
        }),
      }),
    );
    expect(await screen.findByRole("heading", { level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "S-1 Order export",
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "paused",
    );
    expect(
      screen.getByText(/Paused: the agent time limit of the spec was reached/),
    ).toBeTruthy();
  });

  it("shows the overall review of a finalizing spec", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({
            spec: { state: "finalizing" },
            finalizations: [
              {
                specId: 1,
                specDisplayId: "S-1",
                repo: "backend",
                step: "final-merge",
                state: "blocked",
                blockedReason: "merge-conflict",
                brief: null,
              },
            ],
          }),
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "交付" }));
    expect(
      await screen.findByText("backend: final-merge blocked (merge-conflict)"),
    ).toBeTruthy();
  });

  it("links back to the list", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({ "GET /specs/1": () => ({ json: view() }) }),
    );
    const back = await screen.findByRole("link", { name: /all specs/ });
    expect(back.getAttribute("href")).toBe("#/");
  });
});

describe("the body of the spec", () => {
  const BODY = [
    "## Problem Statement",
    "",
    "Customers want **CSV**.",
    "",
    "## Testing Decisions",
    "",
    "- [x] a done thing",
    "- [ ] an open thing",
    "",
    "```ts",
    "## not a section",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "<script>alert(1)</script>",
  ].join("\n");
  const open = (body: string, over: Record<string, unknown> = {}) =>
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({
          json: view({ spec: { body, state: "running" }, ...over }),
        }),
      }),
    );

  it("is rendered as markdown: task list boxes, a code block, a table, and no raw html", async () => {
    const { container } = open(BODY);
    await screen.findByText("Customers want", { exact: false });
    expect(container.querySelector("strong")?.textContent).toBe("CSV");
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'li.task-list-item input[type="checkbox"]',
    );
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "## not a section",
    );
    expect(container.querySelectorAll("table td")).toHaveLength(2);
    expect(container.querySelector("script")).toBeNull();
  });

  it("has a table of contents of the ## sections that jumps to them", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    open(BODY);
    const nav = await screen.findByRole("navigation", { name: "Contents" });
    const links = [...nav.querySelectorAll("button")].map((b) => b.textContent);
    // the heading inside the code fence is not a section
    expect(links).toEqual(["Problem Statement", "Testing Decisions"]);
    fireEvent.click(screen.getByRole("button", { name: "Testing Decisions" }));
    expect(scrolled).toEqual(["Testing Decisions"]);
  });

  it("says so when the spec has no body", async () => {
    open("  \n");
    expect(await screen.findByText("这份需求没有正文")).toBeTruthy();
  });

  it("keeps the delivery apart on its own tab", async () => {
    open(BODY, {
      pullRequests: [
        {
          order: 1,
          waitsFor: [],
          repo: "backend",
          number: 7,
          url: "https://github.com/me/shop/pull/7",
          state: "open",
          draft: false,
          ci: "success",
          review: "none",
          syncError: null,
        },
      ],
    });
    await screen.findByText("Problem Statement", { selector: "h2" });
    expect(screen.queryByText("Pull requests")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "交付" }));
    expect(await screen.findByText("Pull requests")).toBeTruthy();
    expect(
      screen.queryByText("Problem Statement", { selector: "h2" }),
    ).toBeNull();
  });
});

describe("the side column", () => {
  it("lists every ticket with its state, repo and what it waits for, and keeps the graph and warnings below", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({ "GET /specs/1": () => ({ json: view() }) }),
    );
    const item = await screen.findByText(
      (_, el) =>
        el?.tagName === "LI" &&
        /T-3 Ticket 3 \[backend\]/.test(el.textContent ?? "") &&
        /waits for T-1 \(contract\)/.test(el.textContent ?? ""),
    );
    expect(item).toBeTruthy();
    expect(screen.getByText("Warnings from the import")).toBeTruthy();
    expect(screen.getByText("Dependency graph")).toBeTruthy();
    // the confirm button of a draft is in the side column
    const side = item.closest("aside");
    expect(side?.textContent).toContain("Confirm split");
  });
});

describe("confirming the split", () => {
  // a spec that goes from draft to running when confirmed, like the real API
  function confirmable() {
    let confirmed = false;
    const server = fakeServer({
      "GET /specs/1": () =>
        confirmed
          ? {
              json: view({
                spec: { state: "running" },
                tickets: [
                  ticket(1, "queued"),
                  ticket(2, "pending"),
                  ticket(3, "pending"),
                ],
              }),
            }
          : { json: view() },
      "POST /specs/1/confirm": () => {
        confirmed = true;
        return {
          json: {
            state: "running",
            integrationBranches: [{ repoId: 1, branch: "spec/order-export" }],
            enqueued: [{ ticketId: 1, displayId: "T-1", jobId: 1 }],
          },
        };
      },
    });
    return server;
  }

  it("offers the button on a draft with tickets, and starts the spec when it is pressed", async () => {
    const server = confirmable();
    renderWithApp(<SpecDetail specId={1} />, server);
    const button = await screen.findByRole("button", { name: "Confirm split" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(node("T-1").getAttribute("data-state")).toBe("pending");

    fireEvent.click(button);

    // the page asks the API, then shows the spec as it is now: running, with the first ticket queued
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Confirm split" }),
      ).toBeNull(),
    );
    expect(server.calls).toContain("POST /specs/1/confirm");
    await waitFor(() =>
      expect(node("T-1").getAttribute("data-state")).toBe("queued"),
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "running",
    );
  });

  it("says what the API said when it refuses, and keeps the button", async () => {
    const server = fakeServer({
      "GET /specs/1": () => ({ json: view() }),
      "POST /specs/1/confirm": () => ({
        status: 409,
        json: { error: "confirm-plan is not allowed in running" },
      }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm split" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("confirm-plan is not allowed in running");
    expect(screen.getByRole("button", { name: "Confirm split" })).toBeTruthy();
  });

  it("cannot be pressed while there is nothing to confirm", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({ json: view({ tickets: [], edges: [] }) }),
      }),
    );
    const button = await screen.findByRole("button", { name: "Confirm split" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Import tickets first/)).toBeTruthy();
    expect(screen.getByText("No tickets imported.")).toBeTruthy();
  });

  it("has no button once the spec has been confirmed", async () => {
    renderWithApp(
      <SpecDetail specId={1} />,
      fakeServer({
        "GET /specs/1": () => ({ json: view({ spec: { state: "running" } }) }),
      }),
    );
    await screen.findByTestId("node-T-1");
    expect(screen.queryByRole("button", { name: "Confirm split" })).toBeNull();
  });
});

describe("when the spec cannot be shown", () => {
  it("says it is loading, and then what went wrong", async () => {
    const server = fakeServer({
      "GET /specs/1": () => ({ status: 404, json: { error: "no such spec" } }),
    });
    renderWithApp(<SpecDetail specId={1} />, server);
    expect(screen.getByText("Loading the spec…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the spec: no such spec",
    );
  });
});
