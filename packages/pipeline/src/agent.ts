import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AGENT_FAILURES,
  type CombinedReview,
  checkReviewRulings,
  coerceDecisionsInput,
  combinedReview,
  DecisionsField,
  type FinalStep,
  REVIEW_AXES,
  type ReviewAxis,
  RulingSchema,
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

const ImplementOutputObject = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    summary: z.string(),
    acceptance: z.record(z.string(), z.array(z.string())),
    decisions: DecisionsField,
  }),
  z.object({
    status: z.literal("cannot-proceed"),
    blockedReason: z.enum(CANNOT_PROCEED_REASONS),
    detail: z.string().min(1),
    summary: z.string().default(""),
    acceptance: z.record(z.string(), z.array(z.string())).default({}),
    decisions: DecisionsField.default([]),
  }),
]);
export type ImplementOutput = z.infer<typeof ImplementOutputObject>;

const TidySkipped = z.object({
  index: z.number().int().min(0),
  reason: z.string().min(1),
});
const TidyOutputObject = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    summary: z.string(),
    tidied: z.array(z.number().int().min(0)),
    skipped: z.array(TidySkipped),
    decisions: DecisionsField,
  }),
  z.object({
    status: z.literal("cannot-proceed"),
    blockedReason: z.enum(CANNOT_PROCEED_REASONS),
    detail: z.string().min(1),
    summary: z.string().default(""),
    tidied: z.array(z.number().int().min(0)).default([]),
    skipped: z.array(TidySkipped).default([]),
    decisions: DecisionsField.default([]),
  }),
]);
export type TidyOutput = z.infer<typeof TidyOutputObject>;

const ReviewLineObject = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  problem: z.string().min(1),
});

function reviewLineText(item: z.infer<typeof ReviewLineObject>): string {
  return `${item.file}${item.line === undefined ? "" : `:${item.line}`} ${item.problem}`;
}

// suggestions, scopeCreep and uncertainties: a string, or ReviewLineObject (mustFix without id),
// which is turned into that one-line form before it is stored as a Finding.
const ReviewLine = z.union([
  z.string(),
  ReviewLineObject.transform(reviewLineText),
]);

function coerceReviewLineItem(item: unknown): unknown {
  const parsed = ReviewLine.safeParse(item);
  return parsed.success ? parsed.data : item;
}

const RESULT_ARRAY_FIELDS = [
  "suggestions",
  "uncertainties",
  "decisions",
  "scopeCreep",
] as const;

function looksLikeReviewResult(obj: Record<string, unknown>): boolean {
  return "verdict" in obj || "mustFix" in obj;
}

// Clear-meaning deviations, including T-109's object-to-sentence form, before the schema runs.
function normalizeResultInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (!looksLikeReviewResult(obj)) {
    obj = coerceDecisionsInput(obj) as Record<string, unknown>;
  }
  for (const key of RESULT_ARRAY_FIELDS) {
    if (obj[key] === undefined) obj[key] = [];
  }
  for (const key of ["suggestions", "uncertainties", "scopeCreep"] as const) {
    const value = obj[key];
    if (Array.isArray(value)) obj[key] = value.map(coerceReviewLineItem);
  }
  return obj;
}

const resultSchemaInners = new WeakMap<z.ZodType, z.ZodType>();

function resultSchema<Schema extends z.ZodType>(schema: Schema) {
  const wrapped = z.preprocess(normalizeResultInput, schema);
  resultSchemaInners.set(wrapped, schema);
  return wrapped;
}

export function strictResultSchema<S extends z.ZodType>(schema: S): z.ZodType {
  return resultSchemaInners.get(schema) ?? schema;
}

export type ResultFix = "normalized" | "repaired";

export function interpretStructuredOutput<S extends z.ZodType>(
  schema: S,
  raw: unknown,
):
  | { ok: true; output: z.infer<S>; resultFix?: "normalized" }
  | { ok: false; issues: { path: string; message: string }[] } {
  const inner = strictResultSchema(schema);
  const asIs = inner.safeParse(raw);
  if (asIs.success) return { ok: true, output: asIs.data as z.infer<S> };
  const normalized = schema.safeParse(raw);
  if (normalized.success) {
    return {
      ok: true,
      output: normalized.data as z.infer<S>,
      resultFix: "normalized",
    };
  }
  return { ok: false, issues: formatResultIssues(normalized.error) };
}

function parseJsonValue(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function rawResultText(input: {
  rawMatched?: string;
  lastAssistant?: string;
  output?: unknown;
}): string {
  const tagged = input.rawMatched?.trim() ?? "";
  if (tagged.length > 0) return tagged;
  if (input.output !== undefined) {
    try {
      return JSON.stringify(input.output);
    } catch {
      return String(input.output);
    }
  }
  return input.lastAssistant ?? "";
}

export function recoverStructuredOutput<S extends z.ZodType>(
  schema: S,
  input: {
    rawMatched?: string;
    lastAssistant?: string;
    output?: unknown;
  },
):
  | { ok: true; output: z.infer<S>; resultFix?: "normalized"; rawText: string }
  | {
      ok: false;
      rawText: string;
      issues: { path: string; message: string }[];
    } {
  const rawText = rawResultText(input);
  const tagged = input.rawMatched?.trim() ?? "";
  const value =
    input.output !== undefined && tagged.length === 0
      ? input.output
      : parseJsonValue(rawText);
  if (value === undefined) {
    return {
      ok: false,
      rawText,
      issues: [
        {
          path: "(root)",
          message: rawText.length > 0 ? "not JSON" : "no result",
        },
      ],
    };
  }
  const interpreted = interpretStructuredOutput(schema, value);
  if (interpreted.ok) return { ...interpreted, rawText };
  return { ok: false, rawText, issues: interpreted.issues };
}

export const ImplementOutputSchema = resultSchema(ImplementOutputObject);
export const TidyOutputSchema = resultSchema(TidyOutputObject);

const ReviewObject = z.object({
  verdict: z.enum(["pass", "fix"]),
  mustFix: z.array(
    ReviewLineObject.extend({
      // a must-fix Ruling points at the Decision by this id (R-n#index)
      id: z.string().min(1).optional(),
    }),
  ),
  suggestions: z.array(ReviewLine),
  // the Spec axis's (b): behaviour nobody asked for. It goes to the acceptance pack, never to a fix.
  scopeCreep: z.array(ReviewLine).default([]),
  uncertainties: z.array(ReviewLine),
  // Spec axis: a Ruling for each conflict and known-gap. Standards leaves this off.
  rulings: z.array(RulingSchema).optional(),
  // final-review Spec axis: a verdict per ticket-review uncertainty. Missing is open; omitting the field is valid.
  uncertaintyRulings: z
    .array(
      z.object({
        id: z.string().min(1),
        verdict: z.enum(["resolved", "open"]),
      }),
    )
    .optional(),
  // files this review used as standards sources. Required on the Standards axis.
  sources: z.array(z.string()).optional(),
});

const verdictMatchesMustFix = (review: {
  mustFix: unknown[];
  verdict: string;
}) => review.mustFix.length === 0 || review.verdict === "fix";

const ReviewParsed = ReviewObject.refine(verdictMatchesMustFix, {
  message: "mustFix is not empty, so the verdict must be fix",
});
export const ReviewOutputSchema = resultSchema(ReviewParsed);
export type ReviewOutput = z.infer<typeof ReviewParsed>;

// Without the preprocess, suggestions/scopeCreep/uncertainties must already be strings
// (Run 655's object form is what normalize turns into a sentence).
const StrictReviewParsed = ReviewObject.extend({
  suggestions: z.array(z.string()),
  scopeCreep: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()),
}).refine(verdictMatchesMustFix, {
  message: "mustFix is not empty, so the verdict must be fix",
});

/** The standards-source files a review named, or undefined when the result has none. */
export function reviewSources(output: unknown): string[] | undefined {
  if (!output || typeof output !== "object") return undefined;
  const sources = (output as { sources?: unknown }).sources;
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((item) => typeof item !== "string")
  )
    return undefined;
  return sources;
}

export function sourcesCiteAgentsMd(sources: readonly string[]): boolean {
  return sources.some(
    (path) => path.replace(/\\/g, "/").split("/").pop() === "AGENTS.md",
  );
}

const StandardsReviewParsed = ReviewObject.extend({
  sources: z.array(z.string()).min(1),
})
  .refine(verdictMatchesMustFix, {
    message: "mustFix is not empty, so the verdict must be fix",
  })
  .refine((review) => sourcesCiteAgentsMd(review.sources), {
    message: "AGENTS.md must be among the sources",
    path: ["sources"],
  });
export const StandardsReviewOutputSchema = resultSchema(StandardsReviewParsed);

export function reviewOutputSchemaFor(axis: ReviewAxis) {
  return axis === "standards"
    ? StandardsReviewOutputSchema
    : ReviewOutputSchema;
}

// What a diagnosis ends with (docs/specs/m2-platform.md「联调」): which repo is at fault for a failed e2e.
const DiagnoseOutputObject = z.object({
  result: z.enum(["pass", "fail"]),
  // a repo's name, "unknown", or null when the e2e passed after all
  failingRepo: z.string().nullable(),
  evidence: z.string(),
  failingTests: z.array(z.string()).default([]),
});
export const DiagnoseOutputSchema = resultSchema(DiagnoseOutputObject);
export type DiagnoseOutput = z.infer<typeof DiagnoseOutputObject>;

// What Locate ends with (GLOSSARY Locate): one repo name, not a list, then the worker blames those files.
const LocateOutputObject = z.object({
  result: z.enum(["found", "unlocated"]),
  repo: z.string(),
  files: z.array(z.string()).default([]),
  evidence: z.string(),
  reproduction: z.string().default(""),
});
export const LocateOutputSchema = resultSchema(LocateOutputObject);
export type LocateOutput = z.infer<typeof LocateOutputObject>;

const ReworkCommentResultObject = z.object({
  id: z.string().min(1),
  outcome: z.enum(["addressed", "declined"]),
  reply: z.string().min(1),
});

const ReworkOutputObject = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    summary: z.string(),
    comments: z.array(ReworkCommentResultObject),
    acceptance: z.record(z.string(), z.array(z.string())),
    decisions: DecisionsField,
  }),
  z.object({
    status: z.literal("cannot-proceed"),
    blockedReason: z.enum(CANNOT_PROCEED_REASONS),
    detail: z.string().min(1),
    summary: z.string().default(""),
    comments: z.array(ReworkCommentResultObject).default([]),
    acceptance: z.record(z.string(), z.array(z.string())).default({}),
    decisions: DecisionsField.default([]),
  }),
]);
export type ReworkOutput = z.infer<typeof ReworkOutputObject>;

function commentsCoverExpectedIds(expectedIds: readonly string[]) {
  const expected = new Set(expectedIds);
  return (
    value: { status: string; comments?: { id: string }[] },
    ctx: z.RefinementCtx,
  ) => {
    if (value.status !== "done") return;
    const comments = value.comments ?? [];
    const seen = new Set<string>();
    for (const [index, item] of comments.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["comments", index, "id"],
          message: "duplicate comment id",
        });
      }
      seen.add(item.id);
      if (!expected.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["comments", index, "id"],
          message: "unknown comment id",
        });
      }
    }
    for (const id of expectedIds) {
      if (!seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["comments"],
          message: `missing ${id}`,
        });
      }
    }
  };
}

export function reworkOutputSchema(expectedIds?: readonly string[]) {
  const inner =
    expectedIds === undefined
      ? ReworkOutputObject
      : ReworkOutputObject.superRefine(commentsCoverExpectedIds(expectedIds));
  return resultSchema(inner);
}

export const ReworkOutputSchema = reworkOutputSchema();

export function reviewCommentIdsFromContext(
  cwd = process.cwd(),
): string[] | undefined {
  for (const path of [
    "/context/review-comments.json",
    join(cwd, "context/review-comments.json"),
  ]) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const comments = (raw as { comments?: unknown }).comments;
      if (!Array.isArray(comments)) continue;
      const ids = comments.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const id = (item as { id?: unknown }).id;
        return typeof id === "string" && id.length > 0 ? [id] : [];
      });
      return ids;
    } catch {}
  }
  return undefined;
}

// Stages whose /context/run.json name has a result schema. The self-check command
// (`packages/pipeline/src/check-result.ts`) looks them up here.
export const RESULT_CHECK_STAGES = [
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "final-fix",
  "rework",
  "update-branch",
  "review",
  "final-review",
  "recheck",
  "final-tidy",
  "diagnose",
  "locate-bug",
] as const;

const IMPLEMENT_CHECK_STAGES = new Set<string>([
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "final-fix",
  "update-branch",
]);

const REVIEW_CHECK_STAGES = new Set<string>([
  "review",
  "final-review",
  "recheck",
]);

export function resultCheckSchema(
  stage: string,
  options: { normalize: boolean },
): z.ZodType | undefined {
  if (IMPLEMENT_CHECK_STAGES.has(stage)) {
    return options.normalize ? ImplementOutputSchema : ImplementOutputObject;
  }
  if (REVIEW_CHECK_STAGES.has(stage)) {
    return options.normalize ? ReviewOutputSchema : StrictReviewParsed;
  }
  if (stage === "final-tidy") {
    return options.normalize ? TidyOutputSchema : TidyOutputObject;
  }
  if (stage === "diagnose") {
    return options.normalize ? DiagnoseOutputSchema : DiagnoseOutputObject;
  }
  if (stage === "locate-bug") {
    return options.normalize ? LocateOutputSchema : LocateOutputObject;
  }
  if (stage === "rework") {
    const schema = reworkOutputSchema(reviewCommentIdsFromContext());
    return options.normalize ? schema : strictResultSchema(schema);
  }
  return undefined;
}

export interface AgentRunOptions<Schema extends z.ZodType> {
  stage: Stage | FinalStep | "update-branch" | "locate-bug";
  branch: string; // the agent's branch, created from baseBranch when it does not exist
  baseBranch: string;
  promptFile: string;
  ctxDir: string; // mounted read-only as /context
  refs?: { name: string; dir: string }[]; // snapshots of the repos the ticket refs, read-only at /refs/<name>
  schema: Schema;
  // Put the agent's sandbox on an integration environment's network, with the addresses of its services
  placement?: SandboxPlacement;
  // Extra variables inside the agent sandbox (AFK_GENERATED_UPSTREAM_SHA on update-branch and merge-fix).
  env?: Record<string, string>;
  idleSeconds: number;
  wallClockMs: number;
  model?: string; // for this run; the runner's own model when not given
  onRawLine?: (line: string) => void; // Cursor's event lines as they come, for the run's log
  // Aborted when the job is lost (the lease was taken back): the run must stop at once.
  signal?: AbortSignal;
  // A follow-up run that only rewrites <result>; the original commits are kept.
  resultRepair?: boolean;
}

export interface AgentRunResult<Output> {
  output?: Output;
  commits: string[]; // the commits this run added to the branch
  error?: string;
  errorKind?: "invalid-output" | "timeout" | "other";
  durationMs: number;
  // From the Cursor result line, as written: stored on the Run. Absent when the stream had no result.
  tokenUsage?: unknown;
  durationApiMs?: number;
  cursorCliVersion?: string;
  resultFix?: ResultFix;
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

// implement, the three fixes, and Tidy: the agent says done or cannot-proceed, and "done" needs a commit.
export function classifyAgentRun(
  result: AgentRunResult<{
    status: "done" | "cannot-proceed";
    blockedReason?: (typeof CANNOT_PROCEED_REASONS)[number];
    detail?: string;
  }>,
  options: { requireCommit?: boolean } = {},
): Classification<AgentOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  const output = result.output;
  if (!output)
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  if (output.status === "cannot-proceed") {
    if (!output.blockedReason || !output.detail) {
      return {
        kind: "outcome",
        outcome: "invalid-output",
        detail: output.detail ?? "no result",
      };
    }
    return {
      kind: "outcome",
      outcome: output.blockedReason,
      detail: output.detail,
    };
  }
  return result.commits.length === 0 && options.requireCommit !== false
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

export type LocateOutcome =
  | "found"
  | "unlocated"
  | "invalid-output"
  | "timeout";

export function classifyLocateRun(
  result: AgentRunResult<LocateOutput>,
): Classification<LocateOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  const output = result.output;
  if (!output) {
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  }
  if (output.result === "found" && output.repo.trim()) {
    return { kind: "outcome", outcome: "found" };
  }
  if (output.result === "unlocated") {
    return { kind: "outcome", outcome: "unlocated" };
  }
  return {
    kind: "outcome",
    outcome: "invalid-output",
    detail: "found without a repo name",
  };
}

export function classifyReviewRun(
  result: AgentRunResult<ReviewOutput>,
  listed?: { id: string; kind: string }[],
): Classification<ReviewOutcome> {
  const failure = failureOf(result);
  if (failure) return failure;
  if (!result.output) {
    return { kind: "outcome", outcome: "invalid-output", detail: "no result" };
  }
  if (listed) {
    const check = checkReviewRulings({
      decisions: listed,
      rulings: result.output.rulings ?? [],
      mustFix: result.output.mustFix,
    });
    if (!check.ok) {
      return {
        kind: "outcome",
        outcome: "invalid-output",
        detail: check.reason,
      };
    }
  }
  return { kind: "outcome", outcome: result.output.verdict };
}

// The review's findings as the API records them: must-fix problems, and suggestions, scope creep
// and uncertainties that go to the acceptance pack.
export function reviewFindings(output: ReviewOutput): {
  kind: "must-fix" | "suggestion" | "scope-creep" | "uncertainty";
  body: string;
}[] {
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
    ...output.uncertainties.map((body) => ({
      kind: "uncertainty" as const,
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
  runs: Partial<Record<ReviewAxis, AgentRunResult<ReviewOutput>>>,
): {
  classification: Classification<ReviewOutcome>;
  combined: CombinedReview | undefined;
} {
  const present = REVIEW_AXES.filter((axis) => runs[axis] !== undefined);
  const verdicts = present.map((axis) => ({
    axis,
    verdict: classifyReviewRun(runs[axis] as AgentRunResult<ReviewOutput>),
  }));
  for (const { verdict } of verdicts) {
    if (
      verdict.kind === "infrastructure-failure" ||
      (verdict.outcome !== "pass" && verdict.outcome !== "fix")
    )
      return { classification: verdict, combined: undefined };
  }
  const outputs: Partial<Record<ReviewAxis, ReviewOutput>> = {};
  for (const axis of present) {
    outputs[axis] = runs[axis]?.output as ReviewOutput;
  }
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
  locateBug: join(PROMPT_DIR, "locate-bug.md"),
  gateFix: join(PROMPT_DIR, "gate-fix.md"),
  reviewFix: join(PROMPT_DIR, "review-fix.md"),
  mergeFix: join(PROMPT_DIR, "merge-fix.md"),
  updateBranch: join(PROMPT_DIR, "update-branch.md"),
  reviewStandards: join(PROMPT_DIR, "review-standards.md"),
  reviewSpec: join(PROMPT_DIR, "review-spec.md"),
  finalReviewStandards: join(PROMPT_DIR, "final-review-standards.md"),
  finalReviewSpec: join(PROMPT_DIR, "final-review-spec.md"),
  finalFix: join(PROMPT_DIR, "final-fix.md"),
  rework: join(PROMPT_DIR, "rework.md"),
  finalTidy: join(PROMPT_DIR, "final-tidy.md"),
  recheck: join(PROMPT_DIR, "recheck.md"),
  repairResult: join(PROMPT_DIR, "repair-result.md"),
} as const;

export const RESULT_REPAIR_WALL_CLOCK_MS = 180_000;
export const RESULT_REPAIR_IDLE_SECONDS = 180;

export function formatResultIssues(
  error: z.ZodError,
): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

export function resultSectionOf(prompt: string): string {
  const matches = [...prompt.matchAll(/^## 结果\s*$/gm)];
  const last = matches.at(-1);
  if (last?.index === undefined) return prompt;
  return prompt.slice(last.index).trim();
}

export function writeRepairPrompt(
  dir: string,
  input: {
    resultSection: string;
    rawText: string;
    issues: readonly { path: string; message: string }[];
  },
): { promptFile: string; prompt: string } {
  const template = readFileSync(PROMPTS.repairResult, "utf8").trimEnd();
  const listed =
    input.issues.length > 0
      ? input.issues
          .map((issue) => `- ${issue.path}：${issue.message}`)
          .join("\n")
      : "- （无逐条路径）";
  const prompt = `${template}

## 这个阶段的结果格式

${input.resultSection}

## 原始文本

${input.rawText.length > 0 ? input.rawText : "（空）"}

## 校验错误

${listed}
`;
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, "repair-prompt.md");
  writeFileSync(promptFile, prompt);
  return { promptFile, prompt };
}

export function addTokenUsage(a?: unknown, b?: unknown): unknown | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (
    typeof a !== "object" ||
    a === null ||
    Array.isArray(a) ||
    typeof b !== "object" ||
    b === null ||
    Array.isArray(b)
  ) {
    return a;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const prev = out[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] =
        (typeof prev === "number" && Number.isFinite(prev) ? prev : 0) + value;
    } else if (prev === undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function repairRunOptions<S extends z.ZodType>(
  options: AgentRunOptions<S>,
  promptFile: string,
  branch: string,
): AgentRunOptions<S> {
  const { model: _model, ...rest } = options;
  return {
    ...rest,
    promptFile,
    branch,
    baseBranch: options.branch,
    wallClockMs: RESULT_REPAIR_WALL_CLOCK_MS,
    idleSeconds: RESULT_REPAIR_IDLE_SECONDS,
    resultRepair: true,
  };
}

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
    | "update-branch"
    | "final-review"
    | "final-fix"
    | "rework"
    | "final-tidy"
    | "recheck"
    | "diagnose"
    | "locate-bug",
  options: { integration?: boolean; axis?: ReviewAxis } = {},
): string {
  switch (stage) {
    case "final-review":
      return options.axis === "spec"
        ? PROMPTS.finalReviewSpec
        : PROMPTS.finalReviewStandards;
    case "final-fix":
      return PROMPTS.finalFix;
    case "rework":
      return PROMPTS.rework;
    case "final-tidy":
      return PROMPTS.finalTidy;
    case "recheck":
      return PROMPTS.recheck;
    case "diagnose":
      return PROMPTS.diagnose;
    case "locate-bug":
      return PROMPTS.locateBug;
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
    case "update-branch":
      return PROMPTS.updateBranch;
  }
}
