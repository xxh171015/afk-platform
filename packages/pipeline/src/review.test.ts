import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitOrThrow, gitOut } from "./exec.ts";
import { bundleFor } from "./fixtures.ts";
import { runReview } from "./review.ts";
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

const PASS = {
  verdict: "pass" as const,
  mustFix: [] as { file: string; line?: number; problem: string }[],
  suggestions: [] as string[],
  uncertainties: [] as string[],
  sources: ["AGENTS.md"],
};

describe("runReview", () => {
  it("runs both axes against one rendered context and turns must-fix items into findings", async () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "AGENTS.md": "Use named exports.\n",
    });
    gitOrThrow(repo.dir, ["checkout", "-b", "agent/T-123"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "change n");
    const reviewed = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const baseSha = gitOrThrow(repo.dir, ["rev-parse", "main"]);
    const seen: { prompt: string; ticket?: string; model?: string }[] = [];
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      seen.push({
        prompt: ctx.prompt,
        ticket: ctx.context("ticket.md"),
        ...(ctx.model ? { model: ctx.model } : {}),
      });
      if (ctx.prompt.includes("阶段：review，Spec 轴")) {
        return {
          output: {
            verdict: "fix",
            mustFix: [
              { file: "src/a.ts", line: 1, problem: "the ticket asked for 1" },
            ],
            suggestions: [],
            scopeCreep: ["an extra flag"],
            uncertainties: [],
          },
        };
      }
      return { output: PASS };
    });
    const result = await runReview({
      stage: "review",
      ticketReview: "both",
      repoDir: repo.dir,
      reviewedSha: reviewed,
      baseBranch: "main",
      subjectLabel: "T-123",
      context: {
        bundle: bundleFor({ stage: "review", ticketReview: "both" }),
        run: { runId: "R-9", baseSha, branch: "agent/T-123" },
      },
      runner,
      idleSeconds: 60,
      wallClockMs: 60_000,
      models: { spec: "spec-model", standards: "std-model" },
      tmpRoot: (() => {
        const dir = mkdtempSync(join(tmpdir(), "afk-review-"));
        dirs.push(dir);
        return dir;
      })(),
    });

    expect(seen).toHaveLength(2);
    const spec = seen.find((row) =>
      row.prompt.includes("阶段：review，Spec 轴"),
    );
    const standards = seen.find((row) =>
      row.prompt.includes("阶段：review，Standards 轴"),
    );
    expect(spec?.ticket).toContain("Export orders as CSV");
    expect(standards?.ticket).toContain("Export orders as CSV");
    expect(spec?.model).toBe("spec-model");
    expect(standards?.model).toBe("std-model");
    expect(result.classification).toEqual({ kind: "outcome", outcome: "fix" });
    const specAxis = result.axes.find((row) => row.axis === "spec");
    expect(specAxis?.findings).toEqual(
      expect.arrayContaining([
        { kind: "must-fix", body: "src/a.ts:1 the ticket asked for 1" },
        { kind: "scope-creep", body: "an extra flag" },
      ]),
    );
    expect(gitOut(repo.dir, ["branch", "--list", "review-*"]).trim()).toBe("");
  });

  it("puts tickets.md in a ticket review's context so the Spec axis sees other tickets' modules and status", async () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "AGENTS.md": "Use named exports.\n",
    });
    gitOrThrow(repo.dir, ["checkout", "-b", "agent/T-123"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "change n");
    const reviewed = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    let tickets: string | undefined;
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      if (ctx.prompt.includes("阶段：review，Spec 轴")) {
        tickets = ctx.context("tickets.md");
      }
      return { output: PASS };
    });
    await runReview({
      stage: "review",
      repoDir: repo.dir,
      reviewedSha: reviewed,
      baseBranch: "main",
      subjectLabel: "T-123",
      context: {
        bundle: bundleFor({
          stage: "review",
          specTickets: [
            {
              displayId: "T-123",
              title: "Export orders as CSV",
              body: "## What to build\n\nAdd GET /orders/export.\n",
              acceptanceCriteria: ["returns text/csv"],
              modules: ["src/orders/**"],
              status: "running",
              upstream: false,
            },
            {
              displayId: "T-124",
              title: "Header row",
              body: "## What to build\n\nThe CSV starts with a header row.\n",
              acceptanceCriteria: ["first line is a header"],
              modules: ["src/header/**"],
              status: "other",
              upstream: false,
            },
          ],
        }),
        run: {
          runId: "R-9",
          baseSha: gitOrThrow(repo.dir, ["rev-parse", "main"]),
          branch: "agent/T-123",
        },
      },
      runner,
      idleSeconds: 60,
      wallClockMs: 60_000,
    });
    expect(tickets).toContain("（本票）");
    expect(tickets).toContain("modules: src/header/**");
    expect(tickets).toContain("status: other");
    expect(tickets).toContain("T-124 Header row");
  });

  it("a ticket review with the default spec-only setting runs only the Spec axis", async () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "AGENTS.md": "Use named exports.\n",
    });
    gitOrThrow(repo.dir, ["checkout", "-b", "agent/T-123"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "change n");
    const reviewed = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const prompts: string[] = [];
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      prompts.push(ctx.prompt);
      return {
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: [],
        },
      };
    });
    const result = await runReview({
      stage: "review",
      repoDir: repo.dir,
      reviewedSha: reviewed,
      baseBranch: "main",
      subjectLabel: "T-123",
      context: {
        bundle: bundleFor({ stage: "review" }),
        run: {
          runId: "R-9",
          baseSha: gitOrThrow(repo.dir, ["rev-parse", "main"]),
          branch: "agent/T-123",
        },
      },
      runner,
      idleSeconds: 60,
      wallClockMs: 60_000,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("阶段：review，Spec 轴");
    expect(result.axes.map((row) => row.axis)).toEqual(["spec"]);
    expect(result.classification).toEqual({ kind: "outcome", outcome: "pass" });
  });
});
