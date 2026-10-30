// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TicketDetail } from "./TicketDetail.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const run = (
  id: number,
  stage: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  displayId: `R-${id}`,
  stage,
  attempt: 1,
  result: "done",
  durationMs: 146_000,
  agent: "cursor",
  model: "auto",
  skillsSha: "5beb35b",
  cursorCliVersion: "1.2.3",
  contractShas: null,
  refShas: null,
  startedAt: "2026-10-28T10:00:00.000Z",
  finishedAt: "2026-10-28T10:02:26.000Z",
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  versions: [{ version: 1, createdAt: "2026-10-28T09:00:00.000Z" }],
  ticket: {
    id: 4,
    displayId: "T-4",
    specId: 1,
    specDisplayId: "S-1",
    title: "Export orders as CSV",
    type: "implementation",
    state: "running",
    blockedReason: null,
    repo: "backend",
    brief: null,
    body: "",
    acceptanceCriteria: ["returns text/csv", "has a header row"],
    modules: ["src/orders/**"],
    allowedProtectedPaths: [],
    contentVersion: 1,
    contractSha: null,
    fixCounts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
    reviewed: false,
  },
  upstream: [],
  downstream: [],
  runs: [
    run(10, "implement"),
    run(11, "gate", {
      result: "failed",
      durationMs: 20_000,
      model: null,
      skillsSha: null,
      agent: null,
      cursorCliVersion: null,
    }),
  ],
  findings: [],
  gateResults: [],
  ...over,
});

const logs = (texts: Record<number, string>) =>
  Object.fromEntries(
    Object.entries(texts).map(([id, text]) => [
      `GET /runs/${id}/logs`,
      () => ({
        json: {
          attempt: 1,
          offset: 0,
          nextOffset: text.length,
          size: text.length,
          text,
          finished: true,
        },
      }),
    ]),
  );

describe("the ticket page", () => {
  it("lists the runs with stage, result, time, model and skills version", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({ json: view() }),
      ...logs({ 10: "implement log", 11: "gate log" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    const implement = within(rows[1] as HTMLElement);
    expect(implement.getByText("R-10")).toBeTruthy();
    expect(implement.getByText("implement #1")).toBeTruthy();
    expect(implement.getByText("done")).toBeTruthy();
    expect(implement.getByText("146 s")).toBeTruthy();
    expect(implement.getByText("auto")).toBeTruthy();
    expect(implement.getByText("5beb35b")).toBeTruthy();
    const gate = within(rows[2] as HTMLElement);
    expect(gate.getByText("failed")).toBeTruthy();
    expect(gate.getByText("20 s")).toBeTruthy();
    expect(gate.getAllByText("—")).toHaveLength(4); // a gate run has no model, no skills, no contract and no refs
  });

  it("shows which contract SHA of which repo a run used", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          runs: [
            run(10, "implement", {
              contractShas: {
                backend: "0123456789abcdef",
                payments: "fedcba9876",
              },
            }),
          ],
        }),
      }),
      ...logs({ 10: "implement log" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);

    expect(
      await screen.findByText("backend@01234567, payments@fedcba98"),
    ).toBeTruthy();
  });

  it("shows which SHA of which repo a run had mounted under /refs", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          runs: [
            run(10, "implement", { refShas: { backend: "0123456789abcdef" } }),
          ],
        }),
      }),
      ...logs({ 10: "implement log" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);

    expect(await screen.findByText("backend@01234567")).toBeTruthy();
  });

  it("shows the edit history when the ticket has been edited", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          versions: [
            { version: 1, createdAt: "2026-10-28T09:00:00.000Z" },
            { version: 2, createdAt: "2026-10-29T10:00:00.000Z" },
          ],
        }),
      }),
      ...logs({ 10: "implement log", 11: "gate log" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);

    expect(await screen.findByText(/Edited 1 time/)).toBeTruthy();
    expect(screen.getByText(/v2 \(2026-10-29\)/)).toBeTruthy();
  });

  it("shows the title, state, type and acceptance criteria", async () => {
    renderWithApp(
      <TicketDetail ticketId={4} logPollMs={20} />,
      fakeServer({
        "GET /tickets/4": () => ({ json: view() }),
        ...logs({ 10: "x", 11: "y" }),
      }),
    );
    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("T-4 Export orders as CSV");
    expect(heading.textContent).toContain("running");
    expect(screen.getByText("returns text/csv")).toBeTruthy();
    expect(screen.getByText("has a header row")).toBeTruthy();
    expect(
      screen.getByText(/implementation, repo backend, version 1/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /S-1/ }).getAttribute("href")).toBe(
      "#/specs/1",
    );
  });

  it("shows the log of the newest run, and of another one when it is picked", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({ json: view() }),
      ...logs({ 10: "log of the implement run", 11: "log of the gate run" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    await waitFor(() =>
      expect(screen.getByTestId("run-log").textContent).toBe(
        "log of the gate run",
      ),
    );
    expect(screen.getByRole("heading", { name: "Log of R-11" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "R-10" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-log").textContent).toBe(
        "log of the implement run",
      ),
    );
    expect(screen.getByRole("heading", { name: "Log of R-10" })).toBeTruthy();
  });

  it("shows gate results with their commands and the tests counted", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          gateResults: [
            {
              commitSha: "abcdef1234567",
              configSha: "cfg",
              commandResults: [
                { name: "typecheck", exitCode: 0 },
                { name: "test", exitCode: 1 },
              ],
              testsTotal: 12,
              testsSkipped: 1,
            },
            {
              commitSha: "0123456789abc",
              configSha: "cfg",
              commandResults: [],
              testsTotal: null,
              testsSkipped: null,
            },
          ],
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    expect(await screen.findByText("abcdef1")).toBeTruthy();
    expect(screen.getByText(/12 tests, 1 skipped/)).toBeTruthy();
    expect(screen.getByText("typecheck: exit 0")).toBeTruthy();
    expect(screen.getByText("test: exit 1")).toBeTruthy();
    expect(screen.getByText(/no JUnit/)).toBeTruthy();
  });

  it("shows findings with what became of them", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          findings: [
            {
              id: 1,
              runId: 12,
              kind: "must-fix",
              body: "src/a.ts:3 null check",
              resolution: "fixed",
            },
            {
              id: 2,
              runId: 12,
              kind: "suggestion",
              body: "rename x",
              resolution: "acceptance-pack",
            },
          ],
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    expect(
      await screen.findByText(/must-fix: src\/a.ts:3 null check/),
    ).toBeTruthy();
    expect(screen.getByText("fixed")).toBeTruthy();
    expect(screen.getByText(/suggestion: rename x/)).toBeTruthy();
    expect(screen.getByText("acceptance-pack")).toBeTruthy();
  });

  it("says so when there are no gates, no findings, no runs", async () => {
    renderWithApp(
      <TicketDetail ticketId={4} />,
      fakeServer({ "GET /tickets/4": () => ({ json: view({ runs: [] }) }) }),
    );
    expect(await screen.findByText("No runs yet.")).toBeTruthy();
    expect(screen.getByText("No gate has run on this ticket.")).toBeTruthy();
    expect(screen.getByText("No findings.")).toBeTruthy();
    expect(screen.queryByTestId("run-log")).toBeNull();
  });

  it("shows why a blocked ticket is blocked", async () => {
    const brief = {
      run: { id: 11, displayId: "R-11" },
      stage: "gate",
      result: "failed",
      output: { failureLog: "# test failed" },
      logPath: "/runs/11/logs",
    };
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          ticket: {
            ...view().ticket,
            state: "blocked",
            blockedReason: "gate-failed",
            brief,
          },
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("gate ended failed");
    expect(note.textContent).toContain("R-11");
    expect(note.textContent).toContain("# test failed");
    expect(screen.getByText(/blocked: gate-failed/)).toBeTruthy();
  });

  it("shows every e2e of an integration ticket with its diagnosis and its fix ticket", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          ticket: { ...view().ticket, type: "integration" },
          integration: {
            rounds: 1,
            attempts: [
              {
                e2e: {
                  id: 20,
                  displayId: "R-20",
                  result: "failed",
                  testsTotal: 3,
                  testsFailed: 1,
                  envUpMs: 4000,
                  refShas: { backend: "0123456789abcdef" },
                  headSha: "abc",
                },
                diagnosis: {
                  result: "fail",
                  failingRepo: "backend",
                  evidence: "GET /orders/1/export answers 404",
                  failingTests: ["downloads the export"],
                },
                fixTicket: {
                  id: 9,
                  displayId: "T-9",
                  state: "done",
                  repo: "backend",
                },
              },
              {
                e2e: {
                  id: 24,
                  displayId: "R-24",
                  result: "passed",
                  testsTotal: 3,
                  testsFailed: 0,
                  envUpMs: 4100,
                  refShas: null,
                  headSha: "abd",
                },
                diagnosis: null,
                fixTicket: null,
              },
            ],
          },
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    expect(await screen.findByText("E2E tries")).toBeTruthy();
    expect(screen.getByText(/1 of 2 fix rounds used/)).toBeTruthy();
    expect(screen.getByText(/R-20 failed/)).toBeTruthy();
    expect(
      screen.getByText(/1 of 3 tests failed, built from backend@01234567/),
    ).toBeTruthy();
    expect(
      screen.getByText(/GET \/orders\/1\/export answers 404/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "T-9" }).getAttribute("href")).toBe(
      "#/tickets/9",
    );
    expect(screen.getByText(/R-24 passed/)).toBeTruthy();
  });

  it("names the tickets it waits for and the ones waiting for it", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          upstream: [
            { id: 2, displayId: "T-2", kind: "blocks", state: "done" },
          ],
          downstream: [
            { id: 6, displayId: "T-6", kind: "contract", state: "pending" },
          ],
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} logPollMs={20} />, server);
    expect(
      await screen.findByText(
        /Waits for T-2 \(done\)\. Blocks T-6 \(pending\)\./,
      ),
    ).toBeTruthy();
  });

  it("says it is loading, and says when the ticket is not there", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        status: 404,
        json: { error: "no such ticket" },
      }),
    });
    renderWithApp(<TicketDetail ticketId={4} />, server);
    expect(screen.getByText("Loading the ticket…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the ticket: no such ticket",
    );
  });
});
