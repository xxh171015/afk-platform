import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Bundle,
  DEFAULT_LIMITS,
  REVIEW_AXES,
  type ReviewAxis,
} from "@afk/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentRunner, ReviewOutput } from "./agent.ts";
import { AUTHOR, git, gitOrThrow } from "./exec.ts";
import { bundleFor } from "./fixtures.ts";
import { runReview } from "./review.ts";

// Reads docs/review-calibration samples, runs the same assembled review the worker uses, then
// scores the answers file. The answers file is opened only after every review has finished.

const SampleYaml = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  kind: z.enum(["ticket", "final"]),
});

const AnswerYaml = z.object({
  sample: z.string().min(1),
  id: z.string().min(1),
  type: z.enum(["user-story", "standards"]),
  file: z.string().min(1),
  lines: z.union([z.string(), z.number()]).transform((value) => String(value)),
  description: z.string().min(1),
});

export type CalibrationSample = {
  name: string;
  repo: string;
  base: string;
  kind: "ticket" | "final";
  specMd: string;
  ticketMd?: string;
  patch: string;
};

export type CalibrationAnswer = z.infer<typeof AnswerYaml>;

export type CalibrationHit = "must-fix" | "suggestion" | "未发现" | "运行失败";

export interface RunReviewCalibrationInput {
  root: string;
  makeRunner: (repoDir: string) => AgentRunner;
  models?: Partial<Record<ReviewAxis, string>>;
}

type AxisOutput = {
  axis: ReviewAxis;
  model?: string;
  output?: ReviewOutput;
  error?: string;
  tokenUsage?: unknown;
};

type SampleRun = {
  sample: CalibrationSample;
  axes: AxisOutput[];
  error?: string;
};

export function loadSamples(root: string): CalibrationSample[] {
  const dir = join(root, "samples");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return names.flatMap((name) => {
    const sampleDir = join(dir, name);
    const yamlPath = join(sampleDir, "sample.yaml");
    const specPath = join(sampleDir, "spec.md");
    const patchPath = join(sampleDir, "change.patch");
    if (
      !existsSync(yamlPath) ||
      !existsSync(specPath) ||
      !existsSync(patchPath)
    ) {
      return [];
    }
    const parsed = SampleYaml.parse(parseYaml(readFileSync(yamlPath, "utf8")));
    const ticketPath = join(sampleDir, "ticket.md");
    return [
      {
        name,
        repo: parsed.repo,
        base: parsed.base,
        kind: parsed.kind,
        specMd: readFileSync(specPath, "utf8"),
        patch: readFileSync(patchPath, "utf8"),
        ...(existsSync(ticketPath)
          ? { ticketMd: readFileSync(ticketPath, "utf8") }
          : {}),
      },
    ];
  });
}

export function loadAnswers(path: string): CalibrationAnswer[] {
  const parsed = parseYaml(readFileSync(path, "utf8"));
  return z.array(AnswerYaml).parse(parsed);
}

function parseLines(lines: string): { start: number; end: number } {
  const [startText, endText] = lines.split("-");
  const start = Number(startText);
  const end = endText === undefined || endText === "" ? start : Number(endText);
  return { start, end };
}

function filesEqual(left: string, right: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm(left) === norm(right);
}

function lineInRange(
  line: number | undefined,
  range: { start: number; end: number },
): boolean {
  if (line === undefined) return true;
  return line >= range.start && line <= range.end;
}

function suggestionHits(
  text: string,
  file: string,
  range: { start: number; end: number },
): boolean {
  const match = /^(.+?):(\d+)(?:-\d+)?(?:\s|$)/.exec(text);
  if (!match) return false;
  return (
    filesEqual(match[1] ?? "", file) && lineInRange(Number(match[2]), range)
  );
}

export function scoreDefect(
  defect: Pick<CalibrationAnswer, "file" | "lines">,
  output: ReviewOutput | undefined,
): CalibrationHit {
  if (!output) return "未发现";
  const range = parseLines(defect.lines);
  if (
    output.mustFix.some(
      (item) =>
        filesEqual(item.file, defect.file) && lineInRange(item.line, range),
    )
  ) {
    return "must-fix";
  }
  if (
    output.suggestions.some((text) => suggestionHits(text, defect.file, range))
  ) {
    return "suggestion";
  }
  return "未发现";
}

function formatUsage(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "—";
  const row = usage as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const value = row[key];
    if (typeof value === "number") parts.push(`${key} ${value}`);
  }
  return parts.length > 0 ? parts.join(" · ") : JSON.stringify(usage);
}

function columnTitle(
  axis: ReviewAxis,
  models: Partial<Record<ReviewAxis, string>> | undefined,
): string {
  const model = models?.[axis];
  return model ? `${axis} (${model})` : axis;
}

function headingOf(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim();
}

function bundleForSample(
  sample: CalibrationSample,
  dest: string,
  defaultBranch: string,
  agentBranch: string,
): Bundle {
  const stage = sample.kind === "final" ? "final-review" : "review";
  const specTitle = headingOf(sample.specMd) ?? sample.name;
  const base = bundleFor({ stage, ticketReview: "both" });
  const template = base.ticket;
  if (!template) {
    throw new Error("bundleFor omitted the ticket template");
  }
  return {
    ...base,
    job: { ...base.job, stage },
    ticket:
      sample.kind === "final"
        ? null
        : {
            ...template,
            displayId: "T-cal",
            file: sample.ticketMd ?? template.file,
            title: specTitle,
          },
    spec: {
      ...base.spec,
      displayId: "S-cal",
      title: specTitle,
      body: sample.specMd,
    },
    repo: {
      ...base.repo,
      name: sample.name,
      url: dest,
      defaultBranch,
    },
    integrationBranch: defaultBranch,
    agentBranch,
    ticketReview: "both",
  };
}

function prepareClone(sample: CalibrationSample, dest: string): string {
  const inited = git(dest, ["init", "--quiet"]);
  if (inited.code !== 0) {
    throw new Error(
      `git init ${sample.name} failed: ${inited.out.slice(0, 400)}`,
    );
  }
  const fetched = git(dest, [
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    sample.repo,
    sample.base,
  ]);
  if (fetched.code !== 0) {
    throw new Error(
      `git fetch ${sample.repo} ${sample.base} failed: ${fetched.out.slice(0, 400)}`,
    );
  }
  gitOrThrow(dest, ["checkout", "--quiet", "-B", "main", "FETCH_HEAD"]);
  const agentBranch = `calibration/${sample.name}`;
  gitOrThrow(dest, ["checkout", "--quiet", "-b", agentBranch]);
  const patchFile = join(dest, ".change.patch");
  writeFileSync(patchFile, sample.patch);
  const applied = git(dest, ["apply", "--whitespace=nowarn", patchFile]);
  rmSync(patchFile, { force: true });
  if (applied.code !== 0) {
    throw new Error(
      `git apply ${sample.name} failed: ${applied.out.slice(0, 400)}`,
    );
  }
  gitOrThrow(dest, ["add", "-A"]);
  gitOrThrow(
    dest,
    ["commit", "--quiet", "-m", `calibration: apply ${sample.name}`],
    AUTHOR,
  );
  return "main";
}

async function reviewSample(
  sample: CalibrationSample,
  input: RunReviewCalibrationInput,
): Promise<SampleRun> {
  // The real path: on macOS tmpdir() is /var/folders, a symlink to /private/var/folders. Git worktrees record
  // the real path, and the sandbox mounts only the path it is given.
  const dest = realpathSync(
    mkdtempSync(join(tmpdir(), `afk-cal-${sample.name}-`)),
  );
  try {
    const defaultBranch = prepareClone(sample, dest);
    const agentBranch = `calibration/${sample.name}`;
    const reviewedSha = gitOrThrow(dest, ["rev-parse", "HEAD"]);
    const stage = sample.kind === "final" ? "final-review" : "review";
    const assembled = await runReview({
      stage,
      ticketReview: "both",
      repoDir: dest,
      reviewedSha,
      baseBranch: defaultBranch,
      subjectLabel: sample.name,
      context: {
        bundle: bundleForSample(sample, dest, defaultBranch, agentBranch),
        run: {
          runId: "R-cal",
          baseSha: sample.base,
          branch: agentBranch,
        },
      },
      runner: input.makeRunner(dest),
      idleSeconds: DEFAULT_LIMITS.runIdleSeconds,
      wallClockMs: DEFAULT_LIMITS.runWallclockSeconds * 1000,
      ...(input.models ? { models: input.models } : {}),
    });
    return {
      sample,
      axes: assembled.axes.map((row) => ({
        axis: row.axis,
        ...(row.model ? { model: row.model } : {}),
        ...(row.run.output ? { output: row.run.output } : {}),
        ...(row.run.error ? { error: row.run.error } : {}),
        ...(row.run.tokenUsage !== undefined
          ? { tokenUsage: row.run.tokenUsage }
          : {}),
      })),
    };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function formatCalibrationTable(
  runs: SampleRun[],
  answers: CalibrationAnswer[],
  models?: Partial<Record<ReviewAxis, string>>,
): string {
  const specCol = columnTitle("spec", models);
  const standardsCol = columnTitle("standards", models);
  const hits = [
    "# Review calibration",
    "",
    "## Hits",
    "",
    `| defect | type | ${specCol} | ${standardsCol} |`,
    "| --- | --- | --- | --- |",
  ];
  for (const answer of answers) {
    const run = runs.find((row) => row.sample.name === answer.sample);
    if (run?.error) continue;
    const spec = run?.axes.find((row) => row.axis === "spec");
    const standards = run?.axes.find((row) => row.axis === "standards");
    const cell = (row: AxisOutput | undefined): CalibrationHit =>
      row?.error && !row.output ? "运行失败" : scoreDefect(answer, row?.output);
    hits.push(
      `| ${answer.sample}/${answer.id} | ${answer.type} | ${cell(spec)} | ${cell(standards)} |`,
    );
  }
  const failed = [
    ...runs
      .filter((row) => row.error)
      .map((row) => ({ name: row.sample.name, error: row.error ?? "" })),
    ...runs.flatMap((row) =>
      row.axes
        .filter((axis) => axis.error && !axis.output)
        .map((axis) => ({
          name: `${row.sample.name} (${axis.axis})`,
          error: axis.error ?? "",
        })),
    ),
  ];
  const failures =
    failed.length === 0
      ? []
      : [
          "",
          "## Failures",
          "",
          "| sample | status | detail |",
          "| --- | --- | --- |",
          ...failed.map(
            (row) =>
              `| ${row.name} | 失败 | ${row.error.replace(/\s+/g, " ").replace(/\|/g, "\\|")} |`,
          ),
        ];
  const usage = [
    "",
    "## Token usage",
    "",
    "| sample | axis | model | tokens |",
    "| --- | --- | --- | --- |",
  ];
  for (const run of runs) {
    for (const axis of REVIEW_AXES) {
      const row = run.axes.find((item) => item.axis === axis);
      if (!row) continue;
      usage.push(
        `| ${run.sample.name} | ${axis} | ${row.model ?? models?.[axis] ?? "—"} | ${formatUsage(row.tokenUsage)} |`,
      );
    }
  }
  return `${[...hits, ...failures, ...usage].join("\n")}\n`;
}

export async function runReviewCalibration(
  input: RunReviewCalibrationInput,
): Promise<string> {
  const samples = loadSamples(input.root);
  const runs: SampleRun[] = [];
  for (const sample of samples) {
    try {
      runs.push(await reviewSample(sample, input));
    } catch (error) {
      runs.push({
        sample,
        axes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const answers = loadAnswers(join(input.root, "answers.yaml"));
  return formatCalibrationTable(runs, answers, input.models);
}
