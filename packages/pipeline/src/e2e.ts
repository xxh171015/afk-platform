import {
  failureLog,
  type GateSandbox,
  junitCases,
  junitCounts,
  readGateConfig,
  type StepOutcome,
  shellQuote,
  type TestCase,
} from "./gate.ts";

// An integration ticket's e2e: the ticket's repo at the head of its integration branch, in a fresh sandbox on
// the integration environment's network, running the repo's own `npm run e2e`. The JUnit report is the verdict
// (docs/specs/m2-platform.md「联调」).

export const E2E_COMMAND = "npm run e2e";
export const E2E_JUNIT_PATH = "reports/e2e-junit.xml";
// The wall clock of the e2e command, not counted as agent time; the repo's setup has the gate's own limit.
export const E2E_TIMEOUT_SECONDS = 15 * 60;
const SETUP_TIMEOUT_SECONDS = 600;

export interface E2eCounts {
  tests: number;
  skipped: number;
  failed: number;
}

export interface E2eOutcome {
  pass: boolean;
  reasons: string[];
  commitSha: string; // the commit of the repo the e2e ran on
  configSha: string;
  counts?: E2eCounts;
  testCases?: TestCase[];
  failingTests: string[];
  steps: StepOutcome[];
  failureLog: string;
  stepLogs: Record<string, string>;
}

export interface RunE2eInput {
  repoDir: string;
  sandbox: GateSandbox;
  ref: string; // the branch or commit to test
  commitSha: string;
  configSha: string; // where the repo's setup is read from (gates.yaml)
  network: string;
  env: Record<string, string>;
  command?: string; // the e2e command; the repo's `npm run e2e` unless a test says otherwise
  signal?: AbortSignal; // aborted when the job is lost: no further command is started
}

export async function runE2e(input: RunE2eInput): Promise<E2eOutcome> {
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
    {
      name: "e2e",
      run: input.command ?? E2E_COMMAND,
      timeoutSeconds: E2E_TIMEOUT_SECONDS,
    },
  ];

  const session = await input.sandbox.open(input.ref, {
    network: input.network,
    env: input.env,
  });
  const outcomes: StepOutcome[] = [];
  const stepLogs: Record<string, string> = {};
  let junit: string | undefined;
  try {
    for (const step of steps) {
      if (input.signal?.aborted) break;
      const started = Date.now();
      const result = await session.exec(
        `timeout ${step.timeoutSeconds} sh -c ${shellQuote(step.run)}`,
      );
      outcomes.push({
        name: step.name,
        exitCode: result.exitCode,
        ms: Date.now() - started,
      });
      stepLogs[step.name] = result.output;
      if (result.exitCode !== 0 && step.name === "setup") break;
    }
    // A test runner that found failures writes its report and exits non-zero: the report is read either way.
    if (outcomes.some((s) => s.name === "e2e"))
      junit = await session.readFile(E2E_JUNIT_PATH);
  } finally {
    await session.close();
  }

  const reasons: string[] = [];
  for (const step of outcomes) {
    if (step.exitCode !== 0)
      reasons.push(`${step.name} failed (exit ${step.exitCode})`);
  }
  const basic = junit === undefined ? undefined : junitCounts(junit);
  const testCases = junit === undefined ? undefined : junitCases(junit);
  const failingTests = (testCases ?? [])
    .filter((c) => c.status === "failed")
    .map((c) => c.name);
  let counts: E2eCounts | undefined;
  if (outcomes.some((s) => s.name === "e2e")) {
    if (!basic) {
      reasons.push("no JUnit results");
    } else {
      counts = { ...basic, failed: failingTests.length };
      if (basic.tests === 0) reasons.push("the e2e report has no tests");
      if (failingTests.length > 0)
        reasons.push(
          `${failingTests.length} of ${basic.tests} e2e tests failed`,
        );
    }
  } else if (reasons.length === 0) {
    reasons.push("the job was lost before the e2e ran");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    commitSha: input.commitSha,
    configSha: input.configSha,
    ...(counts ? { counts } : {}),
    ...(testCases ? { testCases } : {}),
    failingTests,
    steps: outcomes,
    failureLog:
      reasons.length > 0
        ? `${failureLog(outcomes, stepLogs, reasons)}${failingTests.length ? `\n## Failing tests\n${failingTests.map((t) => `- ${t}`).join("\n")}\n` : ""}`
        : "",
    stepLogs,
  };
}
