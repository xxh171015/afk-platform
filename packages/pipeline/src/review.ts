import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ReviewAxis,
  reviewAxesFor,
  type TicketReviewMode,
} from "@afk/shared";
import {
  type AgentRunner,
  type AgentRunResult,
  type Classification,
  classifyReviewRun,
  combineReviewRuns,
  promptFor,
  type ReviewOutcome,
  type ReviewOutput,
  reviewFindings,
  reviewOutputSchemaFor,
  writePrompt,
} from "./agent.ts";
import { type ContextInput, renderContext } from "./context.ts";
import { git, gitOrThrow } from "./exec.ts";

// One assembled review: pick the axes, render /context, write each axis's prompt, run the agent, then
// classify and turn the outputs into findings. The executor and the calibration script both call this.

export type ReviewFinding = {
  kind: "must-fix" | "suggestion" | "scope-creep" | "uncertainty";
  body: string;
};

export interface RunReviewInput {
  stage: "review" | "final-review";
  ticketReview?: TicketReviewMode;
  repoDir: string;
  reviewedSha: string;
  baseBranch: string;
  subjectLabel: string;
  context: Omit<ContextInput, "dir">;
  runner: AgentRunner;
  idleSeconds: number;
  wallClockMs: number;
  models?: Partial<Record<ReviewAxis, string>>;
  refs?: { name: string; dir: string }[];
  listedDecisions?: { id: string; kind: string }[];
  signal?: AbortSignal;
  onRawLine?: (line: string) => void;
  tmpRoot?: string;
}

export interface ReviewAxisRun {
  axis: ReviewAxis;
  prompt: string;
  model?: string;
  run: AgentRunResult<ReviewOutput>;
  findings: ReviewFinding[];
  result: string;
}

export interface RunReviewResult {
  classification: Classification<ReviewOutcome>;
  axes: ReviewAxisRun[];
}

function axisResult(run: AgentRunResult<ReviewOutput>): string {
  const verdict = classifyReviewRun(run);
  return verdict.kind === "outcome" ? verdict.outcome : "invalid-output";
}

export async function runReview(
  input: RunReviewInput,
): Promise<RunReviewResult> {
  const stage = input.stage;
  const axes = reviewAxesFor(stage, input.ticketReview);
  const tmp = mkdtempSync(join(input.tmpRoot ?? tmpdir(), "afk-ctx-"));
  const ctxDir = join(tmp, "context");
  renderContext({ ...input.context, dir: ctxDir });
  const branches = new Map(
    axes.map((axis) => [axis, `review-${axis}/${input.subjectLabel}`]),
  );
  for (const branch of branches.values()) {
    gitOrThrow(input.repoDir, [
      "update-ref",
      `refs/heads/${branch}`,
      input.reviewedSha,
    ]);
  }
  try {
    const runs = await Promise.all(
      axes.map(async (axis) => {
        const given = writePrompt(join(tmp, axis), promptFor(stage, { axis }));
        const model = input.models?.[axis];
        const run = await input.runner.run({
          stage,
          branch: branches.get(axis) as string,
          baseBranch: input.baseBranch,
          promptFile: given.promptFile,
          ctxDir,
          ...(input.refs?.length ? { refs: input.refs } : {}),
          schema: reviewOutputSchemaFor(axis),
          idleSeconds: input.idleSeconds,
          wallClockMs: input.wallClockMs,
          ...(model ? { model } : {}),
          ...(input.onRawLine ? { onRawLine: input.onRawLine } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { axis, prompt: given.prompt, model, run };
      }),
    );
    const byAxis = Object.fromEntries(
      runs.map((row) => [row.axis, row.run]),
    ) as Partial<Record<ReviewAxis, AgentRunResult<ReviewOutput>>>;
    let { classification } = combineReviewRuns(byAxis);
    const specRun = byAxis.spec;
    if (
      classification.kind === "outcome" &&
      (classification.outcome === "pass" || classification.outcome === "fix") &&
      specRun &&
      input.listedDecisions
    ) {
      const rulings = classifyReviewRun(specRun, input.listedDecisions);
      if (rulings.kind === "outcome" && rulings.outcome === "invalid-output") {
        classification = rulings;
      }
    }
    return {
      classification,
      axes: runs.map((row) => ({
        axis: row.axis,
        prompt: row.prompt,
        ...(row.model ? { model: row.model } : {}),
        run: row.run,
        findings: row.run.output ? reviewFindings(row.run.output) : [],
        result: axisResult(row.run),
      })),
    };
  } finally {
    for (const branch of branches.values()) {
      git(input.repoDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}
