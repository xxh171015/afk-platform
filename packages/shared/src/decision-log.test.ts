import { describe, expect, it } from "vitest";
import { decisionId, decisionLogFromRuns } from "./decision-log.ts";
import type { DecisionKind } from "./decisions.ts";

const run = (
  id: number,
  stage: string,
  ticketId: number | null,
  decisions: { kind: DecisionKind; text: string }[],
) => ({
  id,
  stage,
  ticketId,
  output: { status: "done", decisions },
});

describe("decisionLogFromRuns", () => {
  it("puts this ticket's earlier decisions on the ticket group, with R-n#index ids", () => {
    const log = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: 1,
      ticketDisplayId: "T-1",
      currentRunId: 20,
      tickets: [
        { id: 1, state: "running" },
        { id: 2, state: "pending" },
      ],
      runs: [
        run(10, "implement", 1, [
          { kind: "conflict", text: "picked the story" },
        ]),
        run(20, "gate-fix", 1, [{ kind: "choice", text: "should not appear" }]),
      ],
    });
    expect(log.ticket).toEqual({
      displayId: "T-1",
      decisions: [
        {
          id: "R-10#0",
          run: "R-10",
          stage: "implement",
          kind: "conflict",
          text: "picked the story",
        },
      ],
      rulings: [],
    });
    expect(log.doneTickets).toEqual([]);
    expect(log.spec).toBeNull();
    expect(decisionId(10, 0)).toBe("R-10#0");
  });

  it("lists done siblings and omits tickets that are not done", () => {
    const log = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: 2,
      ticketDisplayId: "T-2",
      currentRunId: 30,
      tickets: [
        { id: 1, state: "done" },
        { id: 2, state: "running" },
        { id: 3, state: "pending" },
      ],
      runs: [
        run(10, "implement", 1, [{ kind: "choice", text: "named it export" }]),
        run(11, "implement", 3, [
          { kind: "conflict", text: "should not appear" },
        ]),
      ],
    });
    expect(log.doneTickets.map((t) => t.displayId)).toEqual(["T-1"]);
    expect(log.doneTickets[0]?.decisions).toEqual([
      {
        id: "R-10#0",
        run: "R-10",
        stage: "implement",
        kind: "choice",
        text: "named it export",
      },
    ]);
    expect(log.ticket?.decisions).toEqual([]);
  });

  it("gives wrap-up the whole spec, including spec-level runs", () => {
    const log = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: null,
      ticketDisplayId: null,
      currentRunId: 40,
      tickets: [
        { id: 1, state: "done" },
        { id: 2, state: "done" },
      ],
      runs: [
        run(10, "implement", 1, [
          { kind: "known-gap", text: "reload skips the filter" },
        ]),
        run(30, "final-fix", null, [
          { kind: "workaround", text: "skipped drizzle" },
        ]),
      ],
    });
    expect(log.ticket).toBeNull();
    expect(log.doneTickets.map((t) => t.displayId)).toEqual(["T-1", "T-2"]);
    expect(log.spec).toEqual({
      displayId: "S-1",
      decisions: [
        {
          id: "R-30#0",
          run: "R-30",
          stage: "final-fix",
          kind: "workaround",
          text: "skipped drizzle",
        },
      ],
      rulings: [],
    });
  });

  it("on wrap-up includes a ticket that is not yet done", () => {
    const log = decisionLogFromRuns({
      specDisplayId: "S-1",
      ticketId: null,
      ticketDisplayId: null,
      currentRunId: 40,
      tickets: [
        { id: 1, state: "done" },
        { id: 2, state: "running" },
      ],
      runs: [
        run(10, "implement", 1, [{ kind: "choice", text: "named it export" }]),
        run(20, "implement", 2, [
          { kind: "conflict", text: "picked the story" },
        ]),
      ],
    });
    expect(log.doneTickets.map((t) => t.displayId)).toEqual(["T-1", "T-2"]);
    expect(log.doneTickets[1]?.decisions).toEqual([
      {
        id: "R-20#0",
        run: "R-20",
        stage: "implement",
        kind: "conflict",
        text: "picked the story",
      },
    ]);
  });
});
