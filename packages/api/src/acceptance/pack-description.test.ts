import { describe, expect, it } from "vitest";
import type { AcceptancePack } from "./pack.ts";
import { renderPackSection } from "./pack-description.ts";

const criterion = (
  text: string,
  status: "verified" | "unverified",
  reason: string | null = null,
) => ({ text, tests: [] as string[], status, reason });

const pack = (over: Partial<AcceptancePack> = {}): AcceptancePack => ({
  generatedAt: "2026-11-01T00:00:00.000Z",
  mergeOrder: {
    ordered: ["backend", "frontend"],
    after: { frontend: ["backend"] },
    unordered: [],
  },
  orderBroken: [],
  repos: [
    {
      repo: "backend",
      pullRequest: null,
      gate: {
        commitSha: "abcdef1234567890",
        testsTotal: 3,
        testsSkipped: 0,
        durationMs: 1000,
        steps: [],
      },
      tickets: [
        {
          displayId: "T-1",
          title: "Export",
          appended: false,
          criteria: [
            criterion("it works", "verified"),
            criterion("it is fast", "unverified", "the agent named no test"),
          ],
        },
        {
          displayId: "T-3",
          title: "Types",
          appended: false,
          criteria: [
            criterion("it is typed", "verified"),
            criterion("it is documented", "unverified"),
          ],
        },
      ],
      findings: [
        {
          ticket: "T-1",
          run: "R-2",
          stage: "review",
          kind: "suggestion",
          body: "rename x",
          resolution: "acceptance-pack",
          axis: "standards",
        },
      ],
      scopeCreep: [],
      uncertainties: [{ source: "T-1 implement", text: "date format" }],
      protectedPathApprovals: [],
    },
    {
      repo: "frontend",
      pullRequest: null,
      gate: null,
      tickets: [
        {
          displayId: "T-2",
          title: "Page",
          appended: false,
          criteria: [criterion("renders", "verified")],
        },
      ],
      findings: [],
      scopeCreep: [],
      uncertainties: [],
      protectedPathApprovals: [],
    },
  ],
  integration: {
    failedBeforePullRequest: {
      tickets: [
        {
          displayId: "T-9",
          title: "E2E",
          e2e: { displayId: "R-20", result: "failed" },
          diagnosis: {
            failingRepo: "backend",
            evidence: "404",
            failingTests: ["exports"],
          },
        },
      ],
    },
    tickets: [
      {
        displayId: "T-9",
        title: "E2E",
        repo: "frontend",
        appended: false,
        result: "failed",
        runDisplayId: "R-20",
        testsTotal: 1,
        testsFailed: 1,
        envUpMs: 10,
        refShas: null,
        headSha: null,
        criteria: [criterion("end to end", "unverified", "failed")],
      },
    ],
  },
  cancelledTickets: [],
  agentSeconds: 4,
  ...over,
});

describe("renderPackSection", () => {
  it("puts unverified criteria before verified ones and leaves the other repo's criteria out", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    const criteria = section.slice(
      section.indexOf("### Acceptance criteria"),
      section.indexOf("### Findings"),
    );
    expect(criteria.indexOf("it is fast")).toBeLessThan(
      criteria.indexOf("it works"),
    );
    expect(criteria.indexOf("it is documented")).toBeLessThan(
      criteria.indexOf("it works"),
    );
    expect(section).not.toContain("renders");
    expect(section).toContain("## Merge order");
    expect(section).toContain("backend → frontend");
    expect(section).toContain("/specs/1/delivery");
  });

  it("puts waived e2e failures at the front of the integration section", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    const integration = section.slice(section.indexOf("## Integration"));
    expect(integration).toMatch(
      /Opened although the e2e before the pull requests failed:[\s\S]*\*\*T-9\*\*/,
    );
  });
});
