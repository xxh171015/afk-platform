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
    body: "## Parent\n\nS-1\n\n## What to build\n\nExport **orders**.\n\n## Acceptance criteria\n\n- [ ] returns text/csv\n- [ ] has a header row\n",
    file: "---\nid: T-4\nversion: 1\ntitle: Export orders as CSV\n---\n## Parent\n\nS-1\n",
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
  it("lists the runs with number, stage, result, duration and start time, each linking to the run page", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({ json: view() }),
    });
    renderWithApp(<TicketDetail ticketId={4} />, server);

    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("编号")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("开始时间")).toBeTruthy();
    const implement = within(rows[1] as HTMLElement);
    expect(
      implement.getByRole("link", { name: "R-10" }).getAttribute("href"),
    ).toBe("/runs/10");
    expect(implement.getByText("implement #1")).toBeTruthy();
    expect(implement.getByText("done")).toBeTruthy();
    expect(implement.getByText("146 s")).toBeTruthy();
    expect(implement.getByRole("time").getAttribute("dateTime")).toBe(
      "2026-10-28T10:00:00.000Z",
    );
    expect(implement.queryByText("auto")).toBeNull();
    const gate = within(rows[2] as HTMLElement);
    expect(gate.getByRole("link", { name: "R-11" }).getAttribute("href")).toBe(
      "/runs/11",
    );
    expect(gate.getByText("failed")).toBeTruthy();
    expect(gate.getByText("20 s")).toBeTruthy();
  });

  it("shows an older version of the body and of the original text from the version list", async () => {
    const edited = view({
      versions: [
        { version: 1, createdAt: "2026-10-28T09:00:00.000Z" },
        { version: 2, createdAt: "2026-10-29T10:00:00.000Z" },
      ],
    });
    edited.ticket.contentVersion = 2;
    const server = fakeServer({
      "GET /tickets/4": ({ url }) =>
        url.searchParams.get("version") === "1"
          ? {
              json: {
                ...view(),
                ticket: {
                  ...view().ticket,
                  body: "## What to build\n\nthe first wording\n",
                  file: "---\nversion: 1\n---\nthe first file\n",
                },
              },
            }
          : { json: edited },
      ...logs({ 10: "implement log", 11: "gate log" }),
    });
    renderWithApp(<TicketDetail ticketId={4} />, server);

    const select = (await screen.findByLabelText(
      /Version/,
    )) as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(screen.getByText(/v2 \(2026-10-29\) · current/)).toBeTruthy();
    fireEvent.change(select, { target: { value: "1" } });
    expect(await screen.findByText("the first wording")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/agent 读到的原文/));
    expect(screen.getByTestId("ticket-original").textContent).toBe(
      "---\nversion: 1\n---\nthe first file\n",
    );
  });

  it("shows the title, state, type and the body as markdown, with its checkboxes", async () => {
    renderWithApp(
      <TicketDetail ticketId={4} />,
      fakeServer({
        "GET /tickets/4": () => ({ json: view() }),
        ...logs({ 10: "x", 11: "y" }),
      }),
    );
    const heading = await screen.findByRole("heading", {
      level: 2,
      name: /T-4/,
    });
    expect(heading.textContent).toContain("T-4 Export orders as CSV");
    expect(heading.textContent).toContain("运行中");
    expect(screen.getByText("returns text/csv")).toBeTruthy();
    expect(screen.getByText("has a header row")).toBeTruthy();
    expect(
      document.querySelectorAll('input[type="checkbox"][disabled]'),
    ).toHaveLength(2);
    expect(document.querySelector(".markdown strong")?.textContent).toBe(
      "orders",
    );
    expect(
      screen.getByText(/implementation, repo backend, version 1/),
    ).toBeTruthy();
    for (const link of screen.getAllByRole("link", { name: /S-1/ }))
      expect(link.getAttribute("href")).toBe("/specs/1");
  });

  it("does not show a log on the ticket; the run number is a link", async () => {
    renderWithApp(
      <TicketDetail ticketId={4} />,
      fakeServer({ "GET /tickets/4": () => ({ json: view() }) }),
    );
    const link = await screen.findByRole("link", { name: "R-10" });
    expect(link.getAttribute("href")).toBe("/runs/10");
    expect(link.closest("tr")?.className).toContain("relative");
    expect(link.className).toContain("after:inset-0");
    expect(screen.queryByTestId("run-log")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Log of/ })).toBeNull();
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
    renderWithApp(<TicketDetail ticketId={4} />, server);
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
    renderWithApp(<TicketDetail ticketId={4} />, server);
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

  it("shows which axis of the review each review run and finding belongs to", async () => {
    const server = fakeServer({
      "GET /tickets/4": () => ({
        json: view({
          runs: [
            run(10, "review", { axis: "standards" }),
            run(11, "review", { axis: "spec" }),
          ],
          findings: [
            {
              id: 1,
              runId: 10,
              kind: "must-fix",
              body: "a.ts naming",
              resolution: "unhandled",
              axis: "standards",
            },
            {
              id: 2,
              runId: 11,
              kind: "scope-creep",
              body: "an extra flag",
              resolution: "acceptance-pack",
              axis: "spec",
            },
          ],
        }),
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} />, server);
    expect(await screen.findByText(/review \(standards\) #1/)).toBeTruthy();
    expect(screen.getByText(/review \(spec\) #1/)).toBeTruthy();
    expect(screen.getByText("standards").className).toContain("axis-standards");
    expect(screen.getByText("spec").className).toContain("axis-spec");
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
    renderWithApp(<TicketDetail ticketId={4} />, server);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("gate ended failed");
    expect(note.textContent).toContain("R-11");
    expect(note.textContent).toContain("# test failed");
    expect(screen.getByTitle("gate-failed").textContent).toBe("门禁失败");
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
    renderWithApp(<TicketDetail ticketId={4} />, server);
    expect(await screen.findByText("E2E tries")).toBeTruthy();
    expect(screen.getByText(/1 of 2 fix rounds used/)).toBeTruthy();
    expect(screen.getByText(/R-20 failed/)).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "LI" &&
          /1 of 3 tests failed, built from backend@0123456/.test(
            element.textContent ?? "",
          ),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "0123456" })).toBeTruthy();
    expect(
      screen.getByText(/GET \/orders\/1\/export answers 404/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "T-9" }).getAttribute("href")).toBe(
      "/tickets/9",
    );
    expect(screen.getByText(/R-24 passed/)).toBeTruthy();
  });

  it("shows the spec, what the ticket waits for, what it blocks and the other tickets of the spec in the side column", async () => {
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
      "GET /specs/1": () => ({
        json: {
          spec: { id: 1, displayId: "S-1", title: "Order export" },
          tickets: [
            { id: 2, displayId: "T-2", title: "Contract", state: "done" },
            { id: 4, displayId: "T-4", title: "Export", state: "running" },
            { id: 6, displayId: "T-6", title: "Button", state: "pending" },
          ],
        },
      }),
      ...logs({ 10: "a", 11: "b" }),
    });
    renderWithApp(<TicketDetail ticketId={4} />, server);
    const side = (await screen.findByText("Waits for")).closest("aside");
    if (!side) throw new Error("no side column");
    await within(side).findByText(/Order export/);
    expect(
      within(side).getByRole("link", { name: "S-1" }).getAttribute("href"),
    ).toBe("/specs/1");
    const waits = within(side).getAllByRole("link", { name: "T-2" });
    expect(waits.map((l) => l.getAttribute("href"))).toEqual([
      "/tickets/2",
      "/tickets/2",
    ]);
    expect(side.textContent).toMatch(/T-2.*\(blocks, done\)/);
    expect(side.textContent).toMatch(/Blocks.*T-6.*\(contract, pending\)/);
    expect(within(side).getByText("Tickets of S-1")).toBeTruthy();
    expect(
      within(side).getByRole("link", { name: "T-4" }).closest("li")?.className,
    ).toBe("picked");
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

  it("keeps showing the ticket when a later GET fails", async () => {
    let failing = false;
    const server = fakeServer({
      "GET /tickets/4": () =>
        failing
          ? { status: 500, json: { error: "database is down" } }
          : { json: view() },
    });
    const { queryClient } = renderWithApp(
      <TicketDetail ticketId={4} />,
      server,
    );
    await screen.findByText(/Export orders as CSV/);
    failing = true;
    await queryClient.refetchQueries({ queryKey: ["ticket", 4] });
    await waitFor(() =>
      expect(queryClient.getQueryState(["ticket", 4])?.status).toBe("error"),
    );
    expect(screen.getByText(/Export orders as CSV/)).toBeTruthy();
    expect(screen.queryByText(/Could not load the ticket/)).toBeNull();
  });
});
