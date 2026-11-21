import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS_SHA, type Stage } from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  type AgentRunResult,
  classifyAgentRun,
  classifyDiagnoseRun,
  classifyLocateRun,
  classifyReviewRun,
  combineReviewRuns,
  composePrompt,
  DiagnoseOutputSchema,
  type ImplementOutput,
  ImplementOutputSchema,
  LocateOutputSchema,
  OVERLAY_FILE,
  overlaySkillsSha,
  PROMPT_DIR,
  PROMPTS,
  promptFor,
  RESULT_REPAIR_WALL_CLOCK_MS,
  type ReviewOutput,
  ReviewOutputSchema,
  reviewFindings,
  reviewOutputSchemaFor,
  reviewSources,
  StandardsReviewOutputSchema,
  TidyOutputSchema,
  writePrompt,
} from "./agent.ts";
import { renderContext } from "./context.ts";
import { git, gitOut } from "./exec.ts";
import { bundleFor } from "./fixtures.ts";
import { SANDBOX_SKILLS_DIR } from "./sandcastle.ts";
import { FakeAgentRunner, type FakeAgentStep } from "./testing/fakes.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo | undefined;
const dirs: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DONE = {
  status: "done" as const,
  summary: "did it",
  acceptance: { "returns csv": ["csv test"] },
  decisions: [],
};

describe("the structured outputs", () => {
  it("accepts done, and cannot-proceed only with a known blockedReason and a detail", () => {
    expect(ImplementOutputSchema.safeParse(DONE).success).toBe(true);
    const stuck = {
      status: "cannot-proceed",
      blockedReason: "contract-change-needed",
      detail: "openapi.yaml needs a note field",
    };
    expect(ImplementOutputSchema.safeParse(stuck).success).toBe(true);
    expect(
      ImplementOutputSchema.safeParse({ ...stuck, blockedReason: "tired" })
        .success,
    ).toBe(false);
    expect(
      ImplementOutputSchema.safeParse({ ...stuck, detail: "" }).success,
    ).toBe(false);
    expect(
      ImplementOutputSchema.safeParse({
        status: "cannot-proceed",
        blockedReason: "agent-gave-up",
      }).success,
    ).toBe(false);
    expect(
      ImplementOutputSchema.safeParse({
        status: "cannot-proceed",
        reason: "old style",
      }).success,
    ).toBe(false);
  });

  it("accepts a tidy result with tidied indices, and rejects done without them", () => {
    expect(
      TidyOutputSchema.safeParse({
        status: "done",
        summary: "extracted a helper",
        tidied: [0],
        skipped: [{ index: 1, reason: "would change tests" }],
      }).success,
    ).toBe(true);
    expect(
      TidyOutputSchema.safeParse({ status: "done", summary: "x" }).success,
    ).toBe(false);
    expect(
      TidyOutputSchema.safeParse({
        status: "cannot-proceed",
        blockedReason: "agent-gave-up",
        detail: "nothing safe to tidy",
      }).success,
    ).toBe(true);
  });

  it("accepts typed decisions on implement, maps a legacy string array to choice, and rejects an unknown kind", () => {
    const done = {
      status: "done" as const,
      summary: "did it",
      acceptance: { "returns csv": ["csv test"] },
    };
    expect(
      ImplementOutputSchema.parse({
        ...done,
        decisions: [
          { kind: "choice", text: "named it export" },
          {
            kind: "conflict",
            text: "ticket said one file; tdd needed a test file; added the test",
          },
          { kind: "known-gap", text: "list reload skips the note filter" },
          { kind: "deferred", text: "openapi extra field", ref: "new" },
          { kind: "workaround", text: "skipped drizzle generate" },
        ],
      }).decisions,
    ).toHaveLength(5);
    expect(
      ImplementOutputSchema.parse({
        ...done,
        uncertainties: ["picked ISO dates"],
      }).decisions,
    ).toEqual([{ kind: "choice", text: "picked ISO dates" }]);
    expect(
      ImplementOutputSchema.safeParse({
        ...done,
        decisions: [{ kind: "question", text: "ask someone" }],
      }).success,
    ).toBe(false);
  });

  it("normalizes Run 577's workaround that carried a ref so the implement schema accepts it", () => {
    const parsed = ImplementOutputSchema.parse({
      status: "done",
      summary: "did it",
      acceptance: { "returns csv": ["csv test"] },
      decisions: [
        { kind: "choice", text: "named it export" },
        {
          kind: "conflict",
          text: "ticket said one file; tdd needed a test file; added the test",
        },
        { kind: "known-gap", text: "list reload skips the note filter" },
        { kind: "deferred", text: "openapi extra field", ref: "new" },
        {
          kind: "workaround",
          text: "skipped drizzle generate",
          ref: "91813f8",
        },
      ],
    });
    expect(parsed.decisions[4]).toEqual({
      kind: "workaround",
      text: "skipped drizzle generate（ref: 91813f8）",
    });
  });

  it("accepts a review that omits suggestions and uncertainties as empty arrays", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
    });
    expect(parsed.suggestions).toEqual([]);
    expect(parsed.uncertainties).toEqual([]);
  });

  it("accepts optional uncertaintyRulings on a review and still accepts a result without them", () => {
    const base = {
      verdict: "pass" as const,
      mustFix: [],
      suggestions: [],
      uncertainties: [],
    };
    expect(ReviewOutputSchema.parse(base).uncertaintyRulings).toBeUndefined();
    expect(
      ReviewOutputSchema.parse({
        ...base,
        uncertaintyRulings: [
          { id: "F-1", verdict: "resolved" },
          { id: "F-2", verdict: "open" },
        ],
      }).uncertaintyRulings,
    ).toEqual([
      { id: "F-1", verdict: "resolved" },
      { id: "F-2", verdict: "open" },
    ]);
    expect(
      ReviewOutputSchema.safeParse({
        ...base,
        uncertaintyRulings: [{ id: "F-1", verdict: "fixed" }],
      }).success,
    ).toBe(false);
  });

  it("keeps a deferred decision's ref instead of folding it into text", () => {
    expect(
      ImplementOutputSchema.parse({
        status: "done",
        summary: "did it",
        acceptance: { "returns csv": ["csv test"] },
        decisions: [
          { kind: "deferred", text: "openapi extra field", ref: "T-4" },
        ],
      }).decisions,
    ).toEqual([{ kind: "deferred", text: "openapi extra field", ref: "T-4" }]);
  });

  it("still rejects a must-fix item that omits file or problem", () => {
    const base = {
      verdict: "fix" as const,
      suggestions: [],
      uncertainties: [],
    };
    expect(
      ReviewOutputSchema.safeParse({
        ...base,
        mustFix: [{ problem: "bug" }],
      }).success,
    ).toBe(false);
    expect(
      ReviewOutputSchema.safeParse({
        ...base,
        mustFix: [{ file: "a.ts" }],
      }).success,
    ).toBe(false);
  });

  it("still rejects a verdict that is not pass or fix", () => {
    expect(
      ReviewOutputSchema.safeParse({
        verdict: "maybe",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      }).success,
    ).toBe(false);
  });

  it("a review with must-fix items cannot pass", () => {
    const review = {
      verdict: "pass",
      mustFix: [{ file: "a.ts", problem: "bug" }],
      suggestions: [],
      uncertainties: [],
    };
    expect(ReviewOutputSchema.safeParse(review).success).toBe(false);
    expect(
      ReviewOutputSchema.safeParse({ ...review, verdict: "fix" }).success,
    ).toBe(true);
    expect(
      ReviewOutputSchema.safeParse({ ...review, mustFix: [] }).success,
    ).toBe(true);
  });

  it("reads the standards-source files from a review result", () => {
    expect(
      reviewSources({
        verdict: "fix",
        mustFix: [{ file: "src/a.ts", problem: "default export" }],
        suggestions: [],
        sources: ["AGENTS.md", "CONTRIBUTING.md"],
        uncertainties: [],
      }),
    ).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
    expect(
      reviewSources({
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      }),
    ).toBeUndefined();
    expect(reviewSources(undefined)).toBeUndefined();
    expect(reviewSources({ sources: [] })).toBeUndefined();
    expect(reviewSources({ sources: [1] })).toBeUndefined();
  });

  it("a Standards review without sources, or without AGENTS.md, is not a usable result", () => {
    const review = {
      verdict: "pass",
      mustFix: [],
      suggestions: [],
      uncertainties: [],
    };
    expect(ReviewOutputSchema.safeParse(review).success).toBe(true);
    expect(StandardsReviewOutputSchema.safeParse(review).success).toBe(false);
    expect(
      StandardsReviewOutputSchema.safeParse({
        ...review,
        sources: ["CONTRIBUTING.md"],
      }).success,
    ).toBe(false);
    expect(
      StandardsReviewOutputSchema.safeParse({
        ...review,
        sources: ["AGENTS.md", "CONTRIBUTING.md"],
      }).success,
    ).toBe(true);
    expect(reviewOutputSchemaFor("standards")).toBe(
      StandardsReviewOutputSchema,
    );
    expect(reviewOutputSchemaFor("spec")).toBe(ReviewOutputSchema);
  });
});

const result = <T>(over: Partial<AgentRunResult<T>>): AgentRunResult<T> => ({
  commits: [],
  durationMs: 1,
  ...over,
});

describe("classifying an implement or fix run", () => {
  const cases: [string, AgentRunResult<ImplementOutput>, string][] = [
    ["done with a commit", result({ output: DONE, commits: ["c1"] }), "done"],
    ["done without a commit", result({ output: DONE }), "no-commits"],
    [
      "cannot-proceed: gave up",
      result({
        output: {
          status: "cannot-proceed",
          blockedReason: "agent-gave-up",
          detail: "d",
          summary: "",
          acceptance: {},
          decisions: [],
        },
      }),
      "agent-gave-up",
    ],
    [
      "cannot-proceed: contract change",
      result({
        output: {
          status: "cannot-proceed",
          blockedReason: "contract-change-needed",
          detail: "d",
          summary: "",
          acceptance: {},
          decisions: [],
        },
      }),
      "contract-change-needed",
    ],
    [
      "unusable output",
      result({ error: "bad json", errorKind: "invalid-output" }),
      "invalid-output",
    ],
    ["no output at all", result({}), "invalid-output"],
    ["timeout", result({ error: "idle", errorKind: "timeout" }), "timeout"],
  ];
  it.each(cases)("%s -> %s", (_name, run, outcome) => {
    expect(classifyAgentRun(run)).toMatchObject({ kind: "outcome", outcome });
  });

  it("keeps the agent's detail for the blocked brief", () => {
    const run = result<ImplementOutput>({
      output: {
        status: "cannot-proceed",
        blockedReason: "agent-gave-up",
        detail: "needs a decision",
        summary: "",
        acceptance: {},
        decisions: [],
      },
    });
    expect(classifyAgentRun(run)).toEqual({
      kind: "outcome",
      outcome: "agent-gave-up",
      detail: "needs a decision",
    });
  });

  it("an error that is neither bad output nor a timeout is the sandbox's fault, not the ticket's", () => {
    expect(
      classifyAgentRun(result({ error: "docker died", errorKind: "other" })),
    ).toEqual({
      kind: "infrastructure-failure",
      error: "docker died",
    });
  });
});

describe("classifying a review run", () => {
  const output = (verdict: "pass" | "fix"): ReviewOutput => ({
    verdict,
    mustFix:
      verdict === "fix"
        ? [{ file: "a.ts", line: 3, problem: "null check" }]
        : [],
    suggestions: ["rename x"],
    scopeCreep: [],
    uncertainties: [],
  });

  it("takes the verdict", () => {
    expect(classifyReviewRun(result({ output: output("pass") }))).toMatchObject(
      { outcome: "pass" },
    );
    expect(classifyReviewRun(result({ output: output("fix") }))).toMatchObject({
      outcome: "fix",
    });
  });

  it("a known-gap without a ruling is invalid-output", () => {
    expect(
      classifyReviewRun(result({ output: output("pass") }), [
        { id: "R-1#0", kind: "known-gap" },
      ]),
    ).toMatchObject({ outcome: "invalid-output" });
    expect(
      classifyReviewRun(
        result({
          output: {
            ...output("pass"),
            rulings: [{ id: "R-1#0", verdict: "accepted" }],
          },
        }),
        [{ id: "R-1#0", kind: "known-gap" }],
      ),
    ).toMatchObject({ outcome: "pass" });
  });

  it("a review needs no commit", () => {
    expect(
      classifyReviewRun(result({ output: output("pass"), commits: [] })),
    ).toMatchObject({ outcome: "pass" });
  });

  it("maps failures like the other runs", () => {
    expect(
      classifyReviewRun(result({ error: "x", errorKind: "invalid-output" })),
    ).toMatchObject({ outcome: "invalid-output" });
    expect(
      classifyReviewRun(result({ error: "x", errorKind: "timeout" })),
    ).toMatchObject({ outcome: "timeout" });
    expect(classifyReviewRun(result({}))).toMatchObject({
      outcome: "invalid-output",
    });
    expect(
      classifyReviewRun(result({ error: "x", errorKind: "other" })),
    ).toMatchObject({ kind: "infrastructure-failure" });
  });

  it("turns must-fix items, suggestions and scope creep into findings", () => {
    expect(reviewFindings(output("fix"))).toEqual([
      { kind: "must-fix", body: "a.ts:3 null check" },
      { kind: "suggestion", body: "rename x" },
    ]);
    expect(
      reviewFindings({ ...output("pass"), scopeCreep: ["an extra flag"] }),
    ).toEqual([
      { kind: "suggestion", body: "rename x" },
      { kind: "scope-creep", body: "an extra flag" },
    ]);
    expect(
      reviewFindings({
        ...output("fix"),
        mustFix: [{ file: "b.ts", problem: "p" }],
        suggestions: [],
      }),
    ).toEqual([{ kind: "must-fix", body: "b.ts p" }]);
  });

  it("turns uncertainties into findings that go to the acceptance pack", () => {
    expect(
      reviewFindings({
        ...output("pass"),
        uncertainties: ["the review could not run the export"],
      }),
    ).toEqual([
      { kind: "suggestion", body: "rename x" },
      {
        kind: "uncertainty",
        body: "the review could not run the export",
      },
    ]);
  });

  it("accepts a review suggestion written as { file, line, problem } and stores the finding as file:line problem", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
      suggestions: [{ file: "a.ts", line: 3, problem: "x" }],
      uncertainties: [],
    });
    expect(reviewFindings(parsed)).toEqual([
      { kind: "suggestion", body: "a.ts:3 x" },
    ]);
  });

  it("accepts a recheck result whose suggestions and scopeCreep are objects and keeps the verdict", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
      suggestions: [{ file: "a.ts", line: 338, problem: "weaker" }],
      scopeCreep: [{ file: "b.tsx", line: 940, problem: "extra" }],
      uncertainties: [],
    });
    expect(classifyReviewRun(result({ output: parsed }))).toMatchObject({
      outcome: "pass",
    });
    expect(reviewFindings(parsed)).toEqual([
      { kind: "suggestion", body: "a.ts:338 weaker" },
      { kind: "scope-creep", body: "b.tsx:940 extra" },
    ]);
    const fix = ReviewOutputSchema.parse({
      verdict: "fix",
      mustFix: [{ file: "c.ts", problem: "changed" }],
      suggestions: [{ file: "a.ts", line: 338, problem: "weaker" }],
      scopeCreep: [{ file: "b.tsx", line: 940, problem: "extra" }],
      uncertainties: [],
    });
    expect(classifyReviewRun(result({ output: fix }))).toMatchObject({
      outcome: "fix",
    });
  });

  it("accepts a final-review uncertainty written as an object and stores the converted sentence for the acceptance pack", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
      suggestions: [],
      uncertainties: [{ file: "a.ts", line: 1, problem: "could not tell" }],
    });
    expect(reviewFindings(parsed)).toEqual([
      { kind: "uncertainty", body: "a.ts:1 could not tell" },
    ]);
  });

  it("keeps all-string suggestions, scopeCreep and uncertainties as they are", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
      suggestions: ["rename x"],
      scopeCreep: ["an extra flag"],
      uncertainties: ["the review could not run the export"],
    });
    expect(reviewFindings(parsed)).toEqual([
      { kind: "suggestion", body: "rename x" },
      { kind: "scope-creep", body: "an extra flag" },
      { kind: "uncertainty", body: "the review could not run the export" },
    ]);
  });

  it("turns an object finding with no line into file problem, like must-fix", () => {
    const parsed = ReviewOutputSchema.parse({
      verdict: "pass",
      mustFix: [],
      suggestions: [{ file: "a.ts", problem: "x" }],
      uncertainties: [],
    });
    expect(reviewFindings(parsed)).toEqual([
      { kind: "suggestion", body: "a.ts x" },
    ]);
  });
});

describe("the two axes of a review", () => {
  const out = (
    verdict: "pass" | "fix",
    over: Partial<ReviewOutput> = {},
  ): ReviewOutput => ({
    verdict,
    mustFix: verdict === "fix" ? [{ file: "a.ts", problem: "p" }] : [],
    suggestions: [],
    scopeCreep: [],
    uncertainties: [],
    ...over,
  });
  const ran = (output?: ReviewOutput, extra: Record<string, unknown> = {}) =>
    ({
      ...(output ? { output } : {}),
      commits: [],
      durationMs: 1,
      ...extra,
    }) as AgentRunResult<ReviewOutput>;

  it("is a pass only when both axes pass, and a fix when either has a must-fix", () => {
    expect(
      combineReviewRuns({
        standards: ran(out("pass")),
        spec: ran(out("pass")),
      }).classification,
    ).toEqual({ kind: "outcome", outcome: "pass" });
    for (const [standards, spec] of [
      [out("fix"), out("pass")],
      [out("pass"), out("fix")],
      [out("fix"), out("fix")],
    ] as const) {
      expect(
        combineReviewRuns({ standards: ran(standards), spec: ran(spec) })
          .classification,
      ).toEqual({ kind: "outcome", outcome: "fix" });
    }
  });

  it("hands a review-fix every must-fix of both axes, each with its axis, and the two results side by side", () => {
    const standards = out("fix", {
      mustFix: [{ file: "s.ts", line: 1, problem: "style" }],
    });
    const spec = out("fix", {
      mustFix: [{ file: "t.ts", problem: "missing" }],
      scopeCreep: ["extra"],
    });
    const { combined } = combineReviewRuns({
      standards: ran(standards),
      spec: ran(spec),
    });
    expect(combined).toEqual({
      verdict: "fix",
      mustFix: [
        { axis: "standards", file: "s.ts", line: 1, problem: "style" },
        { axis: "spec", file: "t.ts", problem: "missing" },
      ],
      standards,
      spec,
    });
    const withSources = out("fix", {
      sources: ["AGENTS.md", "CONTRIBUTING.md"],
    });
    expect(
      combineReviewRuns({
        standards: ran(withSources),
        spec: ran(out("pass")),
      }).combined?.standards?.sources,
    ).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
  });

  it("takes the failure of either axis as the outcome of the whole review, Standards first", () => {
    const bad = ran(undefined, { error: "junk", errorKind: "invalid-output" });
    const slow = ran(undefined, { error: "idle", errorKind: "timeout" });
    expect(
      combineReviewRuns({ standards: ran(out("pass")), spec: bad })
        .classification,
    ).toMatchObject({ outcome: "invalid-output" });
    expect(
      combineReviewRuns({ standards: slow, spec: bad }).classification,
    ).toMatchObject({ outcome: "timeout" });
    expect(
      combineReviewRuns({
        standards: ran(out("fix")),
        spec: ran(undefined, { error: "x", errorKind: "other" }),
      }).classification,
    ).toMatchObject({ kind: "infrastructure-failure" });
    expect(
      combineReviewRuns({ standards: slow, spec: ran(out("pass")) }).combined,
    ).toBeUndefined();
  });

  it("combines a spec-only ticket review without a Standards result", () => {
    const spec = out("fix", {
      mustFix: [{ file: "t.ts", problem: "missing" }],
    });
    const { classification, combined } = combineReviewRuns({ spec: ran(spec) });
    expect(classification).toEqual({ kind: "outcome", outcome: "fix" });
    expect(combined).toEqual({
      verdict: "fix",
      mustFix: [{ axis: "spec", file: "t.ts", problem: "missing" }],
      spec,
    });
    expect(combined).not.toHaveProperty("standards");
  });

  it("points each axis at its own prompt: the ticket and the contract for Spec, with spec.md as background only", () => {
    expect(promptFor("review", { axis: "standards" })).toBe(
      PROMPTS.reviewStandards,
    );
    expect(promptFor("review", { axis: "spec" })).toBe(PROMPTS.reviewSpec);
    expect(promptFor("final-review", { axis: "spec" })).toBe(
      PROMPTS.finalReviewSpec,
    );
    const spec = readFileSync(PROMPTS.reviewSpec, "utf8");
    expect(spec).toContain("/context/ticket.md");
    expect(spec).toContain("/context/contract/");
    expect(spec).toMatch(/spec\.md` 的 User Story 是背景/);
    expect(spec).toContain("这张票负责的 User Story");
    expect(spec).toMatch(/「这张票负责的 User Story」一节的原文/);
    expect(spec).toMatch(/也是对照物/);
    expect(spec).toContain("每条验收标准都有测试");
    const finalSpec = readFileSync(PROMPTS.finalReviewSpec, "utf8");
    expect(finalSpec).toContain("/context/spec.md");
    expect(finalSpec).toContain("/context/tickets.md");
    expect(finalSpec).toContain("重点看票与票之间");
    for (const file of [PROMPTS.reviewSpec, PROMPTS.reviewStandards]) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("按第 4 步给");
      expect(prompt).toContain("不要再开子 agent");
      expect(prompt).toContain("git diff <baseSha>...HEAD");
    }
    // overlay norms stay in the list; the agent finds the rest (skill step 3)
    expect(readFileSync(PROMPTS.reviewStandards, "utf8")).toContain(
      "不许删除或跳过测试",
    );
  });

  it("tells the Spec axis that spec-wide rules are counterparts for the code this ticket touched, and gaps in another ticket's modules go to uncertainties not mustFix", () => {
    const spec = readFileSync(PROMPTS.reviewSpec, "utf8");
    expect(spec).toContain("写给整个需求");
    expect(spec).toContain("不属于某一条 User Story");
    expect(spec).toContain("Implementation Decisions");
    expect(spec).toMatch(/同样是对照物/);
    expect(spec).toContain("/context/tickets.md");
    expect(spec).toMatch(/不判 `mustFix`/);
    expect(spec).toContain("uncertainties");
    expect(spec).toContain("modules");
    expect(spec).toContain("deferred");
  });

  it("treats What to build and the ticket's User Story as equal counterparts to the acceptance criteria, and mustFix when unsure", () => {
    const spec = readFileSync(PROMPTS.reviewSpec, "utf8");
    expect(spec).toContain("同等的对照物");
    expect(spec).toContain("验收标准没写");
    expect(spec).toMatch(/拿不准时判 `mustFix`/);
    expect(spec).toContain("uncertainties");
  });

  it("treats the spec's User Story and each ticket's What to build as equal counterparts to the acceptance criteria, and mustFix when unsure", () => {
    const finalSpec = readFileSync(PROMPTS.finalReviewSpec, "utf8");
    expect(finalSpec).toContain("User Story");
    expect(finalSpec).toContain("What to build");
    expect(finalSpec).toContain("同等的对照物");
    expect(finalSpec).toContain("验收标准没写");
    expect(finalSpec).toMatch(/拿不准时判 `mustFix`/);
    expect(finalSpec).toContain("uncertainties");
  });

  it("tells the wrap-up Spec axis to rule on each ticket-review uncertainty, and that a missing ruling is open not invalid", () => {
    const prompt = readFileSync(PROMPTS.finalReviewSpec, "utf8");
    expect(prompt).toContain("/context/uncertainties.json");
    expect(prompt).toContain("uncertaintyRulings");
    expect(prompt).toContain("resolved");
    expect(prompt).toContain("open");
    const heading = prompt.indexOf("## 结果");
    expect(heading).toBeGreaterThanOrEqual(0);
    const result = prompt.slice(heading);
    expect(result).toContain("`uncertaintyRulings`");
    expect(result).toMatch(/缺了.*当 `open`/);
    expect(result).toContain("不判结果无效");
  });

  it("has the Standards axis find standards sources itself and name them in sources", () => {
    for (const file of [
      PROMPTS.reviewStandards,
      PROMPTS.finalReviewStandards,
    ]) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("按 skill 第 3 步");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain("一定在列");
      expect(prompt).toContain("sources");
      expect(prompt).toContain("你找到的规范文件");
      expect(prompt).not.toMatch(/第 1–3 步已经替你做完了/);
      expect(prompt).not.toContain("（`AGENTS.md` 或覆盖层里写明的规范）");
    }
    expect(readFileSync(PROMPTS.reviewSpec, "utf8")).toContain(
      "第 1–3 步已经替你做完了",
    );
  });
});

describe("classifyDiagnoseRun", () => {
  const run = (output: unknown, extra: Record<string, unknown> = {}) =>
    classifyDiagnoseRun({
      output: output as never,
      commits: [],
      durationMs: 1,
      ...extra,
    });
  const fail = (failingRepo: string | null) => ({
    result: "fail",
    failingRepo,
    evidence: "404 on /orders/1/export",
    failingTests: ["exports"],
  });

  it("is diagnosed when a repo is named", () => {
    expect(run(fail("backend"))).toEqual({
      kind: "outcome",
      outcome: "diagnosed",
    });
  });

  it("is unknown-side when the agent says unknown, names nothing, or finds the e2e passing", () => {
    for (const output of [
      fail("unknown"),
      fail(null),
      { ...fail(null), result: "pass" },
    ])
      expect(run(output)).toMatchObject({
        kind: "outcome",
        outcome: "unknown-side",
      });
  });

  it("is invalid output without a result, and a timeout when the agent ran out of time", () => {
    expect(run(undefined)).toMatchObject({ outcome: "invalid-output" });
    expect(
      run(undefined, { error: "idle", errorKind: "timeout" }),
    ).toMatchObject({ outcome: "timeout" });
  });

  it("asks for the structured output the schema accepts, from a prompt that changes nothing", () => {
    expect(DiagnoseOutputSchema.safeParse(fail("backend")).success).toBe(true);
    expect(DiagnoseOutputSchema.safeParse({ result: "fail" }).success).toBe(
      false,
    );
    expect(promptFor("diagnose")).toBe(PROMPTS.diagnose);
    const prompt = readFileSync(PROMPTS.diagnose, "utf8");
    for (const word of [
      "failingRepo",
      "evidence",
      "failingTests",
      "unknown",
      "<result>",
      "/context/failure/gate.log",
      "不要提交",
    ])
      expect(prompt).toContain(word);
  });
});

describe("a locate run", () => {
  it("accepts one repo name and rejects a list of repos", () => {
    const found = {
      result: "found" as const,
      repo: "backend",
      files: ["src/orders.ts"],
      evidence: "exportOrders throws",
      reproduction: "POST /orders/export",
    };
    expect(LocateOutputSchema.safeParse(found).success).toBe(true);
    expect(
      LocateOutputSchema.safeParse({ ...found, repo: ["backend", "frontend"] })
        .success,
    ).toBe(false);
    expect(
      classifyLocateRun({
        output: found,
        commits: [],
        durationMs: 1,
      }),
    ).toEqual({ kind: "outcome", outcome: "found" });
    expect(
      classifyLocateRun({
        output: {
          result: "unlocated",
          repo: "",
          files: [],
          evidence: "no match",
          reproduction: "",
        },
        commits: [],
        durationMs: 1,
      }),
    ).toEqual({ kind: "outcome", outcome: "unlocated" });
  });

  it("asks for the structured output from a prompt that changes nothing", () => {
    expect(promptFor("locate-bug")).toBe(PROMPTS.locateBug);
    const prompt = readFileSync(PROMPTS.locateBug, "utf8");
    for (const word of [
      "repo",
      "files",
      "evidence",
      "reproduction",
      "unlocated",
      "<result>",
      "不要提交",
      "一个仓库名",
    ])
      expect(prompt).toContain(word);
  });
});

const STAGES_WITH_PROMPTS = [
  "implement",
  "review",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "update-branch",
  "final-review",
  "final-fix",
  "final-tidy",
  "recheck",
  "diagnose",
  "locate-bug",
] as const;

function resultExamples(prompt: string): unknown[] {
  return [...prompt.matchAll(/<result>\s*([\s\S]*?)\s*<\/result>/g)].flatMap(
    (match) => {
      const body = match[1].trim();
      if (!body.startsWith("{")) return [];
      return [JSON.parse(body) as unknown];
    },
  );
}

describe("the prompts", () => {
  const whole = (stage: (typeof STAGES_WITH_PROMPTS)[number]) =>
    composePrompt(promptFor(stage));

  it("exist, and ask for the structured output the schemas accept", () => {
    for (const path of [OVERLAY_FILE, ...Object.values(PROMPTS)])
      expect(existsSync(path)).toBe(true);
    for (const stage of [
      "implement",
      "gate-fix",
      "review-fix",
      "merge-fix",
      "update-branch",
      "final-fix",
      "final-tidy",
    ] as const) {
      const prompt = whole(stage);
      expect(prompt).toContain("cannot-proceed");
      expect(prompt).toContain("blockedReason");
      expect(prompt).toContain("detail");
      expect(prompt).toContain("agent-gave-up");
      expect(prompt).toContain("contract-change-needed");
      expect(prompt).toContain("<result>");
      expect(prompt).toContain("decisions");
    }
    for (const stage of ["review", "final-review"] as const) {
      expect(whole(stage)).toContain("verdict");
      expect(whole(stage)).toContain("mustFix");
      expect(whole(stage)).toContain("sources");
    }
    expect(whole("recheck")).toContain("verdict");
    expect(whole("recheck")).toContain("mustFix");
    expect(whole("recheck")).toContain("/context/recheck.json");
    expect(whole("recheck")).toContain("不要求 Ruling");
    expect(whole("recheck")).toContain("不要用 `git diff <baseSha>...HEAD`");
  });

  it("is the overlay and then the stage's own prompt, for every stage", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8").trimEnd();
    for (const stage of STAGES_WITH_PROMPTS) {
      const prompt = whole(stage);
      expect(prompt.startsWith(overlay)).toBe(true);
      expect(prompt.endsWith(readFileSync(promptFor(stage), "utf8"))).toBe(
        true,
      );
    }
    const dir = mkdtempSync(join(tmpdir(), "afk-prompt-"));
    dirs.push(dir);
    const written = writePrompt(dir, PROMPTS.reviewStandards);
    expect(readFileSync(written.promptFile, "utf8")).toBe(written.prompt);
    expect(written.prompt).toBe(composePrompt(PROMPTS.reviewStandards));
  });

  it("never says red, green, refactor: the loop is red → green only", () => {
    for (const stage of STAGES_WITH_PROMPTS)
      expect(whole(stage)).not.toMatch(/红 → 绿 → 重构|red.green.refactor/i);
    expect(whole("implement")).toContain("只做红 → 绿");
  });

  it("tells the agent that /context is the tracker, and answers the questions the skills ask", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    for (const word of [
      "没有人会回答你",
      "/context 就是 tracker",
      "docs/agents/issue-tracker.md",
      "plat",
      "setup-matt-pocock-skills",
      "reference 不明确就问",
      "seams",
      "baseSha",
      "git diff <baseSha>...HEAD",
      "spec 在哪",
      "uncertainties",
      "decisions",
      "cannot-proceed",
      "不要 push",
      "保护路径",
      "/context/domain/",
      "/context/note.md",
      "/context/decisions.json",
      "推翻",
      "conflict",
      "不当成改票",
      "单个测试文件怎么跑看仓库的 `AGENTS.md`",
    ])
      expect(overlay).toContain(word);
  });

  it("tells the rendered implement prompt, including the overlay, what /refs/<名字>/ is and to record a known-gap when it is missing", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const prompt = composePrompt(promptFor("implement"));
    expect(prompt.startsWith(overlay.trimEnd())).toBe(true);
    expect(overlay).toContain("/refs/<名字>/");
    expect(overlay).toContain("只读参考仓库快照");
    expect(overlay).toContain("与某系统一致");
    expect(overlay).toContain("跟随某仓库");
    expect(overlay).toContain("known-gap");
    expect(overlay).toContain("查过什么");
    expect(prompt).toContain("/refs/<名字>/");
    expect(prompt).toContain("只读参考仓库快照");
    expect(prompt).toContain("查过什么");
  });

  it("tells review that conservative means must-fix, and that a new test passing first time did not test new behaviour", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    expect(overlaySkillsSha(overlay)).toBe(SKILLS_SHA);
    expect(overlay).toMatch(/审查阶段的「保守」就是判必须修/);
    expect(overlay).toContain("新测试第一次跑就通过");
    expect(overlay).toContain("没测到新行为");
    expect(overlay).toContain(
      "有意补的回归测试，在 `decisions` 里记一条 `choice`",
    );
  });

  it("gives conflict examples and the three cannot-proceed cases", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const section = overlay.slice(
      overlay.indexOf("## 没有人回答你"),
      overlay.indexOf("## /context 就是 tracker"),
    );
    expect(section).toContain("conflict");
    expect(section).toContain("状态码");
    expect(section).toContain("User Story");
    expect(section).toContain("tdd");
    expect(section).toContain("known-gap");
    expect(section).toContain("cannot-proceed");
    expect(section).toContain("缺做下去必需的东西");
    expect(section).toContain("没批准的保护路径");
    expect(section).toContain("契约非改不可");
  });

  it("documents the result checker command and its sandbox path", () => {
    const design = readFileSync(
      join(PROMPT_DIR, "../../../docs/design.md"),
      "utf8",
    );
    expect(design).toContain("/home/agent/afk/check-result.mjs");
    expect(design).toContain("node /home/agent/afk/check-result.mjs");
  });

  it("documents that ticket stages also get /context/tickets.md", () => {
    const design = readFileSync(
      join(PROMPT_DIR, "../../../docs/design.md"),
      "utf8",
    );
    expect(design).toContain("`/context/tickets.md`");
    expect(design).toMatch(/票的阶段也有 `\/context\/tickets\.md`/);
    expect(design).toMatch(/票的阶段、收尾阶段/);
  });

  it("documents resolved findings and the folded 已解决的疑点 list on the acceptance pack", () => {
    const design = readFileSync(
      join(PROMPT_DIR, "../../../docs/design.md"),
      "utf8",
    );
    expect(design).toContain("审查确认已解决");
    expect(design).toContain("resolved");
    expect(design).toContain("已解决的疑点");
  });

  it("tells the overlay to write the result file, self-check, fix until it passes, then output it", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const section = overlay.slice(overlay.indexOf("## 结果"));
    expect(section).toContain("/tmp/afk-result.json");
    expect(section).toContain("node /home/agent/afk/check-result.mjs");
    expect(section).toContain("/context/run.json");
    expect(section).toContain("改到通过");
    expect(section).toContain("<result>");
  });

  it("tells the overlay that ref is only for deferred, and examples of other kinds omit it", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const section = overlay.slice(
      overlay.indexOf("## 没有人回答你"),
      overlay.indexOf("## /context 就是 tracker"),
    );
    expect(section).toContain("`{ kind, text }`");
    expect(section).not.toContain("`{ kind, text, ref? }`");
    expect(section).toContain("只有 `kind` 是 `deferred` 时才带 `ref`");
    for (const file of readdirSync(PROMPT_DIR).filter((name) =>
      name.endsWith(".md"),
    )) {
      const examples = resultExamples(
        readFileSync(join(PROMPT_DIR, file), "utf8"),
      );
      for (const example of examples) {
        if (!example || typeof example !== "object" || Array.isArray(example))
          continue;
        const decisions = (example as { decisions?: unknown }).decisions;
        if (!Array.isArray(decisions)) continue;
        for (const item of decisions) {
          if (!item || typeof item !== "object" || Array.isArray(item))
            continue;
          const decision = item as { kind?: unknown; ref?: unknown };
          if (decision.kind !== "deferred")
            expect(decision, file).not.toHaveProperty("ref");
        }
      }
    }
  });

  it("tells the agent to write long gate and full-suite output to a file instead of reading it all", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const bounds = overlay.slice(overlay.indexOf("## 做事的边界"));
    expect(bounds).toContain("/context/run.json");
    expect(bounds).toContain("`gate`");
    expect(bounds).toContain("全量测试");
    expect(bounds).toContain("写进文件");
    expect(bounds).toContain("退出码");
    expect(bounds).toContain("失败的部分");
    expect(bounds).toContain("最后几十行");
    expect(bounds).toContain("单个测试文件");
  });

  it("tells the agent to cap waiting on background commands, check processes, and end leftovers", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    const bounds = overlay.slice(overlay.indexOf("## 做事的边界"));
    expect(bounds).toContain("等后台命令");
    expect(bounds).toContain("上限");
    expect(bounds).toContain("正常耗时");
    expect(bounds).toContain("先查进程");
    expect(bounds).toContain("不要再等同一个条件");
    expect(bounds).toContain("自己之前启动");
    expect(bounds).toContain("先结束掉");
    expect(bounds).toContain("重跑还是放弃");
  });

  it("records Run 654's idle wait in the optimization plan and how later runs should be compared", () => {
    const plan = readFileSync(
      join(PROMPT_DIR, "../../../docs/optimization-plan.md"),
      "utf8",
    );
    expect(plan).toContain("654");
    expect(plan).toContain("29 分钟");
    expect(plan).toContain("6.5 分钟");
    expect(plan).toContain("TEST_EXIT=");
    expect(plan).toContain("空等时长");
    expect(plan).toContain("同类 Run");
  });

  it("has afk-setup write how to run a single test file into AGENTS.md", () => {
    const skill = readFileSync(
      join(PROMPT_DIR, "../../../skills/afk-setup/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/AGENTS\.md[\s\S]*how to run a single test file/);
  });

  it("has afk-setup list the repo's existing standards documents in AGENTS.md", () => {
    const skill = readFileSync(
      join(PROMPT_DIR, "../../../skills/afk-setup/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(
      /\*\*AGENTS\.md\*\*:[\s\S]*CONTRIBUTING\.md[\s\S]*docs\//,
    );
  });

  it("is written for the skills SHA the platform pins, which the mounted skills were copied at", () => {
    const overlay = readFileSync(OVERLAY_FILE, "utf8");
    expect(overlaySkillsSha(overlay)).toBe(SKILLS_SHA);
    expect(
      readFileSync(join(SANDBOX_SKILLS_DIR, "VENDORED.md"), "utf8"),
    ).toContain(SKILLS_SHA);
    // every skill a prompt points the agent at is in the folder the worker mounts
    const promptsDir = join(OVERLAY_FILE, "..");
    const named = new Set(
      readdirSync(promptsDir).flatMap((file) =>
        [
          ...readFileSync(join(promptsDir, file), "utf8").matchAll(
            /\/home\/agent\/\.cursor\/skills\/([a-z-]+)\/SKILL\.md/g,
          ),
        ].map((match) => match[1]),
      ),
    );
    expect([...named].sort()).toEqual(["code-review", "implement", "tdd"]);
    for (const name of named)
      expect(existsSync(join(SANDBOX_SKILLS_DIR, `${name}/SKILL.md`))).toBe(
        true,
      );
    // a different SHA is not read as the overlay's
    expect(overlaySkillsSha(overlay.replace(SKILLS_SHA, "0".repeat(40)))).toBe(
      "0".repeat(40),
    );
    expect(overlaySkillsSha("no header")).toBeUndefined();
  });

  it("makes implement do every sentence of What to build, not only the acceptance criteria, and record a known-gap when it cannot", () => {
    const implement = readFileSync(PROMPTS.implement, "utf8");
    expect(implement).toContain("What to build");
    expect(implement).toMatch(/每一句都要做到/);
    expect(implement).toContain("known-gap");
  });

  it("tells implement to follow spec-wide rules, record a known-gap when it cannot, and defer work that belongs in another ticket's modules", () => {
    const implement = readFileSync(PROMPTS.implement, "utf8");
    expect(implement).toContain("/context/tickets.md");
    expect(implement).toContain("写给整个需求");
    expect(implement).toContain("known-gap");
    expect(implement).toMatch(/记一条 `deferred`/);
    expect(implement).toContain("ref");
    expect(implement).toContain("modules");
  });

  it("tells implement that acceptance keys copy the criterion text including backticks", () => {
    const section = readFileSync(PROMPTS.implement, "utf8");
    const heading = section.indexOf("## 结果");
    expect(heading).toBeGreaterThanOrEqual(0);
    const result = section.slice(heading);
    expect(result).toContain("`acceptance` 的键照抄验收标准原文");
    expect(result).toContain("反引号");
  });

  it("makes implement read the implement skill by its absolute path and skip its code-review step", () => {
    const implement = readFileSync(PROMPTS.implement, "utf8");
    expect(implement).toContain(
      "/home/agent/.cursor/skills/implement/SKILL.md",
    );
    expect(implement).toContain("/home/agent/.cursor/skills/tdd/SKILL.md");
    expect(implement).toMatch(/跳过.*code-review/);
  });

  it("makes the three tdd fixes read tdd, and leaves merge-fix, integration implement and diagnosis to the overlay", () => {
    for (const stage of ["gate-fix", "review-fix", "final-fix"] as const) {
      expect(whole(stage)).toContain("/home/agent/.cursor/skills/tdd/SKILL.md");
      expect(whole(stage)).toContain("会失败的测试");
    }
    expect(whole("review-fix")).toContain("Standards 或 Spec");
    expect(whole("final-fix")).toContain("不论来自哪一轴");
    for (const file of [
      PROMPTS.mergeFix,
      PROMPTS.updateBranch,
      PROMPTS.integrationImplement,
      PROMPTS.diagnose,
      PROMPTS.locateBug,
    ])
      expect(readFileSync(file, "utf8")).not.toContain(
        "/home/agent/.cursor/skills/",
      );
    expect(readFileSync(PROMPTS.mergeFix, "utf8")).toContain("不读 skill");
    expect(readFileSync(PROMPTS.finalTidy, "utf8")).not.toContain(
      "/home/agent/.cursor/skills/",
    );
    expect(readFileSync(PROMPTS.updateBranch, "utf8")).toContain(
      "git merge <defaultBranch>",
    );
  });

  it("tells the Spec axis to rule on conflict and known-gap", () => {
    for (const file of [PROMPTS.reviewSpec, PROMPTS.finalReviewSpec]) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("/context/decisions.json");
      expect(prompt).toContain("rulings");
      expect(prompt).toContain("needs-human");
    }
    expect(readFileSync(PROMPTS.finalReviewSpec, "utf8")).toContain("deferred");
    expect(readFileSync(PROMPTS.finalReviewSpec, "utf8")).toContain(
      "不要写进 `mustFix`",
    );
  });

  it("tells the rendered ticket Spec-axis review that substituting a written approach cannot be accepted", () => {
    const prompt = composePrompt(promptFor("review", { axis: "spec" }));
    expect(prompt).toContain(
      "用另一种做法顶替了 spec、票或契约写明的做法时，不能判 `accepted`",
    );
    expect(prompt).toContain("在 `/refs` 或仓库里查得到原做法的判 `must-fix`");
    expect(prompt).toContain("查不到的判 `needs-human`");
    expect(prompt).toContain("在 `uncertainties` 里写出顶替的是哪一句");
    expect(prompt).toContain("缺配置值或外部地址");
  });

  it("tells the rendered wrap-up Spec-axis review the same substitution ruling as the ticket Spec axis", () => {
    const prompt = composePrompt(promptFor("final-review", { axis: "spec" }));
    expect(prompt).toContain(
      "用另一种做法顶替了 spec、票或契约写明的做法时，不能判 `accepted`",
    );
    expect(prompt).toContain("在 `/refs` 或仓库里查得到原做法的判 `must-fix`");
    expect(prompt).toContain("查不到的判 `needs-human`");
    expect(prompt).toContain("在 `uncertainties` 里写出顶替的是哪一句");
    expect(prompt).toContain("缺配置值或外部地址");
  });

  it("makes the reviews run code-review from the fixed point in run.json", () => {
    for (const stage of ["review", "final-review"] as const) {
      expect(whole(stage)).toContain(
        "/home/agent/.cursor/skills/code-review/SKILL.md",
      );
      expect(whole(stage)).toContain("git diff <baseSha>...HEAD");
    }
  });

  it("only point at /context files rather than carrying the ticket", () => {
    const implement = readFileSync(PROMPTS.implement, "utf8");
    for (const file of [
      "/context/ticket.md",
      "/context/spec.md",
      "/context/run.json",
      "/context/domain/",
    ])
      expect(implement).toContain(file);
    expect(readFileSync(PROMPTS.gateFix, "utf8")).toContain(
      "/context/failure/gate.log",
    );
    expect(readFileSync(PROMPTS.reviewFix, "utf8")).toContain(
      "/context/review.json",
    );
  });

  it("tells gate-fix, merge-fix and final-fix to run the files in cases.json first when that file exists", () => {
    for (const file of [PROMPTS.gateFix, PROMPTS.mergeFix, PROMPTS.finalFix]) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("/context/failure/cases.json");
      expect(prompt).toMatch(/先只跑/);
    }
  });

  it("picks the prompt by stage", () => {
    expect(promptFor("implement")).toBe(PROMPTS.implement);
    expect(promptFor("review")).toBe(PROMPTS.reviewStandards);
    expect(promptFor("gate-fix")).toBe(PROMPTS.gateFix);
    expect(promptFor("review-fix")).toBe(PROMPTS.reviewFix);
    expect(promptFor("merge-fix")).toBe(PROMPTS.mergeFix);
    expect(promptFor("update-branch")).toBe(PROMPTS.updateBranch);
    expect(promptFor("recheck")).toBe(PROMPTS.recheck);
    expect(promptFor("final-tidy")).toBe(PROMPTS.finalTidy);
  });

  const CODE_CHANGING_PROMPTS = [
    PROMPTS.implement,
    PROMPTS.integrationImplement,
    PROMPTS.gateFix,
    PROMPTS.reviewFix,
    PROMPTS.mergeFix,
    PROMPTS.finalFix,
    PROMPTS.finalTidy,
    PROMPTS.updateBranch,
    PROMPTS.diagnose,
  ] as const;

  it("tells every code-changing stage to run the named commands in run.json's gate", () => {
    expect(CODE_CHANGING_PROMPTS).toHaveLength(9);
    for (const file of CODE_CHANGING_PROMPTS) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("/context/run.json");
      expect(prompt).toMatch(/`gate`/);
      expect(prompt).toMatch(/setup/);
    }
  });

  // Calibration 2026-11-16: with only `"mustFix": []` in the example, the Spec axis wrote each must-fix as a
  // string, and every review that found something came back invalid.
  it("tells every review prompt that suggestions, scopeCreep and uncertainties are each a string", () => {
    for (const path of [
      PROMPTS.reviewSpec,
      PROMPTS.reviewStandards,
      PROMPTS.finalReviewSpec,
      PROMPTS.finalReviewStandards,
      PROMPTS.recheck,
    ]) {
      const text = readFileSync(path, "utf8");
      expect(text, path).toContain(
        "`suggestions`、`scopeCreep`、`uncertainties` 的每一项都是一句字符串",
      );
    }
  });

  it("has a <result> example in every stage prompt that the matching schema accepts", () => {
    const cases = [
      { file: promptFor("implement"), schema: ImplementOutputSchema },
      {
        file: promptFor("implement", { integration: true }),
        schema: ImplementOutputSchema,
      },
      { file: promptFor("gate-fix"), schema: ImplementOutputSchema },
      { file: promptFor("review-fix"), schema: ImplementOutputSchema },
      { file: promptFor("merge-fix"), schema: ImplementOutputSchema },
      { file: promptFor("update-branch"), schema: ImplementOutputSchema },
      { file: promptFor("final-fix"), schema: ImplementOutputSchema },
      { file: promptFor("final-tidy"), schema: TidyOutputSchema },
      {
        file: promptFor("review", { axis: "spec" }),
        schema: reviewOutputSchemaFor("spec"),
      },
      {
        file: promptFor("review", { axis: "standards" }),
        schema: reviewOutputSchemaFor("standards"),
      },
      {
        file: promptFor("final-review", { axis: "spec" }),
        schema: reviewOutputSchemaFor("spec"),
      },
      {
        file: promptFor("final-review", { axis: "standards" }),
        schema: reviewOutputSchemaFor("standards"),
      },
      {
        file: promptFor("recheck"),
        schema: reviewOutputSchemaFor("spec"),
      },
      { file: promptFor("diagnose"), schema: DiagnoseOutputSchema },
      { file: promptFor("locate-bug"), schema: LocateOutputSchema },
    ];
    const mapped = new Set(cases.map((row) => row.file));
    for (const name of readdirSync(PROMPT_DIR).filter(
      (file) =>
        file.endsWith(".md") &&
        file !== "overlay.md" &&
        file !== "repair-result.md",
    )) {
      expect(mapped.has(join(PROMPT_DIR, name)), name).toBe(true);
    }
    let sawMustFix = false;
    for (const { file, schema } of cases) {
      const examples = resultExamples(readFileSync(file, "utf8"));
      expect(examples.length, file).toBeGreaterThan(0);
      for (const example of examples) {
        expect(schema.safeParse(example).success, file).toBe(true);
        if (
          example &&
          typeof example === "object" &&
          !Array.isArray(example) &&
          Array.isArray((example as { mustFix?: unknown }).mustFix)
        ) {
          sawMustFix = true;
          expect(
            schema.safeParse({ ...example, mustFix: "写成字符串" }).success,
            file,
          ).toBe(false);
        }
      }
    }
    expect(sawMustFix).toBe(true);
  });

  it("documents the shape of each result field in every stage prompt", () => {
    const resultSection = (text: string) => {
      const heading = text.indexOf("## 结果");
      const last = text.indexOf("## 最后一步");
      const start = heading >= 0 ? heading : last;
      expect(start).toBeGreaterThanOrEqual(0);
      return text.slice(start);
    };
    for (const file of [
      PROMPTS.implement,
      PROMPTS.integrationImplement,
      PROMPTS.gateFix,
      PROMPTS.reviewFix,
      PROMPTS.mergeFix,
      PROMPTS.updateBranch,
      PROMPTS.finalFix,
      PROMPTS.finalTidy,
    ]) {
      const section = resultSection(readFileSync(file, "utf8"));
      expect(section, file).toContain("`decisions` 是对象数组");
      expect(section, file).toContain('每项 `{ "kind", "text" }`');
      expect(section, file).toContain("只有 `kind` 是 `deferred` 时才带 `ref`");
      expect(section, file).toContain("`detail` 是一句字符串");
    }
    for (const file of [
      PROMPTS.implement,
      PROMPTS.integrationImplement,
      PROMPTS.gateFix,
      PROMPTS.reviewFix,
      PROMPTS.mergeFix,
      PROMPTS.updateBranch,
      PROMPTS.finalFix,
    ]) {
      const section = resultSection(readFileSync(file, "utf8"));
      expect(section, file).toContain("`summary` 是一句字符串");
      expect(section, file).toContain("`acceptance` 的值是测试名字符串的数组");
    }
    const tidy = resultSection(readFileSync(PROMPTS.finalTidy, "utf8"));
    expect(tidy).toContain("`tidied` 是从 0 起的整数的数组");
    expect(tidy).toContain("`skipped` 是对象数组");
    expect(tidy).toContain('每项 `{ "index", "reason" }`');
    expect(tidy).toContain("`reason` 是一句字符串");
    for (const file of [
      PROMPTS.reviewSpec,
      PROMPTS.reviewStandards,
      PROMPTS.finalReviewSpec,
      PROMPTS.finalReviewStandards,
      PROMPTS.recheck,
    ]) {
      const section = resultSection(readFileSync(file, "utf8"));
      expect(section, file).toContain(
        '`mustFix` 的每一条都是对象 `{ "file", "line", "problem" }`',
      );
      expect(section, file).toContain(
        "`suggestions`、`scopeCreep`、`uncertainties` 的每一项都是一句字符串",
      );
    }
    for (const file of [PROMPTS.reviewSpec, PROMPTS.finalReviewSpec]) {
      const section = resultSection(readFileSync(file, "utf8"));
      expect(section, file).toContain("`rulings` 是对象数组");
      expect(section, file).toContain('每项 `{ "id", "verdict" }`');
    }
    for (const file of [
      PROMPTS.reviewStandards,
      PROMPTS.finalReviewStandards,
    ]) {
      const section = resultSection(readFileSync(file, "utf8"));
      expect(section, file).toContain("`sources` 是路径字符串的数组");
    }
    const diagnose = resultSection(readFileSync(PROMPTS.diagnose, "utf8"));
    expect(diagnose).toContain('`result` 是 `"pass"` 或 `"fail"`');
    expect(diagnose).toContain("`failingRepo` 是一句字符串或 null");
    expect(diagnose).toContain("`evidence` 是一句字符串");
    expect(diagnose).toContain("`failingTests` 是用例名字符串的数组");
    const locate = resultSection(readFileSync(PROMPTS.locateBug, "utf8"));
    expect(locate).toContain('`result` 是 `"found"` 或 `"unlocated"`');
    expect(locate).toContain("`repo` 是一句字符串");
    expect(locate).toContain("`files` 是路径字符串的数组");
    expect(locate).toContain("`evidence` 和 `reproduction` 是一句字符串");
  });

  it("shows a must-fix item's shape in every review example, and each example is a valid result", () => {
    for (const [path, schema] of [
      [PROMPTS.reviewSpec, ReviewOutputSchema],
      [PROMPTS.finalReviewSpec, ReviewOutputSchema],
      [PROMPTS.recheck, ReviewOutputSchema],
      [PROMPTS.reviewStandards, StandardsReviewOutputSchema],
      [PROMPTS.finalReviewStandards, StandardsReviewOutputSchema],
    ] as const) {
      const text = readFileSync(path, "utf8");
      const json = /<result>\s*([\s\S]*?)\s*<\/result>/.exec(text)?.[1];
      expect(json, path).toBeDefined();
      const example = JSON.parse(json ?? "");
      expect(example.mustFix.length, path).toBeGreaterThan(0);
      expect(schema.safeParse(example).success, path).toBe(true);
    }
  });

  it("tells final-tidy not to change existing tests, config, or test names, and not to read tdd", () => {
    const prompt = readFileSync(PROMPTS.finalTidy, "utf8");
    expect(prompt).toContain("不改已有测试和配置");
    expect(prompt).toContain("不改测试名");
    expect(prompt).not.toContain("/home/agent/.cursor/skills/tdd/SKILL.md");
    const json = /<result>\s*([\s\S]*?)\s*<\/result>/.exec(prompt)?.[1];
    expect(TidyOutputSchema.safeParse(JSON.parse(json ?? "")).success).toBe(
      true,
    );
  });

  it("tells update-branch and merge-fix how to handle colliding migration numbers without naming a rebuild command", () => {
    for (const file of [PROMPTS.updateBranch, PROMPTS.mergeFix]) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("迁移编号冲突");
      expect(prompt).toContain("generated");
      expect(prompt).toContain("AFK_GENERATED_UPSTREAM_SHA");
      expect(prompt).toContain("上游");
      expect(prompt).not.toMatch(/rebase-migrations/);
    }
    expect(readFileSync(PROMPTS.updateBranch, "utf8")).toContain(
      "defaultBranch",
    );
    expect(readFileSync(PROMPTS.mergeFix, "utf8")).toContain(
      "integrationBranch",
    );
  });

  it("names no concrete build or test command; a mention of AGENTS.md is not a violation", () => {
    const promptsDir = join(OVERLAY_FILE, "..");
    const files = readdirSync(promptsDir).filter((name) =>
      name.endsWith(".md"),
    );
    expect(files).toContain("repair-result.md");
    const banned =
      /\b(?:npm|npx|pnpm|yarn|bun|mvn|gradlew?|cargo|pytest|dotnet)\b|\bmake\b|\bgo\s+test\b/i;
    for (const file of files) {
      const hits = readFileSync(join(promptsDir, file), "utf8")
        .split("\n")
        .filter((line) => !line.includes("AGENTS.md"))
        .filter((line) => banned.test(line));
      expect(hits, file).toEqual([]);
    }
  });

  it("gives an integration ticket's implement its own prompt, which says to write the e2e against the real services", () => {
    expect(promptFor("implement", { integration: true })).toBe(
      PROMPTS.integrationImplement,
    );
    // the fixes keep their prompt: the environment is the only difference
    expect(promptFor("gate-fix", { integration: true })).toBe(PROMPTS.gateFix);
    const prompt = readFileSync(PROMPTS.integrationImplement, "utf8");
    for (const word of [
      "cannot-proceed",
      "<result>",
      "e2e",
      "decisions",
      "known-gap",
      "BACKEND_URL",
      "/context/ticket.md",
    ])
      expect(prompt).toContain(word);
    // does not give up on a fault in another repo, and does not touch the other repos
    expect(prompt).toContain("不要因此输出 cannot-proceed");
    expect(prompt).toContain("不要改别的仓库");
  });
});

describe("a fake agent run, end to end", () => {
  const options = <Schema extends z.ZodType>(
    ctxDir: string,
    schema: Schema,
  ) => ({
    stage: "implement" as Stage,
    branch: "agent/T-123",
    baseBranch: "main",
    promptFile: PROMPTS.implement,
    ctxDir,
    schema,
    idleSeconds: 600,
    wallClockMs: 60_000,
  });
  const context = (stage = "implement") => {
    const dir = mkdtempSync(join(tmpdir(), "afk-ctx-"));
    dirs.push(dir);
    const ctx = join(dir, "context");
    renderContext({
      dir: ctx,
      bundle: bundleFor({ stage }),
      run: { runId: "R-1", baseSha: "base", branch: "agent/T-123" },
    });
    return ctx;
  };

  it("creates the branch from the base, commits the agent's files and reports the commits", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "src/orders/export.ts": "export {};\n" },
      message: "Add export",
      output: DONE,
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.error).toBeUndefined();
    expect(run.commits).toHaveLength(1);
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123"])).toBe(run.commits[0]);
    expect(gitOut(repo.dir, ["show", "agent/T-123:src/orders/export.ts"])).toBe(
      "export {};",
    );
    expect(classifyAgentRun(run)).toEqual({ kind: "outcome", outcome: "done" });
    // main is untouched and no worktree is left behind
    expect(gitOut(repo.dir, ["log", "--format=%s", "main"])).toBe("initial");
    expect(gitOut(repo.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("lets the agent read /context, and what it reads is what was rendered", async () => {
    repo = makeRepo();
    let seen: { stage?: string; ticket?: string } = {};
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      seen = JSON.parse(ctx.context("run.json") as string);
      return { files: { "x.txt": "x\n" }, output: DONE };
    });
    await runner.run(options(context(), ImplementOutputSchema));
    expect(seen).toMatchObject({ stage: "implement", ticket: "T-123" });
  });

  it("an agent that says done and commits nothing is no-commits", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({ output: DONE }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(classifyAgentRun(run)).toMatchObject({ outcome: "no-commits" });
  });

  it("a result that does not fit the schema is invalid-output, and the commits it made are still reported", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "a.txt": "a\n" },
      output: { status: "done" },
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.errorKind).toBe("invalid-output");
    expect(run.commits).toHaveLength(1);
    expect(classifyAgentRun(run)).toMatchObject({ outcome: "invalid-output" });
  });

  it("an invalid first result that a repair run fixes keeps the original commits, records resultFix repaired, and adds the repair tokens", async () => {
    repo = makeRepo();
    const firstUsage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    };
    const repairUsage = {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    };
    const runner = new FakeAgentRunner(repo.dir, (ctx): FakeAgentStep => {
      if (ctx.wallClockMs === RESULT_REPAIR_WALL_CLOCK_MS) {
        return {
          files: { "repair-should-not-land.txt": "no\n" },
          output: DONE,
          rawLines: [JSON.stringify({ type: "result", usage: repairUsage })],
        };
      }
      return {
        files: { "src/a.ts": "export {};\n" },
        output: { status: "done" },
        rawLines: [JSON.stringify({ type: "result", usage: firstUsage })],
      };
    });
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.errorKind).toBeUndefined();
    expect(run.output).toMatchObject(DONE);
    expect(run.resultFix).toBe("repaired");
    expect(run.commits).toHaveLength(1);
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123"])).toBe(run.commits[0]);
    expect(
      git(repo.dir, [
        "cat-file",
        "-e",
        "agent/T-123:repair-should-not-land.txt",
      ]).code,
    ).not.toBe(0);
    expect(run.tokenUsage).toEqual({
      inputTokens: 13,
      outputTokens: 6,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.wallClockMs).toBe(RESULT_REPAIR_WALL_CLOCK_MS);
    expect(runner.calls[1]?.model).toBeUndefined();
    expect(classifyAgentRun(run)).toEqual({ kind: "outcome", outcome: "done" });
  });

  it("a result that is valid after normalizing is done with resultFix normalized and starts no repair run", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "src/a.ts": "export {};\n" },
      output: {
        status: "done",
        summary: "did it",
        acceptance: { "returns csv": ["csv test"] },
        decisions: [
          {
            kind: "workaround",
            text: "skipped drizzle generate",
            ref: "91813f8",
          },
        ],
      },
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.errorKind).toBeUndefined();
    expect(run.resultFix).toBe("normalized");
    expect(run.output?.decisions[0]).toEqual({
      kind: "workaround",
      text: "skipped drizzle generate（ref: 91813f8）",
    });
    expect(runner.calls).toHaveLength(1);
    expect(classifyAgentRun(run)).toEqual({ kind: "outcome", outcome: "done" });
  });

  it("a repair run that is still invalid is invalid-output, and keeps the first run's commits", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "a.txt": "a\n" },
      output: { status: "done" },
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.errorKind).toBe("invalid-output");
    expect(run.resultFix).toBeUndefined();
    expect(run.commits).toHaveLength(1);
    expect(runner.calls).toHaveLength(2);
    expect(classifyAgentRun(run)).toMatchObject({ outcome: "invalid-output" });
  });

  it("a missing result tag uses the last assistant message for the repair run", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      if (ctx.wallClockMs === RESULT_REPAIR_WALL_CLOCK_MS) {
        expect(ctx.prompt).toContain('{"status":"done"}');
        return { output: DONE };
      }
      return {
        files: { "src/a.ts": "export {};\n" },
        error: { kind: "invalid-output", message: "no result" },
        rawMatched: "",
        rawLines: [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "text", text: '{"status":"done"}' }],
            },
          }),
        ],
      };
    });
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.errorKind).toBeUndefined();
    expect(run.resultFix).toBe("repaired");
    expect(run.output).toMatchObject(DONE);
    expect(run.commits).toHaveLength(1);
    expect(classifyAgentRun(run)).toEqual({ kind: "outcome", outcome: "done" });
  });

  it("carries a scripted timeout through", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      error: { kind: "timeout", message: "idle 600s" },
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(classifyAgentRun(run)).toMatchObject({ outcome: "timeout" });
  });

  it("a later run on the same branch adds to it, as a fix does", async () => {
    repo = makeRepo();
    let round = 0;
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { [`f${++round}.txt`]: `${round}\n` },
      output: DONE,
    }));
    await runner.run(options(context(), ImplementOutputSchema));
    const fix = await runner.run({
      ...options(context("gate-fix"), ImplementOutputSchema),
      stage: "gate-fix" as const,
    });
    expect(fix.commits).toHaveLength(1);
    expect(gitOut(repo.dir, ["rev-list", "--count", "main..agent/T-123"])).toBe(
      "2",
    );
    git(repo.dir, ["status"]);
  });

  it("takes usage from a result line on the event stream", async () => {
    repo = makeRepo();
    const usage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 20,
      cacheWriteTokens: 1,
    };
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "src/a.ts": "export {};\n" },
      output: DONE,
      rawLines: [
        JSON.stringify({ type: "assistant", message: { content: "hi" } }),
        JSON.stringify({
          type: "result",
          duration_api_ms: 1200,
          cli_version: "2026.10.22-27dcf5f",
          usage,
        }),
      ],
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.tokenUsage).toEqual(usage);
    expect(run.durationApiMs).toBe(1200);
    expect(run.cursorCliVersion).toBe("2026.10.22-27dcf5f");
  });

  it("leaves usage empty when the stream has no result line", async () => {
    repo = makeRepo();
    const runner = new FakeAgentRunner(repo.dir, () => ({
      files: { "src/a.ts": "export {};\n" },
      output: DONE,
    }));
    const run = await runner.run(options(context(), ImplementOutputSchema));
    expect(run.tokenUsage).toBeUndefined();
    expect(run.durationApiMs).toBeUndefined();
    expect(run.cursorCliVersion).toBeUndefined();
  });

  it("a review run is read-only: it commits nothing and returns a verdict", async () => {
    repo = makeRepo();
    git(repo.dir, ["branch", "agent/T-123"]);
    const runner = new FakeAgentRunner(repo.dir, () => ({
      output: {
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      },
    }));
    const run = await runner.run({
      ...options(context("review"), ReviewOutputSchema),
      stage: "review" as const,
    });
    expect(run.commits).toEqual([]);
    expect(classifyReviewRun(run)).toMatchObject({ outcome: "pass" });
  });

  it("a Standards review with no sources is invalid-output", async () => {
    repo = makeRepo();
    git(repo.dir, ["branch", "agent/T-123"]);
    const runner = new FakeAgentRunner(repo.dir, () => ({
      output: {
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      },
    }));
    const run = await runner.run({
      ...options(context("review"), StandardsReviewOutputSchema),
      stage: "review" as const,
    });
    expect(run.errorKind).toBe("invalid-output");
    expect(classifyReviewRun(run)).toMatchObject({ outcome: "invalid-output" });
  });
});
