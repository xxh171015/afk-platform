import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { gitOrThrow } from "./exec.ts";

// The gate: a repo's own checks, run in a fresh sandbox on a commit (docs/design.md「门禁」). The configuration
// is read from a trusted commit, never from the branch under test; commands run in order; a failed test command
// is rerun once on the same commit, and only then does a failure stop the run; when JUnit names are available the
// set of classname+name may not shrink, otherwise the number of tests may not shrink and the number of skipped
// tests may not grow.

export const GATE_CONFIG_PATH = ".sandcastle/gates.yaml";
export const FAILURE_LOG_LINES = 200;
export const FAILURE_MESSAGE_LINES = 8;
const SETUP_TIMEOUT_SECONDS = 600;
const DEFAULT_JUNIT_PATH = "reports/junit.xml";

const GateCommandSchema = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().min(1),
    junit: z.string().min(1).optional(),
    // Argv prefix for a per-file rerun: filenames are appended as their own arguments, never interpolated into a shell.
    rerunFiles: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const GeneratedGroupSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    run: z.string().min(1),
  })
  .strict();

const GateConfigSchema = z
  .object({
    version: z.number().int().optional(),
    setup: z.string().min(1).optional(),
    commands: z.array(GateCommandSchema).min(1),
    generated: z.array(GeneratedGroupSchema).min(1).optional(),
    // Default: compare JUnit classname+name when both sides have names. `counts` keeps the old totals.
    testCompare: z.enum(["names", "counts"]).optional(),
    // Extra test/build config paths that trigger Recheck, on top of the pipeline defaults.
    recheckConfig: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type GateConfig = z.infer<typeof GateConfigSchema>;

// A sandbox that is thrown away afterwards. The only module that talks to Sandcastle implements this (#29).
export interface SandboxSession {
  exec(
    command: string | readonly string[],
    options: { timeoutSeconds: number },
  ): Promise<{ exitCode: number; output: string }>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
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

export type TestName = { classname: string; name: string };

export interface GateBaseline extends TestCounts {
  names?: TestName[];
}

export interface MergeTestNames {
  base: TestName[];
  ours: TestName[];
  theirs: TestName[];
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
  removedTests?: TestName[]; // names the baseline had that this report does not, after approvals
  steps: StepOutcome[];
  failureLog: string; // for gate-fix and merge-fix; empty when the gate passed
  stepLogs: Record<string, string>; // full logs per step, for the run log
  junit?: string;
}

// `timeout N cmd` only times the first word, so the whole command line goes to a shell as one argument.
export const shellQuote = (text: string) =>
  `'${text.replaceAll("'", `'\\''`)}'`;

export const GATE_CONFIG_BRIEF = "门禁配置无效";

const GATE_FIELD_LABELS: Record<string, string> = {
  version: "version",
  setup: "setup",
  commands: "commands",
  generated: "generated",
  name: "name",
  run: "run",
  timeoutSeconds: "timeoutSeconds",
  junit: "junit",
  rerunFiles: "rerunFiles",
  paths: "paths",
};

function describeGateConfigIssue(error: z.ZodError): string {
  const pieces: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.join("、");
      pieces.push(
        `文件 ${GATE_CONFIG_PATH} 中有不认识的字段：${keys}。允许的顶层字段：version、setup、commands、generated；命令里允许：name、run、timeoutSeconds、junit、rerunFiles；generated 里允许：paths、run`,
      );
      continue;
    }
    const label = GATE_FIELD_LABELS[path] ?? path;
    if (issue.code === "invalid_type" && issue.expected === "array") {
      pieces.push(`缺少必填字段 ${label}`);
      continue;
    }
    pieces.push(`${label}: ${issue.message}`);
  }
  return pieces.join("；") || error.message;
}

export class GateConfigError extends Error {
  constructor(detail: string) {
    super(`${GATE_CONFIG_BRIEF}: ${detail}`);
    this.name = "GateConfigError";
  }
}

export function readGateConfig(repoDir: string, configSha: string): GateConfig {
  const text = gitOrThrow(repoDir, [
    "show",
    `${configSha}:${GATE_CONFIG_PATH}`,
  ]);
  try {
    return GateConfigSchema.parse(parseYaml(text));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new GateConfigError(describeGateConfigIssue(error));
    }
    throw error;
  }
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
  file?: string; // JUnit `file` attribute, used to rerun only the failed files
  message?: string; // first lines of <failure> / <error>, for gate-fix
  flaky?: boolean; // failed the first run and passed the same-commit rerun
}

export type FailedCase = {
  name: string;
  classname: string;
  file?: string;
  message?: string;
};

export function failedCasesOf(
  cases: TestCase[] | undefined,
): FailedCase[] | undefined {
  const failed: FailedCase[] = [];
  for (const c of cases ?? []) {
    if (c.status !== "failed") continue;
    failed.push({
      name: c.name,
      classname: c.classname,
      ...(c.file ? { file: c.file } : {}),
      ...(c.message ? { message: c.message } : {}),
    });
  }
  return failed.length > 0 ? failed : undefined;
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
    const message = status === "failed" ? failureMessage(body) : undefined;
    cases.push({
      name: attributes.name,
      classname: attributes.classname ?? "",
      status,
      ...(attributes.file ? { file: attributes.file } : {}),
      ...(message ? { message } : {}),
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
  baseline?: GateBaseline; // the test counts and names the change is held to
  // Merge candidate: names at the merge-base, the integration tip, and the incoming tip.
  mergeNames?: MergeTestNames;
  approvedRemoved?: TestName[]; // names a person has allowed this ticket (or this wrap-up) to drop
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
    const judged = judgeBaseline(
      config,
      stored.counts,
      stored.testCases,
      input,
    );
    return {
      ...about,
      pass: judged.reasons.length === 0,
      reasons: judged.reasons,
      reusedFrom: stored.commitSha,
      counts: stored.counts,
      ...(stored.testCases ? { testCases: stored.testCases } : {}),
      ...(judged.removedTests ? { removedTests: judged.removedTests } : {}),
      steps: stored.steps,
      failureLog:
        judged.reasons.length > 0
          ? failureLog(stored.steps, {}, judged.reasons)
          : "",
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
  let flaky: TestCase[] = [];
  try {
    for (const step of steps) {
      if (input.signal?.aborted) break;
      const started = Date.now();
      let result = await session.exec(step.run, {
        timeoutSeconds: step.timeoutSeconds,
      });
      if (step.name === "setup" && config.setup && result.exitCode !== 0)
        throw new GateSetupError(result.exitCode, result.output);
      if (result.exitCode !== 0 && step.name !== "setup") {
        const retried = await rerunFailedTests(
          session,
          step,
          result,
          input.signal,
        );
        if (retried) {
          result = retried.result;
          junit = retried.junit;
          flaky = retried.flaky;
        }
      }
      outcomes.push({
        name: step.name,
        exitCode: result.exitCode,
        ms: Date.now() - started,
      });
      stepLogs[step.name] = result.output;
      if (result.exitCode !== 0) break; // the first failure that is not a test rerun stops the run
    }
    if (outcomes.every((s) => s.exitCode === 0) && junit === undefined)
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
  let judged: { reasons: string[]; removedTests?: TestName[] } = {
    reasons: [],
  };
  if (reasons.length === 0) {
    counts = junit === undefined ? undefined : junitCounts(junit);
    if (!counts) reasons.push("no JUnit results");
    else {
      judged = judgeBaseline(
        config,
        counts,
        junit === undefined ? undefined : junitCases(junit),
        input,
      );
      reasons.push(...judged.reasons);
    }
  }

  const testCases =
    junit !== undefined ? publishedCases(junitCases(junit), flaky) : undefined;

  return {
    ...about,
    pass: reasons.length === 0,
    reasons,
    ...(counts ? { counts } : {}),
    ...(testCases ? { testCases } : {}),
    ...(judged.removedTests ? { removedTests: judged.removedTests } : {}),
    steps: outcomes,
    failureLog:
      reasons.length > 0 ? failureLog(outcomes, stepLogs, reasons) : "",
    stepLogs,
    ...(junit === undefined ? {} : { junit }),
  };
}

type ExecResult = { exitCode: number; output: string };

type RunnableStep = {
  name: string;
  run: string;
  timeoutSeconds: number;
  junit?: string;
  rerunFiles?: string[];
};

function caseKey(c: { name: string; classname: string }) {
  return `${c.classname}\n${c.name}`;
}

function testFileOf(c: TestCase): string | undefined {
  if (c.file) return c.file;
  const name = c.classname;
  if (name.includes("/") || /\.(?:[cm]?[jt]sx?)$/.test(name)) return name;
  return undefined;
}

function publishedCases(cases: TestCase[], flaky: TestCase[]): TestCase[] {
  const flakyKeys = new Set(flaky.map(caseKey));
  return cases.map((c) => ({
    name: c.name,
    classname: c.classname,
    status: c.status,
    ...(c.file ? { file: c.file } : {}),
    ...(c.status === "failed" && c.message ? { message: c.message } : {}),
    ...(flakyKeys.has(caseKey(c)) ? { flaky: true as const } : {}),
  }));
}

function failureMessage(body: string): string | undefined {
  const block =
    /<(?:failure|error)\b([^>]*)\/>/.exec(body) ??
    /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/.exec(body);
  if (!block) return undefined;
  const attr = /(?:^|\s)message="([^"]*)"/.exec(block[1] ?? "")?.[1];
  const inner = (block[2] ?? "").trim();
  const parts = [
    attr ? unescapeXml(attr) : "",
    inner ? unescapeXml(inner) : "",
  ].filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  return parts
    .join("\n")
    .split("\n")
    .slice(0, FAILURE_MESSAGE_LINES)
    .join("\n");
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function serializeJunit(counts: TestCounts, cases: TestCase[]): string {
  const body = cases
    .map((c) => {
      const attrs = [
        c.file ? `file="${escapeXml(c.file)}"` : "",
        `classname="${escapeXml(c.classname)}"`,
        `name="${escapeXml(c.name)}"`,
      ]
        .filter(Boolean)
        .join(" ");
      if (c.status === "failed") {
        const fail = c.message
          ? `<failure>${escapeXml(c.message)}</failure>`
          : `<failure/>`;
        return `<testcase ${attrs}>${fail}</testcase>`;
      }
      if (c.status === "skipped")
        return `<testcase ${attrs}><skipped/></testcase>`;
      return `<testcase ${attrs}/>`;
    })
    .join("");
  return `<testsuites tests="${counts.tests}"><testsuite name="a" tests="${counts.tests}" skipped="${counts.skipped}">${body}</testsuite></testsuites>`;
}

function mergeJunit(
  rerunXml: string,
  firstCounts: TestCounts,
  firstCases: TestCase[],
): { xml: string; cases: TestCase[]; flaky: TestCase[] } {
  const rerunByKey = new Map(junitCases(rerunXml).map((c) => [caseKey(c), c]));
  const cases = firstCases.map((c) => {
    const next = rerunByKey.get(caseKey(c));
    return next ? { ...c, status: next.status } : c;
  });
  const flaky = firstCases.filter(
    (c) =>
      c.status === "failed" && rerunByKey.get(caseKey(c))?.status === "passed",
  );
  return { xml: serializeJunit(firstCounts, cases), cases, flaky };
}

async function rerunFailedTests(
  session: SandboxSession,
  step: RunnableStep,
  first: ExecResult,
  signal?: AbortSignal,
): Promise<
  { result: ExecResult; junit: string; flaky: TestCase[] } | undefined
> {
  if (signal?.aborted) return undefined;
  const path = step.junit ?? DEFAULT_JUNIT_PATH;
  const firstXml = await session.readFile(path);
  if (firstXml === undefined) return undefined;
  const firstCounts = junitCounts(firstXml);
  const firstCases = junitCases(firstXml);
  const failed = firstCases.filter((c) => c.status === "failed");
  if (!firstCounts || failed.length === 0) return undefined;

  const files = [
    ...new Set(
      failed
        .map(testFileOf)
        .filter((file): file is string => file !== undefined),
    ),
  ];
  const command: string | readonly string[] = step.rerunFiles
    ? [...step.rerunFiles, ...files]
    : step.run;
  const second = await session.exec(command, {
    timeoutSeconds: step.timeoutSeconds,
  });
  const rerunXml = await session.readFile(path);
  const output = `${first.output}\n\n# rerun of failed tests\n${second.output}`;
  if (rerunXml === undefined) {
    return {
      result: {
        exitCode: second.exitCode === 0 ? 1 : second.exitCode,
        output,
      },
      junit: firstXml,
      flaky: [],
    };
  }
  const rerunPath = `${path}.rerun`;
  await session.writeFile(rerunPath, rerunXml);
  const merged = mergeJunit(rerunXml, firstCounts, firstCases);
  await session.writeFile(path, merged.xml);
  const stillFailed = merged.cases.some((c) => c.status === "failed");
  return {
    result: {
      exitCode: second.exitCode !== 0 || stillFailed ? second.exitCode || 1 : 0,
      output,
    },
    junit: merged.xml,
    flaky: merged.flaky,
  };
}

export function testKey(n: TestName): string {
  return `${n.classname}\n${n.name}`;
}

function namesOf(cases: TestCase[] | undefined): TestName[] {
  return (cases ?? []).map((c) => ({ classname: c.classname, name: c.name }));
}

function nameSet(names: TestName[]): Set<string> {
  return new Set(names.map(testKey));
}

function parseTestKey(key: string): TestName {
  const i = key.indexOf("\n");
  return i < 0
    ? { classname: "", name: key }
    : { classname: key.slice(0, i), name: key.slice(i + 1) };
}

function formatTestName(n: TestName): string {
  return n.classname ? `${n.classname} ${n.name}` : n.name;
}

function requiredNames(input: RunGateInput): TestName[] | undefined {
  if (input.mergeNames) {
    const base = nameSet(input.mergeNames.base);
    const ours = nameSet(input.mergeNames.ours);
    const theirs = nameSet(input.mergeNames.theirs);
    const required = new Set<string>();
    for (const k of ours) if (theirs.has(k)) required.add(k);
    for (const k of ours) if (!base.has(k)) required.add(k);
    for (const k of theirs) if (!base.has(k)) required.add(k);
    return [...required].map(parseTestKey);
  }
  return input.baseline?.names;
}

function removedFrom(
  current: TestName[],
  required: TestName[],
  approved: TestName[] | undefined,
): TestName[] {
  const have = nameSet(current);
  const allowed = nameSet(approved ?? []);
  return required.filter((n) => {
    const k = testKey(n);
    return !have.has(k) && !allowed.has(k);
  });
}

function nameReasons(removed: TestName[]): string[] {
  if (removed.length === 0) return [];
  return [`removed tests: ${removed.map(formatTestName).join(", ")}`];
}

function compareByNames(
  config: GateConfig,
  current: TestName[],
  input: RunGateInput,
): boolean {
  if (config.testCompare === "counts") return false;
  if (config.testCompare === "names") return true;
  if (current.length === 0) return false;
  if (input.mergeNames) return true;
  return (input.baseline?.names?.length ?? 0) > 0;
}

// Merge candidate: three-way names when every side is known; otherwise the old totals (names on the
// latest integration baseline would treat a main-side deletion as a missing test).
export function mergeGateCompare(
  baseline: GateBaseline | undefined,
  mergeNames: MergeTestNames | undefined,
): { baseline?: GateBaseline; mergeNames?: MergeTestNames } {
  if (mergeNames) {
    return { ...(baseline ? { baseline } : {}), mergeNames };
  }
  if (!baseline) return {};
  return { baseline: { tests: baseline.tests, skipped: baseline.skipped } };
}

function judgeBaseline(
  config: GateConfig,
  counts: TestCounts,
  cases: TestCase[] | undefined,
  input: RunGateInput,
): { reasons: string[]; removedTests?: TestName[] } {
  const current = namesOf(cases);
  if (compareByNames(config, current, input)) {
    const required = requiredNames(input) ?? [];
    const removedTests = removedFrom(current, required, input.approvedRemoved);
    return {
      reasons: nameReasons(removedTests),
      ...(removedTests.length > 0 ? { removedTests } : {}),
    };
  }
  return { reasons: countReasons(counts, input.baseline) };
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
