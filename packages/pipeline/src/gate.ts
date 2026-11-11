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
  exec(command: string): Promise<{ exitCode: number; output: string }>;
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
  treeSha: string; // what the gate is about: the same tree under the same configuration gives the same result
  configBlob: string; // the gates.yaml the commands came from, by content
  reusedFrom?: string; // the commit whose stored result was used instead of running the commands
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

// What the platform remembers of earlier gates in the repo (gate_results), asked for by the worker.
export interface StoredGate {
  commitSha: string;
  steps: StepOutcome[];
  counts: TestCounts;
  testCases?: TestCase[];
}
export interface GateRecords {
  // A gate of the same tree under the same gates.yaml whose commands all passed and that wrote a JUnit report.
  findPassed(
    treeSha: string,
    configBlob: string,
  ): Promise<StoredGate | undefined>;
  // The counts of a commit whose gate ran every command to success; undefined when it has none.
  countsAt(commitSha: string): Promise<TestCounts | undefined>;
}

const SETUP_LOG_LINES = 40;

// The setup step (installing dependencies, starting a database) failed: a problem of the sandbox or the network,
// not of the change, so the job is tried again rather than handed to an agent to fix.
export class GateSetupError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, output: string) {
    const tail = output
      .trimEnd()
      .split("\n")
      .slice(-SETUP_LOG_LINES)
      .join("\n");
    super(`gate setup failed (exit ${exitCode})\n${tail}`);
    this.name = "GateSetupError";
    this.exitCode = exitCode;
  }
}
export interface RunGateInput {
  repoDir: string;
  sandbox: GateSandbox;
  ref: string; // what to test: a branch or a candidate commit
  commitSha: string; // the commit `ref` points at
  configSha: string; // where the gate configuration is read from
  baseline?: TestCounts; // the test counts the change is held to
  records?: GateRecords; // earlier results: a pass on the same tree and configuration is not run again
  // Aborted when the job is lost: no further command is started (one already running cannot be interrupted).
  signal?: AbortSignal;
}

export async function runGate(input: RunGateInput): Promise<GateOutcome> {
  const config = readGateConfig(input.repoDir, input.configSha);
  const treeSha = gitOrThrow(input.repoDir, [
    "rev-parse",
    `${input.commitSha}^{tree}`,
  ]);
  const configBlob = gitOrThrow(input.repoDir, [
    "rev-parse",
    `${input.configSha}:${GATE_CONFIG_PATH}`,
  ]);
  const about = {
    commitSha: input.commitSha,
    configSha: input.configSha,
    treeSha,
    configBlob,
  };

  // The commands depend only on the tree and the configuration: a stored pass stands, judged against today's baseline.
  const stored = await input.records?.findPassed(treeSha, configBlob);
  if (stored) {
    const reasons = countReasons(stored.counts, input.baseline);
    return {
      ...about,
      pass: reasons.length === 0,
      reasons,
      reusedFrom: stored.commitSha,
      counts: stored.counts,
      ...(stored.testCases ? { testCases: stored.testCases } : {}),
      steps: stored.steps,
      failureLog:
        reasons.length > 0 ? failureLog(stored.steps, {}, reasons) : "",
      stepLogs: {},
    };
  }

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
      // sandbox.exec has no timeout of its own: the command is wrapped
      const result = await session.exec(
        `timeout ${step.timeoutSeconds} sh -c ${shellQuote(step.run)}`,
      );
      if (step.name === "setup" && config.setup && result.exitCode !== 0)
        throw new GateSetupError(result.exitCode, result.output);
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
    if (!counts) reasons.push("no JUnit results");
    else reasons.push(...countReasons(counts, input.baseline));
  }

  return {
    ...about,
    pass: reasons.length === 0,
    reasons,
    ...(counts ? { counts } : {}),
    ...(counts && junit !== undefined ? { testCases: junitCases(junit) } : {}),
    steps: outcomes,
    failureLog:
      reasons.length > 0 ? failureLog(outcomes, stepLogs, reasons) : "",
    stepLogs,
    ...(junit === undefined ? {} : { junit }),
  };
}

// The number of tests may not shrink and the number of skipped tests may not grow.
function countReasons(counts: TestCounts, baseline?: TestCounts): string[] {
  if (!baseline) return [];
  const reasons: string[] = [];
  if (counts.tests < baseline.tests)
    reasons.push(
      `fewer tests than the baseline: ${counts.tests} < ${baseline.tests}`,
    );
  if (counts.skipped > baseline.skipped)
    reasons.push(
      `more skipped tests than the baseline: ${counts.skipped} > ${baseline.skipped}`,
    );
  return reasons;
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
