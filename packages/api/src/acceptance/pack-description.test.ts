import { REVIEW_NOTE_MARKER } from "@afk/shared";
import { describe, expect, it } from "vitest";
import type { AcceptancePack } from "./pack.ts";
import { renderPackSection, renderReviewNoteBody } from "./pack-description.ts";

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
      reviewUncertainties: [],
      resolvedUncertainties: [],
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
      reviewComments: [],
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
      reviewUncertainties: [],
      resolvedUncertainties: [],
      decisions: [],
      protectedPathApprovals: [],
      reviewComments: [],
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
  needsDecision: [],
  ...over,
});

describe("renderPackSection", () => {
  it("prints Chinese phrases for every finding resolution, not the stored English codes", () => {
    const withResolutions = pack();
    withResolutions.repos[0].findings = [
      {
        ticket: "T-1",
        run: "R-2",
        stage: "review",
        kind: "must-fix",
        body: "null check",
        resolution: "unhandled",
        axis: null,
      },
      {
        ticket: "T-1",
        run: "R-3",
        stage: "review",
        kind: "must-fix",
        body: "fixed already",
        resolution: "fixed",
        axis: null,
      },
      {
        ticket: "T-1",
        run: "R-3",
        stage: "review",
        kind: "suggestion",
        body: "rename x",
        resolution: "acceptance-pack",
        axis: "standards",
      },
      {
        ticket: null,
        run: "R-9",
        stage: "final-review",
        kind: "suggestion",
        body: "extract helper",
        resolution: "refactored",
        axis: null,
      },
      {
        ticket: "T-1",
        run: "R-8",
        stage: "recheck",
        kind: "must-fix",
        body: "let this Recheck stand",
        resolution: "approved",
        axis: "spec",
      },
    ];
    const { section } = renderPackSection(withResolutions, "backend", 1);
    expect(section).toContain("- [未处理] T-1 review must-fix: null check");
    expect(section).toContain(
      "- [已交给 fix 处理] T-1 review must-fix: fixed already",
    );
    expect(section).toContain(
      "- [进验收包，留给你看] T-1 review (standards) suggestion: rename x",
    );
    expect(section).toContain(
      "- [已由 Tidy 整理] spec final-review suggestion: extract helper",
    );
    expect(section).toContain(
      "- [人已批准] T-1 recheck (spec) must-fix: let this Recheck stand",
    );
    expect(section).not.toContain("[unhandled]");
    expect(section).not.toContain("[fixed]");
    expect(section).not.toContain("[acceptance-pack]");
    expect(section).not.toContain("[refactored]");
    expect(section).not.toContain("[approved]");
  });

  it("puts Recheck hits in 合并前要你定的 with their kind", () => {
    const rendered = renderPackSection(
      pack({
        needsDecision: [
          {
            kind: "recheck",
            id: "R-9",
            source: "T-1 merge-fix",
            text: "src/a.test.ts · Recheck: fix",
          },
          {
            kind: "needs-human",
            id: "R-1#0",
            source: "T-1 implement",
            text: "reload skips the filter",
          },
        ],
      }),
      "backend",
      1,
    );
    expect(rendered.section.startsWith("## 合并前要你定的\n")).toBe(true);
    expect(rendered.section).toContain(
      "[recheck] R-9 T-1 merge-fix: src/a.test.ts · Recheck: fix",
    );
  });

  it("puts needs-human and unfinished deferred at the front", () => {
    const rendered = renderPackSection(
      pack({
        needsDecision: [
          {
            kind: "needs-human",
            id: "R-1#0",
            source: "T-1 implement",
            text: "reload skips the filter",
          },
          {
            kind: "deferred",
            id: "R-1#1",
            source: "T-1 implement",
            text: "openapi extra field",
            ref: "new",
          },
        ],
      }),
      "backend",
      1,
    );
    expect(rendered.section.startsWith("## 合并前要你定的\n")).toBe(true);
    expect(rendered.section).toContain(
      "[needs-human] R-1#0 T-1 implement: reload skips the filter",
    );
    expect(rendered.section).toContain(
      "[deferred] R-1#1 T-1 implement: openapi extra field (new)",
    );
    expect(rendered.summary).toContain("## 合并前要你定的");
  });

  it("says in the planning repo's pull request that its planning docs were left out, and only there", () => {
    const waived = pack({ planningDocs: { repo: "backend", state: "waived" } });
    expect(renderPackSection(waived, "backend", 1).section).toContain(
      "**Left out**: the planning docs did not apply to the default branch",
    );
    expect(renderPackSection(waived, "frontend", 1).section).not.toContain(
      "Planning docs",
    );
    const leftBehind = pack({
      planningDocs: {
        repo: "backend",
        state: "waived",
        leftOut: ["docs/design.md", "GLOSSARY.md"],
      },
    });
    expect(renderPackSection(leftBehind, "backend", 1).section).toContain(
      "规划改动未带上：docs/design.md、GLOSSARY.md",
    );
    expect(renderPackSection(leftBehind, "frontend", 1).section).not.toContain(
      "规划改动未带上",
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
    expect(renderPackSection(unchanged, "backend", 1).section).not.toContain(
      "规划改动未带上",
    );
  });

  it("puts 人审意见 at the front of the repo section, with addressed and declined counts", () => {
    const withComments = pack();
    withComments.repos[0].reviewComments = [
      {
        displayId: "C-12",
        changeRequest: 2,
        path: "src/orders/list.ts",
        side: "new",
        lineStart: 41,
        lineEnd: 44,
        body: "empty list should return 200",
        state: "addressed",
        reply: "returns 200 and []",
      },
      {
        displayId: "C-14",
        changeRequest: 2,
        path: null,
        side: null,
        lineStart: null,
        lineEnd: null,
        body: "migrations must be repeatable",
        state: "declined",
        reply: "already uses IF NOT EXISTS",
      },
    ];
    const { section } = renderPackSection(withComments, "backend", 1);
    const repo = section.slice(section.indexOf("## backend"));
    expect(repo.indexOf("人审意见")).toBeLessThan(
      repo.indexOf("Acceptance criteria"),
    );
    expect(repo).toContain(
      "人审意见：1 条已处理，1 条没处理（C-14：already uses IF NOT EXISTS）",
    );
    expect(repo).toContain("C-12");
    expect(repo).toContain("returns 200 and []");
    expect(repo).toContain("C-14");
    expect(renderPackSection(pack(), "backend", 1).section).not.toContain(
      "人审意见",
    );
  });

  it("writes a review-note body as 处理中 while comments are submitted, then 已处理 after wrap-up", () => {
    const comments = [
      {
        displayId: "C-12",
        changeRequest: 1,
        path: "src/a.ts",
        side: "new" as const,
        lineStart: 1,
        lineEnd: 1,
        body: "empty list should return 200",
        state: "submitted" as const,
        reply: null,
      },
    ];
    const submitted = renderReviewNoteBody(comments);
    expect(submitted.startsWith(REVIEW_NOTE_MARKER)).toBe(true);
    expect(submitted).toContain("人审意见：1 条处理中");
    expect(submitted).toContain("C-12 修改要求 #1 `src/a.ts` new:1 处理中");
    expect(
      renderReviewNoteBody([
        { ...comments[0], state: "addressed", reply: "returns 200" },
      ]),
    ).toContain("人审意见：1 条已处理，0 条没处理");
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

  it("lists review uncertainties as 审查拿不准的 with the axis, and omits the group when there are none", () => {
    const withUnsure = pack();
    withUnsure.repos[0].reviewUncertainties = [
      {
        ticket: "T-1",
        run: "R-2",
        stage: "review",
        body: "the ticket does not say the date format",
        axis: "spec",
      },
    ];
    const { section } = renderPackSection(withUnsure, "backend", 1);
    expect(section).toContain("### 审查拿不准的");
    expect(section).toContain(
      "- Spec 轴 T-1 review R-2: the ticket does not say the date format",
    );
    expect(renderPackSection(pack(), "backend", 1).section).not.toContain(
      "审查拿不准的",
    );
    expect(renderPackSection(pack(), "frontend", 1).section).not.toContain(
      "审查拿不准的",
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
