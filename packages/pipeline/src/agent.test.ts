import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stage } from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  type AgentRunResult,
  classifyAgentRun,
  classifyDiagnoseRun,
  classifyReviewRun,
  DiagnoseOutputSchema,
  type ImplementOutput,
  ImplementOutputSchema,
  PROMPTS,
  promptFor,
  type ReviewOutput,
  ReviewOutputSchema,
  reviewFindings,
} from "./agent.ts";
import { renderContext } from "./context.ts";
import { git, gitOut } from "./exec.ts";
import { bundleFor } from "./fixtures.ts";
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

  it("turns must-fix items and suggestions into findings", () => {
    expect(reviewFindings(output("fix"))).toEqual([
      { kind: "must-fix", body: "a.ts:3 null check" },
      { kind: "suggestion", body: "rename x" },
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

describe("the prompts", () => {
  it("exist, and ask for the structured output the schemas accept", () => {
    for (const path of Object.values(PROMPTS))
      expect(existsSync(path)).toBe(true);
    const implement = readFileSync(PROMPTS.implement, "utf8");
    const fix = readFileSync(PROMPTS.fix, "utf8");
    const review = readFileSync(PROMPTS.review, "utf8");
    for (const prompt of [implement, fix]) {
      expect(prompt).toContain("cannot-proceed");
      expect(prompt).toContain("blockedReason");
      expect(prompt).toContain("detail");
      expect(prompt).toContain("agent-gave-up");
      expect(prompt).toContain("contract-change-needed");
      expect(prompt).toContain("<result>");
    }
    expect(review).toContain("verdict");
    expect(review).toContain("mustFix");
  });

  it("only point at /context files rather than carrying the ticket", () => {
    const implement = readFileSync(PROMPTS.implement, "utf8");
    for (const file of [
      "/context/ticket.md",
      "/context/spec.md",
      "/context/run.json",
    ]) {
      expect(implement).toContain(file);
    }
    expect(readFileSync(PROMPTS.fix, "utf8")).toContain(
      "/context/failure/gate.log",
    );
    expect(readFileSync(PROMPTS.fix, "utf8")).toContain("/context/review.json");
  });

  it("picks the prompt by stage: one for implement, one for review, one for the three fixes", () => {
    expect(promptFor("implement")).toBe(PROMPTS.implement);
    expect(promptFor("review")).toBe(PROMPTS.review);
    for (const stage of ["gate-fix", "review-fix", "merge-fix"] as const)
      expect(promptFor(stage)).toBe(PROMPTS.fix);
  });

  it("gives an integration ticket's implement its own prompt, which says to write the e2e against the real services", () => {
    expect(promptFor("implement", { integration: true })).toBe(
      PROMPTS.integrationImplement,
    );
    // the fixes keep their prompt: the environment is the only difference
    expect(promptFor("gate-fix", { integration: true })).toBe(PROMPTS.fix);
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
    expect(prompt).toContain("不改");
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
});
