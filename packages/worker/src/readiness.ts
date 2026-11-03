import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE_CONFIG_PATH,
  type GateSandbox,
  git,
  gitOrThrow,
  runGate,
} from "@afk/pipeline";
import type { RepoStore } from "./repos.ts";

// `plat repo check` (operations manual 1.3): a repo being set up for the platform pushes a branch, and a worker
// runs the repo's gate on it exactly as it gates a ticket, in the platform's sandbox, with the gates.yaml of that
// branch. Nothing is pushed and no ticket is involved; the answer goes back to the person who asked.

import type { ReadinessTask } from "@afk/shared";

export type { ReadinessTask };

export const READINESS_GATE_JOB = "readiness-gate";

export interface ReadinessGateResult {
  stage: "readiness-gate";
  pass: boolean;
  reasons: string[];
  steps: string[]; // the commands that ran, in order
  failedStep?: string;
  tests?: number;
  skipped?: number;
  log?: string; // the end of the failing command's output
}

const LOG_TAIL_LINES = 60;

export async function runReadinessGate(
  deps: {
    repos: Pick<RepoStore, "ensure" | "fetchBranch">;
    makeGateSandbox(dir: string): GateSandbox;
  },
  task: ReadinessTask,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<ReadinessGateResult> {
  const { repo, branch } = task;
  const refused = (reason: string): ReadinessGateResult => {
    log(`readiness gate on ${branch}: ${reason}`);
    return {
      stage: "readiness-gate",
      pass: false,
      reasons: [reason],
      steps: [],
    };
  };
  const dir = deps.repos.ensure(repo.name, repo.url, repo.defaultBranch);
  if (!deps.repos.fetchBranch(dir, repo.url, branch))
    return refused(`${branch} is not on the repo's origin: push it first`);
  const sha = gitOrThrow(dir, ["rev-parse", `refs/heads/${branch}`]);
  if (git(dir, ["cat-file", "-e", `${sha}:${GATE_CONFIG_PATH}`]).code !== 0)
    return refused(`${branch} has no ${GATE_CONFIG_PATH}`);

  // The sandbox works in a clone of its own, as a ticket's gate works in a slot.
  const scratch = mkdtempSync(join(tmpdir(), "afk-readiness-"));
  try {
    const work = join(scratch, repo.name);
    gitOrThrow(scratch, ["clone", "--quiet", "--no-checkout", dir, work]);
    gitOrThrow(work, [
      "fetch",
      "--quiet",
      "--no-tags",
      dir,
      `+refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    let outcome: Awaited<ReturnType<typeof runGate>>;
    try {
      outcome = await runGate({
        repoDir: dir,
        sandbox: deps.makeGateSandbox(work),
        ref: branch,
        commitSha: sha,
        configSha: sha,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // readGateConfig refuses a gates.yaml that does not match the format
      const message = error instanceof Error ? error.message : String(error);
      return refused(
        `${GATE_CONFIG_PATH} on ${branch} is not valid: ${message.slice(0, 400)}`,
      );
    }
    const failed = outcome.steps.find((step) => step.exitCode !== 0);
    const tail = failed
      ? (outcome.stepLogs[failed.name] ?? "")
          .split("\n")
          .slice(-LOG_TAIL_LINES)
          .join("\n")
      : undefined;
    log(
      `readiness gate on ${branch}: ${outcome.pass ? "passed" : `failed (${outcome.reasons.join("; ")})`}`,
    );
    return {
      stage: "readiness-gate",
      pass: outcome.pass,
      reasons: outcome.reasons,
      steps: outcome.steps.map((step) => step.name),
      ...(failed ? { failedStep: failed.name } : {}),
      ...(outcome.counts
        ? { tests: outcome.counts.tests, skipped: outcome.counts.skipped }
        : {}),
      ...(tail !== undefined ? { log: tail } : {}),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
