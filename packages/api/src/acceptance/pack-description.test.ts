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
      decisions: [
        {
          source: "T-1 implement",
          run: "R-2",
          kind: "conflict",
          text: "ticket vs User Story 6; picked the story",
        },
        {
          source: "T-1 implement",
          run: "R-3",
          kind: "known-gap",
          text: "reload still skips the note filter",
        },
        {
          source: "T-1 implement",
          run: "R-2",
          kind: "choice",
          text: "date format",
        },
        {
          source: "T-1 gate-fix",
          run: "R-5",
          kind: "workaround",
          text: "skipped drizzle generate",
        },
      ],
      protectedPathApprovals: [],
      flakyTests: [{ name: "flakes then passes", classname: "orders" }],
      standardsSources: [
        {
          ticket: "T-1",
          run: "R-2",
          stage: "review",
          sources: ["AGENTS.md", "CONTRIBUTING.md"],
        },
      ],
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
      decisions: [],
      protectedPathApprovals: [],
      flakyTests: [],
      standardsSources: [],
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
  it("says in the planning repo's pull request that its planning docs were left out, and only there", () => {
    const waived = pack({ planningDocs: { repo: "backend", state: "waived" } });
    expect(renderPackSection(waived, "backend", 1).section).toContain(
      "**Left out**: the planning docs did not apply to the default branch",
    );
    expect(renderPackSection(waived, "frontend", 1).section).not.toContain(
      "Planning docs",
    );
    const committed = pack({
      planningDocs: { repo: "backend", state: "committed" },
    });
    expect(renderPackSection(committed, "backend", 1).section).toContain(
      "The first commit of this pull request is the planning docs",
    );
    const unchanged = pack({
      planningDocs: { repo: "backend", state: "unchanged" },
    });
    expect(renderPackSection(unchanged, "backend", 1).section).not.toContain(
      "Planning docs",
    );
  });

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

  it("says merge request on GitLab", () => {
    const gitlab = pack({
      hostKind: "gitlab",
      planningDocs: { repo: "backend", state: "committed" },
    });
    expect(renderPackSection(gitlab, "backend", 1).section).toContain(
      "The first commit of this merge request is the planning docs",
    );
    expect(renderPackSection(gitlab, "backend", 1).section).toContain(
      "Opened although the e2e before the merge requests failed",
    );
    expect(renderPackSection(gitlab, "backend", 1).summary).toContain(
      "too long for a GitLab description",
    );
  });

  it("lists unstable tests that passed on rerun, apart from findings", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    expect(section).toContain("### Unstable tests");
    expect(section).toContain("orders flakes then passes");
    expect(section.indexOf("### Findings")).toBeLessThan(
      section.indexOf("### Unstable tests"),
    );
    expect(renderPackSection(pack(), "frontend", 1).section).not.toContain(
      "Unstable tests",
    );
  });

  it("lists the standards-source files the Standards review used", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    expect(section).toContain("### Standards sources");
    expect(section).toContain("T-1 R-2 review: AGENTS.md, CONTRIBUTING.md");
    expect(renderPackSection(pack(), "frontend", 1).section).not.toContain(
      "Standards sources",
    );
  });

  it("lists conflict and known-gap under Decisions with their run, and only counts choice and workaround", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    expect(section).toContain("### Decisions");
    expect(section).toContain(
      "[conflict] T-1 implement R-2: ticket vs User Story 6; picked the story",
    );
    expect(section).toContain(
      "[known-gap] T-1 implement R-3: reload still skips the note filter",
    );
    expect(section).toContain("choice: 1, workaround: 1");
    expect(section).not.toContain("date format");
    expect(section).not.toContain("skipped drizzle generate");
    expect(section).not.toContain("Uncertainties");
    expect(renderPackSection(pack(), "frontend", 1).section).not.toContain(
      "### Decisions",
    );
  });

  it("puts waived e2e failures at the front of the integration section", () => {
    const { section } = renderPackSection(pack(), "backend", 1);
    const integration = section.slice(section.indexOf("## Integration"));
    expect(integration).toMatch(
      /Opened although the e2e before the pull requests failed:[\s\S]*\*\*T-9\*\*/,
    );
  });
});
