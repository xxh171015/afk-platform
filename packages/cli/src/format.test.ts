import { describe, expect, it } from "vitest";
import { acceptancePackText, blockedText, ticketText } from "./format.ts";

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
    body: "## Acceptance criteria\n\n- [ ] a\n",
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
  it("ends a run line with the skills, contract and ref SHAs it used, and with nothing else when it used none", () => {
    const text = ticketText(
      view([
        {
          displayId: "R-1",
          stage: "implement",
          attempt: 1,
          result: "done",
          durationMs: 5000,
          skillsSha: "5beb35b0123456789abcdef0123456789abcdef0",
          contractShas: { backend: "0123456789abcdef" },
          refShas: { backend: "fedcba9876543210", payments: "aaaaaaaabbbb" },
        },
        {
          displayId: "R-2",
          stage: "gate",
          attempt: 1,
          result: "passed",
          durationMs: 1000,
          skillsSha: null,
          contractShas: null,
          refShas: null,
        },
      ]),
    );
    expect(text).toContain(
      "  R-1  implement #1  done  5s  skills 5beb35b0  contracts backend@01234567  refs backend@fedcba98, payments@aaaaaaaa\n",
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

const emptyQueue = {
  tickets: [],
  finalizations: [],
  pullRequests: [],
  cleanups: [],
  readyFailures: [],
  planning: [],
  specs: [],
};

const stuckTicket = (over: Record<string, unknown> = {}) => ({
  id: 1,
  displayId: "T-12",
  specDisplayId: "S-19",
  title: "Export",
  state: "blocked",
  blockedReason: "gate-failed",
  repo: "backend",
  refs: [] as string[],
  environment: [] as string[],
  appended: false,
  brief: {
    run: { displayId: "R-7" },
    stage: "gate",
    result: "failed",
    output: { failureLog: "still boom" },
  },
  structuredBrief: {
    reason: "gate-failed",
    step: "gate",
    summary: "门禁失败",
    evidence: { lastLogLines: "still boom" },
    recommendedAction: "看失败的测试，修好后带说明重试，保留已有提交",
    commands: [
      {
        label: "带说明继续",
        command: 'plat ticket retry T-12 --mode continue --note "…"',
      },
    ],
  },
  ...over,
});

describe("plat blocked of a stuck ticket", () => {
  it("prints the structured brief's summary, recommended action and commands, not only the raw stage result", () => {
    const text = blockedText({
      ...emptyQueue,
      tickets: [stuckTicket()],
    } as never);
    expect(text).toContain("门禁失败");
    expect(text).toContain("看失败的测试，修好后带说明重试，保留已有提交");
    expect(text).toContain("plat ticket retry T-12 --mode continue");
    expect(text).toContain('plat ticket retry T-12 --mode continue --note "…"');
  });

  it("prints approve-protected and the following retry for protected-path-changed", () => {
    const text = blockedText({
      ...emptyQueue,
      tickets: [
        stuckTicket({
          blockedReason: "protected-path-changed",
          structuredBrief: {
            reason: "protected-path-changed",
            step: "gate",
            summary: "改了受保护路径",
            evidence: { lastLogLines: ".github/ci.yml" },
            recommendedAction: "确认这些路径可以改，或改允许名单后重试",
            commands: [
              {
                label: "批准保护路径",
                command: "plat ticket approve-protected T-12",
              },
              {
                label: "再重试",
                command: "plat ticket retry T-12 --mode continue",
              },
            ],
          },
        }),
      ],
    } as never);
    expect(text).toContain("plat ticket approve-protected T-12");
    expect(text).toContain("plat ticket retry T-12 --mode continue");
  });

  it("prints the append import command for contract-change-needed", () => {
    const text = blockedText({
      ...emptyQueue,
      tickets: [
        stuckTicket({
          blockedReason: "contract-change-needed",
          structuredBrief: {
            reason: "contract-change-needed",
            step: "implement",
            summary: "需要改契约",
            evidence: { lastLogLines: "needs a new field on Order" },
            recommendedAction: "先改提供方契约票，再继续",
            commands: [
              {
                label: "追加契约票",
                command:
                  "plat tickets import S-19 ~/.afk/planning/S-19/append/ --append",
              },
            ],
            ticketDraft: "---\ntitle: 改契约以继续 T-12\n",
          },
        }),
      ],
    } as never);
    expect(text).toContain(
      "plat tickets import S-19 ~/.afk/planning/S-19/append/ --append",
    );
    expect(text).toContain("title: 改契约以继续 T-12");
  });

  it("prints a wrap-up step's structured brief the same way", () => {
    const text = blockedText({
      ...emptyQueue,
      finalizations: [
        {
          specDisplayId: "S-19",
          repo: "backend",
          step: "final-review",
          state: "blocked",
          blockedReason: "job-failed",
          brief: null,
          structuredBrief: {
            reason: "job-failed",
            step: "",
            summary: "作业失败",
            evidence: {},
            recommendedAction: "看作业失败原因，环境好了再重试",
            commands: [
              { label: "再跑收尾", command: "plat spec retry-final S-19" },
            ],
          },
        },
      ],
    } as never);
    expect(text).toContain("作业失败");
    expect(text).toContain("看作业失败原因，环境好了再重试");
    expect(text).toContain("plat spec retry-final S-19");
  });
});

describe("the e2e before the pull requests", () => {
  it("is a blocked step with the two ways forward", () => {
    const text = blockedText({
      tickets: [],
      finalizations: [
        {
          specDisplayId: "S-1",
          repo: "(integration)",
          step: "final-e2e",
          state: "blocked",
          blockedReason: "final-e2e-failed",
          brief: null,
        },
      ],
      pullRequests: [],
      cleanups: [],
      readyFailures: [],
      planning: [],
      specs: [],
    } as never);
    expect(text).toContain("S-1  e2e before the pull requests");
    expect(text).toContain("plat spec retry-final S-1");
    expect(text).toContain("plat spec waive-final S-1");
  });

  it("is the first thing in an acceptance pack whose pull requests were opened after it failed", () => {
    const pack = {
      mergeOrder: { ordered: [], after: {}, unordered: [] },
      orderBroken: [],
      repos: [],
      cancelledTickets: [],
      integration: {
        failedBeforePullRequest: {
          tickets: [
            {
              displayId: "T-2",
              title: "Export e2e",
              e2e: { displayId: "R-9", result: "failed" },
              diagnosis: {
                failingRepo: "backend",
                evidence: "GET /orders/export answers 404",
                failingTests: ["exports"],
              },
            },
          ],
        },
        tickets: [
          {
            displayId: "T-2",
            title: "Export e2e",
            repo: "frontend",
            appended: false,
            result: "failed",
            runDisplayId: "R-9",
            testsTotal: 3,
            testsFailed: 1,
            envUpMs: 4000,
            refShas: { backend: "0123456789abcdef" },
            headSha: "fedcba9876543210",
            criteria: [
              {
                text: "it downloads",
                tests: ["exports"],
                status: "unverified",
                reason: "failed: exports",
              },
            ],
          },
        ],
      },
    };
    const lines = acceptancePackText(pack as never).split("\n");
    expect(lines[0]).toBe("acceptance pack:");
    expect(lines[1]).toContain("the e2e before the pull requests failed");
    expect(lines.join("\n")).toContain(
      "diagnosis: backend: GET /orders/export answers 404",
    );
    expect(lines.join("\n")).toContain(
      "T-2  Export e2e  [frontend]  e2e failed in R-9, 1 of 3 tests failed, environment up in 4.0 s",
    );
    expect(lines.join("\n")).toContain(
      "environment: backend@01234567, frontend@fedcba98",
    );
    expect(lines.join("\n")).toContain("[unverified] it downloads");
  });
});
