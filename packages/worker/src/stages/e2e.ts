import { git, gitOrThrow, runE2e } from "@afk/pipeline";
import type { Slot } from "../slots.ts";
import {
  bringBranches,
  type ExecutorDeps,
  JobLostError,
  runIdOf,
  type StageContext,
  type StageOutcomeBody,
  subjectLabel,
  tip,
  withEnvironment,
} from "./common.ts";

// The last stage of an integration ticket: its repo at the head of the integration branch, in a fresh sandbox on the
// network of a fresh integration environment, running the repo's e2e. A deterministic step, not an agent run: the
// JUnit report is the verdict. An e2e that fails is a result.
export async function e2e(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const integration = bundle.integrationBranch as string;
  const head = tip(mainDir, integration);

  return withEnvironment(deps, context, "e2e", async (environment) => {
    // The e2e runs on a branch of its own that is gone again afterwards, like a gate.
    const branch = `e2e/${subjectLabel(bundle)}`;
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, head]);
    try {
      bringBranches(slot, mainDir, [branch]);
      const outcome = await runE2e({
        repoDir: mainDir,
        sandbox: deps.makeGateSandbox(slot.dir, runIdOf(bundle)),
        ref: branch,
        commitSha: head,
        configSha: head,
        network: environment.network,
        env: environment.env,
        signal: context.signal,
      });
      if (context.signal.aborted)
        throw new JobLostError("the lease was lost during the e2e");
      for (const step of outcome.steps)
        log(`e2e: ${step.name} exit ${step.exitCode} (${step.ms} ms)`);
      for (const [name, text] of Object.entries(outcome.stepLogs))
        log(`--- ${name} ---\n${text}`);
      return {
        stage: "e2e",
        outcome: outcome.pass ? "passed" : "failed",
        run: {
          branch: integration,
          headSha: head,
          // the repos the environment was built from; the e2e's own repo is the head SHA
          refShas: environment.shas,
          envUpMs: environment.upMs,
          ...(outcome.counts
            ? {
                testsTotal: outcome.counts.tests,
                testsFailed: outcome.counts.failed,
              }
            : {}),
          output: {
            failureLog: outcome.failureLog,
            reasons: outcome.reasons,
            failingTests: outcome.failingTests,
          },
        },
        gate: {
          kind: "e2e",
          commitSha: head,
          configSha: head,
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
      git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  });
}
