import { describe, expect, it } from "vitest";
import { ticketText } from "./format.ts";

const view = (runs: Parameters<typeof ticketText>[0]["runs"]) => ({
  ticket: {
    displayId: "T-3",
    specDisplayId: "S-1",
    title: "Export button",
    state: "running",
    blockedReason: null,
    repo: "frontend",
    refs: [],
    environment: [],
    appended: false,
    brief: null,
    acceptanceCriteria: [],
    allowedProtectedPaths: [],
    fixCounts: {},
    contentVersion: 1,
  },
  versions: [],
  upstream: [],
  downstream: [],
  runs,
  findings: [],
});

describe("ticketText runs", () => {
  it("ends a run line with the contract and ref SHAs it used, and with nothing else when it used none", () => {
    const text = ticketText(
      view([
        {
          displayId: "R-1",
          stage: "implement",
          attempt: 1,
          result: "done",
          durationMs: 5000,
          contractShas: { backend: "0123456789abcdef" },
          refShas: { backend: "fedcba9876543210", payments: "aaaaaaaabbbb" },
        },
        {
          displayId: "R-2",
          stage: "gate",
          attempt: 1,
          result: "passed",
          durationMs: 1000,
          contractShas: null,
          refShas: null,
        },
      ]),
    );
    expect(text).toContain(
      "  R-1  implement #1  done  5s  contracts backend@01234567  refs backend@fedcba98, payments@aaaaaaaa\n",
    );
    expect(text).toMatch(/ {2}R-2 {2}gate #1 {2}passed {2}1s$/m);
  });
});

describe("an integration ticket", () => {
  const attempts = [
    {
      e2e: {
        displayId: "R-5",
        result: "failed",
        testsTotal: 3,
        testsFailed: 1,
        envUpMs: 4200,
        refShas: { backend: "0123456789abcdef" },
      },
      diagnosis: {
        failingRepo: "backend",
        evidence: "GET /orders/1/export answers 404\nmore",
        failingTests: ["downloads the export"],
      },
      fixTicket: { displayId: "T-7", state: "done", repo: "backend" },
    },
    {
      e2e: {
        displayId: "R-9",
        result: "passed",
        testsTotal: 3,
        testsFailed: 0,
        envUpMs: null,
        refShas: null,
      },
      diagnosis: null,
      fixTicket: null,
    },
  ];

  it("shows its rounds, and in the brief every e2e with its diagnosis and fix ticket", () => {
    const brief = {
      run: { displayId: "R-9" },
      stage: "e2e",
      result: "failed",
      output: { reasons: ["1 of 3 e2e tests failed"] },
      attempts,
    };
    const text = ticketText({
      ...view([]),
      ticket: { ...view([]).ticket, brief },
      integration: { rounds: 1 },
    });
    expect(text).toContain("integration: 1 of 2 fix rounds used");
    expect(text).toContain(
      "e2e 1: failed in R-5, 1 of 3 tests failed, environment up in 4.2 s, built from backend@01234567",
    );
    expect(text).toContain(
      "diagnosis: backend: GET /orders/1/export answers 404",
    );
    expect(text).toContain("failing: downloads the export");
    expect(text).toContain("fix ticket: T-7 (done, backend)");
    expect(text).toContain("e2e 2: passed in R-9, 0 of 3 tests failed");
  });
});
