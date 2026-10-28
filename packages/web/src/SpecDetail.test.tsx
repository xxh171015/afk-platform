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
  brief: null,
  ...over,
});

const view = (
  over: {
    spec?: Record<string, unknown>;
    tickets?: unknown[];
    edges?: unknown[];
    finalizations?: unknown[];
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

  it("lists the tickets and their states below the graph", async () => {
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
    expect(await screen.findByText(/T-1 Ticket 1 — gate-failed/)).toBeTruthy();
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
