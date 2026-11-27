import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failedCasesOf,
  GATE_CONFIG_PATH,
  GateConfigError,
  type GateRecords,
  type GateSandbox,
  GateSetupError,
  git,
  gitOrThrow,
  runGate,
} from "@afk/pipeline";
import { BASELINE_GATE_JOB } from "@afk/shared";
import type { RepoStore } from "./repos.ts";
import { InfrastructureError } from "./stages/common.ts";

export { BASELINE_GATE_JOB };

export interface BaselineGateTask {
  repo: { name: string; url: string; defaultBranch: string };
  sha?: string;
  specId: number;
}

export interface BaselineGateResult {
  stage: "baseline-gate";
  pass: boolean;
  reasons: string[];
  steps: string[];
  failedStep?: string;
  tests?: number;
  skipped?: number;
  log?: string;
  failingTests?: string[];
  gate?: {
    commitSha: string;
    configSha: string;
    treeSha: string;
    configBlob: string;
    commandResults: { name: string; exitCode: number; ms: number }[];
    testsTotal?: number;
    testsSkipped?: number;
    testCases?: {
      name: string;
      classname: string;
      status: "passed" | "failed" | "skipped";
      file?: string;
      message?: string;
      flaky?: boolean;
    }[];
  };
}

const LOG_TAIL_LINES = 60;

export async function runBaselineGate(
  deps: {
    repos: Pick<RepoStore, "ensure" | "fetchObject" | "fetchBranch">;
    makeGateSandbox(dir: string): GateSandbox;
    records?: GateRecords;
  },
  task: BaselineGateTask,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<BaselineGateResult> {
  const { repo } = task;
  const refused = (reason: string): BaselineGateResult => {
    log(`baseline gate: ${reason}`);
    return {
      stage: BASELINE_GATE_JOB,
      pass: false,
      reasons: [reason],
      steps: [],
    };
  };
  const dir = await deps.repos.ensure(repo.name, repo.url, repo.defaultBranch);
  let sha = task.sha;
  if (!sha) {
    if (!(await deps.repos.fetchBranch(dir, repo.url, repo.defaultBranch)))
      return refused(
        `${repo.defaultBranch} is not on the repo's origin: cannot run the baseline gate`,
      );
    sha = gitOrThrow(dir, ["rev-parse", `refs/heads/${repo.defaultBranch}`]);
  } else {
    await deps.repos.fetchObject(dir, repo.url, sha);
  }
  if (git(dir, ["cat-file", "-e", `${sha}:${GATE_CONFIG_PATH}`]).code !== 0)
    return refused(`${sha} has no ${GATE_CONFIG_PATH}`);

  const scratch = mkdtempSync(join(tmpdir(), "afk-baseline-"));
  try {
    const work = join(scratch, repo.name);
    gitOrThrow(scratch, ["clone", "--quiet", "--no-checkout", dir, work]);
    gitOrThrow(work, [
      "update-ref",
      "--no-deref",
      "HEAD",
      gitOrThrow(work, ["rev-parse", "HEAD"]),
    ]);
    gitOrThrow(work, ["fetch", "--quiet", "--no-tags", dir, sha]);
    let outcome: Awaited<ReturnType<typeof runGate>>;
    try {
      outcome = await runGate({
        repoDir: dir,
        sandbox: deps.makeGateSandbox(work),
        ref: sha,
        commitSha: sha,
        configSha: sha,
        ...(deps.records ? { records: deps.records } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof GateSetupError)
        throw new InfrastructureError(error.message);
      if (error instanceof GateConfigError)
        throw new InfrastructureError(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return refused(
        `${GATE_CONFIG_PATH} on ${sha.slice(0, 12)} is not valid: ${message.slice(0, 400)}`,
      );
    }
    const failed = outcome.steps.find((step) => step.exitCode !== 0);
    const tail = failed
      ? (outcome.stepLogs[failed.name] ?? "")
          .split("\n")
          .slice(-LOG_TAIL_LINES)
          .join("\n")
      : undefined;
    const failedCases = failedCasesOf(outcome.testCases);
    const failingTests = failedCases?.map((item) =>
      item.classname ? `${item.classname} ${item.name}` : item.name,
    );
    log(
      `baseline gate on ${sha.slice(0, 12)}: ${outcome.pass ? "passed" : `failed (${outcome.reasons.join("; ")})`}`,
    );
    return {
      stage: BASELINE_GATE_JOB,
      pass: outcome.pass,
      reasons: outcome.reasons,
      steps: outcome.steps.map((step) => step.name),
      ...(failed ? { failedStep: failed.name } : {}),
      ...(outcome.counts
        ? { tests: outcome.counts.tests, skipped: outcome.counts.skipped }
        : {}),
      ...(tail !== undefined ? { log: tail } : {}),
      ...(failingTests ? { failingTests } : {}),
      gate: {
        commitSha: outcome.commitSha,
        configSha: outcome.configSha,
        treeSha: outcome.treeSha,
        configBlob: outcome.configBlob,
        commandResults: outcome.steps,
        ...(outcome.counts
          ? {
              testsTotal: outcome.counts.tests,
              testsSkipped: outcome.counts.skipped,
            }
          : {}),
        ...(outcome.testCases ? { testCases: outcome.testCases } : {}),
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
