import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { gitOrThrow } from "./exec.ts";

// The gate: a repo's own checks, run in a fresh sandbox on a commit (docs/design.md「门禁」). The configuration
// is read from a trusted commit, never from the branch under test; commands run in order and the first
// failure stops the run; the number of tests may not shrink and the number of skipped tests may not grow.

export const GATE_CONFIG_PATH = ".sandcastle/gates.yaml";
export const FAILURE_LOG_LINES = 200;
const SETUP_TIMEOUT_SECONDS = 600;
const DEFAULT_JUNIT_PATH = "reports/junit.xml";

const GateConfigSchema = z.object({
  setup: z.string().min(1).optional(),
  commands: z
    .array(
      z.object({
        name: z.string().min(1),
        run: z.string().min(1),
        timeoutSeconds: z.number().int().min(1),
        junit: z.string().min(1).optional(),
      }),
    )
    .min(1),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

// A sandbox that is thrown away afterwards. The only module that talks to Sandcastle implements this (#29).
export interface SandboxSession {
  exec(
    command: string,
    options: { timeoutSeconds: number },
  ): Promise<{ exitCode: number; output: string }>;
  readFile(path: string): Promise<string | undefined>;
  close(): Promise<void>;
}
// Where a sandbox is put: the compose network of an integration environment, and the addresses of its services.
export interface SandboxPlacement {
  network: string;
  env: Record<string, string>;
}
export interface GateSandbox {
  open(ref: string, placement?: SandboxPlacement): Promise<SandboxSession>;
}

export interface TestCounts {
  tests: number;
  skipped: number;
}

export interface StepOutcome {
  name: string;
  exitCode: number;
  ms: number;
}

export interface GateOutcome {
  pass: boolean;
  reasons: string[];
  commitSha: string;
  configSha: string;
  counts?: TestCounts; // only when a JUnit report was read
  testCases?: TestCase[]; // the same report, case by case
  steps: StepOutcome[];
  failureLog: string; // for gate-fix and merge-fix; empty when the gate passed
  stepLogs: Record<string, string>; // full logs per step, for the run log
  junit?: string;
}

// `timeout N cmd` only times the first word, so the whole command line goes to a shell as one argument.
export const shellQuote = (text: string) =>
  `'${text.replaceAll("'", `'\\''`)}'`;

export function readGateConfig(repoDir: string, configSha: string): GateConfig {
  const text = gitOrThrow(repoDir, [
    "show",
    `${configSha}:${GATE_CONFIG_PATH}`,
  ]);
  return GateConfigSchema.parse(parseYaml(text));
}

export function junitCounts(xml: string): TestCounts | undefined {
  const tests = /<testsuites[^>]*\btests="(\d+)"/.exec(xml)?.[1];
  if (tests === undefined) return undefined;
  const skipped = [
    ...xml.matchAll(/<testsuite\s[^>]*\bskipped="(\d+)"/g),
  ].reduce((sum, match) => sum + Number(match[1]), 0);
  return { tests: Number(tests), skipped };
}

export type TestCaseStatus = "passed" | "failed" | "skipped";
export interface TestCase {
  name: string; // as the report names it; `classname` is kept apart so a criterion can name either
  classname: string;
  status: TestCaseStatus;
}

const MAX_TEST_CASES = 20_000;
const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

// The test cases of a JUnit report. A case with a <failure>, <error> or <skipped> child did not pass.
export function junitCases(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const attributes = Object.fromEntries(
      [...(match[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [
        a[1],
        unescapeXml(a[2] ?? ""),
      ]),
    );
    if (attributes.name === undefined) continue;
    const body = match[2] ?? "";
    const status: TestCaseStatus = /<(failure|error)\b/.test(body)
      ? "failed"
      : /<skipped\b/.test(body)
        ? "skipped"
        : "passed";
    cases.push({
      name: attributes.name,
      classname: attributes.classname ?? "",
      status,
    });
    if (cases.length >= MAX_TEST_CASES) break;
  }
  return cases;
}

export interface RunGateInput {
  repoDir: string;
  sandbox: GateSandbox;
  ref: string; // what to test: a branch or a candidate commit
  commitSha: string; // the commit `ref` points at; the GateResult is cached under it
  configSha: string; // where the gate configuration is read from
  baseline?: TestCounts; // counts of the last passing gate on the integration branch
  cache?: GateCache;
  // Aborted when the job is lost: no further command is started (one already running cannot be interrupted).
  signal?: AbortSignal;
}

export async function runGate(input: RunGateInput): Promise<GateOutcome> {
  const cached = input.cache?.get(
    input.commitSha,
    input.configSha,
    input.baseline,
  );
  if (cached) return cached;

  const config = readGateConfig(input.repoDir, input.configSha);
  const steps = [
    ...(config.setup
      ? [
          {
            name: "setup",
            run: config.setup,
            timeoutSeconds: SETUP_TIMEOUT_SECONDS,
          },
        ]
      : []),
    ...config.commands,
  ];
  const junitPath =
    config.commands.find((c) => c.junit)?.junit ?? DEFAULT_JUNIT_PATH;

  const session = await input.sandbox.open(input.ref);
  const outcomes: StepOutcome[] = [];
  const stepLogs: Record<string, string> = {};
  let junit: string | undefined;
  try {
    for (const step of steps) {
      if (input.signal?.aborted) break;
      const started = Date.now();
      const result = await session.exec(step.run, {
        timeoutSeconds: step.timeoutSeconds,
      });
      outcomes.push({
        name: step.name,
        exitCode: result.exitCode,
        ms: Date.now() - started,
      });
      stepLogs[step.name] = result.output;
      if (result.exitCode !== 0) break; // the first failure stops the run
    }
    if (outcomes.every((s) => s.exitCode === 0))
      junit = await session.readFile(junitPath);
  } finally {
    await session.close();
  }

  const reasons: string[] = [];
  for (const step of outcomes) {
    if (step.exitCode !== 0)
      reasons.push(`${step.name} failed (exit ${step.exitCode})`);
  }
  let counts: TestCounts | undefined;
  if (reasons.length === 0) {
    counts = junit === undefined ? undefined : junitCounts(junit);
    if (!counts) {
      reasons.push("no JUnit results");
    } else if (input.baseline) {
      if (counts.tests < input.baseline.tests) {
        reasons.push(
          `fewer tests than the baseline: ${counts.tests} < ${input.baseline.tests}`,
        );
      }
      if (counts.skipped > input.baseline.skipped) {
        reasons.push(
          `more skipped tests than the baseline: ${counts.skipped} > ${input.baseline.skipped}`,
        );
      }
    }
  }

  const outcome: GateOutcome = {
    pass: reasons.length === 0,
    reasons,
    commitSha: input.commitSha,
    configSha: input.configSha,
    ...(counts ? { counts } : {}),
    ...(counts && junit !== undefined ? { testCases: junitCases(junit) } : {}),
    steps: outcomes,
    failureLog:
      reasons.length > 0 ? failureLog(outcomes, stepLogs, reasons) : "",
    stepLogs,
    ...(junit === undefined ? {} : { junit }),
  };
  input.cache?.remember(outcome, input.baseline);
  return outcome;
}

// The tail of the failing step's output, then the verdict: this is what gate-fix reads.
export function failureLog(
  steps: StepOutcome[],
  logs: Record<string, string>,
  reasons: string[],
): string {
  const failed = steps.find((s) => s.exitCode !== 0);
  const tail = failed
    ? `# ${failed.name} failed (exit ${failed.exitCode})\n\n${(logs[failed.name] ?? "").trimEnd().split("\n").slice(-FAILURE_LOG_LINES).join("\n")}\n\n`
    : "";
  return `${tail}## Gate verdict\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n`;
}

// Results by commit: the same commit under the same configuration is not gated twice (a re-run after a worker
// restart, or a candidate that equals a branch already gated). Only passing results are reused.
export class GateCache {
  private readonly results = new Map<string, GateOutcome>();

  // A pass is only reusable against the same baseline: counts that were enough then may not be now.
  private key(commitSha: string, configSha: string, baseline?: TestCounts) {
    return JSON.stringify([commitSha, configSha, baseline ?? null]);
  }

  get(
    commitSha: string,
    configSha: string,
    baseline?: TestCounts,
  ): GateOutcome | undefined {
    return this.results.get(this.key(commitSha, configSha, baseline));
  }

  remember(outcome: GateOutcome, baseline?: TestCounts): void {
    if (outcome.pass) {
      this.results.set(
        this.key(outcome.commitSha, outcome.configSha, baseline),
        outcome,
      );
    }
  }
}
