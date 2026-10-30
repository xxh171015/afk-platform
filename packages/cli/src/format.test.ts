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
