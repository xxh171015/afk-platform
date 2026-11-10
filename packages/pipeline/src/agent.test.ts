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
  classifyReviewRun,
  combineReviewRuns,
  composePrompt,
  DiagnoseOutputSchema,
  type ImplementOutput,
  ImplementOutputSchema,
  OVERLAY_FILE,
  overlaySkillsSha,
  PROMPT_DIR,
  PROMPTS,
  promptFor,
  type ReviewOutput,
  ReviewOutputSchema,
  reviewFindings,
  reviewOutputSchemaFor,
  reviewSources,
  StandardsReviewOutputSchema,
  writePrompt,
} from "./agent.ts";
import { renderContext } from "./context.ts";
import { git, gitOut } from "./exec.ts";
import { bundleFor } from "./fixtures.ts";
import { SANDBOX_SKILLS_DIR } from "./sandcastle.ts";
import { FakeAgentRunner } from "./testing/fakes.ts";
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
  status: "done",
  summary: "did it",
  acceptance: { "returns csv": ["csv test"] },
  uncertainties: [],
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
    [
      "done with a commit",
      result({ output: DONE as ImplementOutput, commits: ["c1"] }),
      "done",
    ],
    [
      "done without a commit",
      result({ output: DONE as ImplementOutput }),
      "no-commits",
    ],
    [
      "cannot-proceed: gave up",
      result({
        output: {
          status: "cannot-proceed",
          blockedReason: "agent-gave-up",
          detail: "d",
          summary: "",
          acceptance: {},
          uncertainties: [],
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
          uncertainties: [],
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
        uncertainties: [],
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
      }).combined?.standards.sources,
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
    expect(spec).toMatch(/spec\.md`? 只是背景/);
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

const STAGES_WITH_PROMPTS = [
  "implement",
  "review",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "update-branch",
  "final-review",
  "final-fix",
  "diagnose",
] as const;

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
    ] as const) {
      const prompt = whole(stage);
      expect(prompt).toContain("cannot-proceed");
      expect(prompt).toContain("blockedReason");
      expect(prompt).toContain("detail");
      expect(prompt).toContain("agent-gave-up");
      expect(prompt).toContain("contract-change-needed");
      expect(prompt).toContain("<result>");
    }
    for (const stage of ["review", "final-review"] as const) {
      expect(whole(stage)).toContain("verdict");
      expect(whole(stage)).toContain("mustFix");
      expect(whole(stage)).toContain("sources");
    }
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
      "cannot-proceed",
      "不要 push",
      "保护路径",
      "/context/domain/",
      "/context/note.md",
      "不当成改票",
      "单个测试文件怎么跑看仓库的 `AGENTS.md`",
    ])
      expect(overlay).toContain(word);
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
    ])
      expect(readFileSync(file, "utf8")).not.toContain(
        "/home/agent/.cursor/skills/",
      );
    expect(readFileSync(PROMPTS.mergeFix, "utf8")).toContain("不读 skill");
    expect(readFileSync(PROMPTS.updateBranch, "utf8")).toContain(
      "git merge <defaultBranch>",
    );
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

  it("picks the prompt by stage", () => {
    expect(promptFor("implement")).toBe(PROMPTS.implement);
    expect(promptFor("review")).toBe(PROMPTS.reviewStandards);
    expect(promptFor("gate-fix")).toBe(PROMPTS.gateFix);
    expect(promptFor("review-fix")).toBe(PROMPTS.reviewFix);
    expect(promptFor("merge-fix")).toBe(PROMPTS.mergeFix);
    expect(promptFor("update-branch")).toBe(PROMPTS.updateBranch);
  });

  const CODE_CHANGING_PROMPTS = [
    PROMPTS.implement,
    PROMPTS.integrationImplement,
    PROMPTS.gateFix,
    PROMPTS.reviewFix,
    PROMPTS.mergeFix,
    PROMPTS.finalFix,
    PROMPTS.updateBranch,
    PROMPTS.diagnose,
  ] as const;

  it("tells every code-changing stage to run the named commands in run.json's gate", () => {
    expect(CODE_CHANGING_PROMPTS).toHaveLength(8);
    for (const file of CODE_CHANGING_PROMPTS) {
      const prompt = readFileSync(file, "utf8");
      expect(prompt).toContain("/context/run.json");
      expect(prompt).toMatch(/`gate`/);
      expect(prompt).toMatch(/setup/);
    }
  });

  it("names no concrete build or test command; a mention of AGENTS.md is not a violation", () => {
    const promptsDir = join(OVERLAY_FILE, "..");
    const banned =
      /\b(?:npm|npx|pnpm|yarn|bun|mvn|gradlew?|cargo|pytest|dotnet)\b|\bmake\b|\bgo\s+test\b/i;
    for (const file of readdirSync(promptsDir).filter((name) =>
      name.endsWith(".md"),
    )) {
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
      "uncertainties",
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
