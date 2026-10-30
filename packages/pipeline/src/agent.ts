import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AGENT_FAILURES, FinalStep, Stage } from "@afk/shared";
import { z } from "zod";

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
    uncertainties: z.array(z.string()),
  })
  .refine((review) => review.mustFix.length === 0 || review.verdict === "fix", {
    message: "mustFix is not empty, so the verdict must be fix",
  });
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export interface AgentRunOptions<Schema extends z.ZodType> {
  stage: Stage | FinalStep;
  branch: string; // the ticket's branch, created from baseBranch when it does not exist
  baseBranch: string;
  promptFile: string;
  ctxDir: string; // mounted read-only as /context
  refs?: { name: string; dir: string }[]; // snapshots of the repos the ticket refs, read-only at /refs/<name>
  schema: Schema;
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
type ReviewOutcome = "pass" | "fix" | "invalid-output" | "timeout";

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

// The review's findings as the API records them: must-fix problems, and suggestions that go to the acceptance pack.
export function reviewFindings(
  output: ReviewOutput,
): { kind: "must-fix" | "suggestion"; body: string }[] {
  return [
    ...output.mustFix.map((item) => ({
      kind: "must-fix" as const,
      body: `${item.file}${item.line === undefined ? "" : `:${item.line}`} ${item.problem}`,
    })),
    ...output.suggestions.map((body) => ({
      kind: "suggestion" as const,
      body,
    })),
  ];
}

// The prompts only point at files in /context.
export const PROMPT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);
export const PROMPTS = {
  implement: join(PROMPT_DIR, "implement.md"),
  fix: join(PROMPT_DIR, "fix.md"),
  review: join(PROMPT_DIR, "review.md"),
  finalReview: join(PROMPT_DIR, "final-review.md"),
  finalFix: join(PROMPT_DIR, "final-fix.md"),
} as const;

// Only the stages that run an agent have a prompt; the three fixes share one.
export function promptFor(
  stage:
    | "implement"
    | "review"
    | "gate-fix"
    | "review-fix"
    | "merge-fix"
    | "final-review"
    | "final-fix",
): string {
  switch (stage) {
    case "final-review":
      return PROMPTS.finalReview;
    case "final-fix":
      return PROMPTS.finalFix;
    case "implement":
      return PROMPTS.implement;
    case "review":
      return PROMPTS.review;
    case "gate-fix":
    case "review-fix":
    case "merge-fix":
      return PROMPTS.fix;
  }
}
