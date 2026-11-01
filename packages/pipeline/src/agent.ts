import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AGENT_FAILURES,
  type CombinedReview,
  combinedReview,
  type FinalStep,
  REVIEW_AXES,
  type ReviewAxis,
  type Stage,
} from "@afk/shared";
import { z } from "zod";
import type { SandboxPlacement } from "./gate.ts";

// The seam to the agent runner. Sandcastle sits behind `AgentRunner` (#29); everything else in the pipeline,
// and every test, uses a fake. The structured outputs below are what an agent is asked to end with.

export const CANNOT_PROCEED_REASONS = [
  "agent-gave-up",
  "contract-change-needed",
] as const;

export const ImplementOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    summary: z.string(),
    acceptance: z.record(z.string(), z.array(z.string())),
    uncertainties: z.array(z.string()),
  }),
  z.object({
    status: z.literal("cannot-proceed"),
    blockedReason: z.enum(CANNOT_PROCEED_REASONS),
    detail: z.string().min(1),
    summary: z.string().default(""),
    acceptance: z.record(z.string(), z.array(z.string())).default({}),
    uncertainties: z.array(z.string()).default([]),
  }),
]);
export type ImplementOutput = z.infer<typeof ImplementOutputSchema>;

export const ReviewOutputSchema = z
  .object({
    verdict: z.enum(["pass", "fix"]),
    mustFix: z.array(
      z.object({
        file: z.string(),
        line: z.number().int().optional(),
        problem: z.string().min(1),
      }),
    ),
    suggestions: z.array(z.string()),
    // the Spec axis's (b): behaviour nobody asked for. It goes to the acceptance pack, never to a fix.
    scopeCreep: z.array(z.string()).default([]),
    uncertainties: z.array(z.string()),
  })
  .refine((review) => review.mustFix.length === 0 || review.verdict === "fix", {
    message: "mustFix is not empty, so the verdict must be fix",
  });
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// What a diagnosis ends with (docs/specs/m2-platform.md「联调」): which repo is at fault for a failed e2e.
export const DiagnoseOutputSchema = z.object({
  result: z.enum(["pass", "fail"]),
  // a repo's name, "unknown", or null when the e2e passed after all
  failingRepo: z.string().nullable(),
  evidence: z.string(),
  failingTests: z.array(z.string()).default([]),
});
export type DiagnoseOutput = z.infer<typeof DiagnoseOutputSchema>;

export interface AgentRunOptions<Schema extends z.ZodType> {
  stage: Stage | FinalStep;
  branch: string; // the ticket's branch, created from baseBranch when it does not exist
  baseBranch: string;
  promptFile: string;
  ctxDir: string; // mounted read-only as /context
  refs?: { name: string; dir: string }[]; // snapshots of the repos the ticket refs, read-only at /refs/<name>
  schema: Schema;
  // Put the agent's sandbox on an integration environment's network, with the addresses of its services
  placement?: SandboxPlacement;
  idleSeconds: number;
  wallClockMs: number;
  model?: string; // for this run; the runner's own model when not given
  onRawLine?: (line: string) => void; // Cursor's event lines as they come, for the run's log
  // Aborted when the job is lost (the lease was taken back): the run must stop at once.
  signal?: AbortSignal;
}

export interface AgentRunResult<Output> {
  output?: Output;
  commits: string[]; // the commits this run added to the branch
  error?: string;
  errorKind?: "invalid-output" | "timeout" | "other";
  durationMs: number;
}

export interface AgentRunner {
  run<Schema extends z.ZodType>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentRunResult<z.infer<Schema>>>;
}

// What the run means for the ticket: one of the stage outcomes the API understands, or an infrastructure
// failure (the sandbox itself broke), which fails the job so that it is dispatched again.
export type Classification<Outcome> =
  | { kind: "outcome"; outcome: Outcome; detail?: string }
  | { kind: "infrastructure-failure"; error: string };

type AgentOutcome = "done" | (typeof AGENT_FAILURES)[number];
export type ReviewOutcome = "pass" | "fix" | "invalid-output" | "timeout";

function failureOf(
  result: AgentRunResult<unknown>,
): Classification<"invalid-output" | "timeout"> | undefined {
  if (!result.error) return undefined;
  if (result.errorKind === "invalid-output" || result.errorKind === "timeout") {
    return { kind: "outcome", outcome: result.errorKind, detail: result.error };
  }
  return { kind: "infrastructure-failure", error: result.error };
}

// implement and the three fixes: the agent says done or cannot-proceed, and "done" needs a commit.
export function classifyAgentRun(
  result: AgentRunResult<ImplementOutput>,
): Classification<AgentOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  const output = result.output;
  if (!output)
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  if (output.status === "cannot-proceed") {
    return {
      kind: "outcome",
      outcome: output.blockedReason,
      detail: output.detail,
    };
  }
  return result.commits.length === 0
    ? {
        kind: "outcome",
        outcome: "no-commits",
        detail: "the agent said done but made no commit",
      }
    : { kind: "outcome", outcome: "done" };
}

// What a diagnosis means for the ticket: a repo is named (a fix ticket follows), no repo can be named (a person has to
// look), or the output was not usable. An agent that finds the e2e passing after all names no repo either.
export type DiagnoseOutcome =
  | "diagnosed"
  | "unknown-side"
  | "invalid-output"
  | "timeout";

export function classifyDiagnoseRun(
  result: AgentRunResult<DiagnoseOutput>,
): Classification<DiagnoseOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  const output = result.output;
  if (!output) {
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  }
  if (output.result === "fail" && output.failingRepo?.trim()) {
    return output.failingRepo === "unknown"
      ? { kind: "outcome", outcome: "unknown-side" }
      : { kind: "outcome", outcome: "diagnosed" };
  }
  return {
    kind: "outcome",
    outcome: "unknown-side",
    detail:
      output.result === "pass"
        ? "the e2e passed when the diagnosis ran it again"
        : "no repo is named",
  };
}

export function classifyReviewRun(
  result: AgentRunResult<ReviewOutput>,
): Classification<ReviewOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  if (!result.output) {
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  }
  return { kind: "outcome", outcome: result.output.verdict };
}

// The review's findings as the API records them: must-fix problems, and suggestions and scope creep that go to the
// acceptance pack.
export function reviewFindings(
  output: ReviewOutput,
): { kind: "must-fix" | "suggestion" | "scope-creep"; body: string }[] {
  return [
    ...output.mustFix.map((item) => ({
      kind: "must-fix" as const,
      body: `${item.file}${item.line === undefined ? "" : `:${item.line}`} ${item.problem}`,
    })),
    ...output.suggestions.map((body) => ({
      kind: "suggestion" as const,
      body,
    })),
    ...output.scopeCreep.map((body) => ({
      kind: "scope-creep" as const,
      body,
    })),
  ];
}

/**
 * The two axes' runs of one review as one outcome, after step 5 of code-review: side by side, not merged or re-ranked.
 * Any axis that failed makes the whole review that failure (the first one, Standards before Spec); otherwise a must-fix
 * on either axis is a fix. `combined` is what a review-fix reads as review.json: every must-fix with its axis.
 */
export function combineReviewRuns(
  runs: Record<ReviewAxis, AgentRunResult<ReviewOutput>>,
): {
  classification: Classification<ReviewOutcome>;
  combined: CombinedReview | undefined;
} {
  const verdicts = REVIEW_AXES.map((axis) => ({
    axis,
    verdict: classifyReviewRun(runs[axis]),
  }));
  for (const { verdict } of verdicts) {
    if (
      verdict.kind === "infrastructure-failure" ||
      (verdict.outcome !== "pass" && verdict.outcome !== "fix")
    )
      return { classification: verdict, combined: undefined };
  }
  const outputs = {
    standards: runs.standards.output as ReviewOutput,
    spec: runs.spec.output as ReviewOutput,
  };
  const combined = combinedReview(outputs);
  return {
    classification: {
      kind: "outcome",
      outcome: combined.verdict,
    },
    combined,
  };
}

// What an agent is told is two texts put together: the overlay, which is the same for every stage (ADR 0002: nobody
// answers, /context is the tracker, the answers to the questions the skills ask), and the prompt of the stage. The
// prompts only point at files in /context and at the skills; they hold no steps of their own that a skill has.
export const PROMPT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);
export const OVERLAY_FILE = join(PROMPT_DIR, "overlay.md");
export const PROMPTS = {
  implement: join(PROMPT_DIR, "implement.md"),
  integrationImplement: join(PROMPT_DIR, "integration-implement.md"),
  diagnose: join(PROMPT_DIR, "afk-integration.md"),
  gateFix: join(PROMPT_DIR, "gate-fix.md"),
  reviewFix: join(PROMPT_DIR, "review-fix.md"),
  mergeFix: join(PROMPT_DIR, "merge-fix.md"),
  reviewStandards: join(PROMPT_DIR, "review-standards.md"),
  reviewSpec: join(PROMPT_DIR, "review-spec.md"),
  finalReviewStandards: join(PROMPT_DIR, "final-review-standards.md"),
  finalReviewSpec: join(PROMPT_DIR, "final-review-spec.md"),
  finalFix: join(PROMPT_DIR, "final-fix.md"),
} as const;

// The skills version the overlay was written against, from its first line.
export function overlaySkillsSha(overlay: string): string | undefined {
  return /^<!-- overlay for mattpocock\/skills@([0-9a-f]{40}) -->/.exec(
    overlay,
  )?.[1];
}

/** The whole prompt of a stage: the overlay, then the stage's own prompt. This is also what the Run records. */
export function composePrompt(stageFile: string): string {
  return `${readFileSync(OVERLAY_FILE, "utf8").trimEnd()}\n\n---\n\n${readFileSync(stageFile, "utf8")}`;
}

/** Writes the whole prompt of a stage into `dir` for the runner, and returns where and what it says. */
export function writePrompt(
  dir: string,
  stageFile: string,
): { promptFile: string; prompt: string } {
  const prompt = composePrompt(stageFile);
  const promptFile = join(dir, "prompt.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(promptFile, prompt);
  return { promptFile, prompt };
}

// Only the stages that run an agent have a prompt. An integration ticket's implement writes e2e against real
// services and has a prompt of its own; its fixes are the ordinary ones.
export function promptFor(
  stage:
    | "implement"
    | "review"
    | "gate-fix"
    | "review-fix"
    | "merge-fix"
    | "final-review"
    | "final-fix"
    | "diagnose",
  options: { integration?: boolean; axis?: ReviewAxis } = {},
): string {
  switch (stage) {
    case "final-review":
      return options.axis === "spec"
        ? PROMPTS.finalReviewSpec
        : PROMPTS.finalReviewStandards;
    case "final-fix":
      return PROMPTS.finalFix;
    case "diagnose":
      return PROMPTS.diagnose;
    case "implement":
      return options.integration
        ? PROMPTS.integrationImplement
        : PROMPTS.implement;
    case "review":
      return options.axis === "spec"
        ? PROMPTS.reviewSpec
        : PROMPTS.reviewStandards;
    case "gate-fix":
      return PROMPTS.gateFix;
    case "review-fix":
      return PROMPTS.reviewFix;
    case "merge-fix":
      return PROMPTS.mergeFix;
  }
}
