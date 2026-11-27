import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDiagnoseRun,
  type DiagnoseOutput,
  DiagnoseOutputSchema,
  git,
  gitOrThrow,
  promptFor,
  writePrompt,
} from "@afk/pipeline";
import type { Slot } from "../slots.ts";
import {
  agentFacts,
  billedFacts,
  bringBranches,
  type ExecutorDeps,
  InfrastructureError,
  JobLostError,
  renderFor,
  runIdOf,
  runOptions,
  type StageContext,
  type StageOutcomeBody,
  snapshotRefs,
  subjectLabel,
  tip,
  withEnvironment,
} from "./common.ts";
import {
  RECOVERED_AFTER_EXIT_NOTE,
  wrapRecoverAfterExit,
} from "./recover-after-exit.ts";

// After a failed e2e: an agent in a fresh integration environment, on the repo at the head of its integration
// branch, finds out which repo is at fault. It only diagnoses: whatever it commits is thrown away with its branch.
export async function diagnose(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const integration = bundle.integrationBranch as string;
  const head = tip(mainDir, integration);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = await renderFor(deps, context, head, tmp, mainDir);
    const given = writePrompt(tmp, promptFor("diagnose"));
    const { refs } = await snapshotRefs(deps, bundle);
    const options = runOptions(deps, context);
    // on a branch of its own that is gone again afterwards, like the e2e's
    const branch = `diagnose/${subjectLabel(bundle)}`;
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, head]);
    try {
      bringBranches(slot, mainDir, [branch]);
      const logDir = join(
        deps.sandboxLogsRoot ?? join(deps.tmpRoot ?? tmpdir(), "sandbox-logs"),
        runIdOf(bundle),
      );
      const resultDir = join(logDir, "afk-out");
      rmSync(resultDir, { recursive: true, force: true });
      mkdirSync(resultDir, { recursive: true });
      const runner = wrapRecoverAfterExit(
        deps.makeAgentRunner(slot.dir, runIdOf(bundle), logDir),
        {
          resultDirFor: () => resultDir,
          onRecovered: () => log(RECOVERED_AFTER_EXIT_NOTE),
        },
      );
      const run = await withEnvironment(
        deps,
        context,
        "diagnose",
        async (environment) => ({
          environment,
          run: await runner.run({
            stage: "diagnose",
            branch,
            baseBranch: integration,
            promptFile: given.promptFile,
            ctxDir,
            refs,
            schema: DiagnoseOutputSchema,
            resultDir,
            placement: { network: environment.network, env: environment.env },
            ...options,
            signal: context.signal,
          }),
        }),
      );
      if (context.signal.aborted)
        throw new JobLostError("the lease was lost during the diagnosis");
      const verdict = classifyDiagnoseRun(run.run);
      if (verdict.kind === "infrastructure-failure")
        throw new InfrastructureError(verdict.error, billedFacts(run.run));
      log(
        `diagnose: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
      );
      if (run.run.commits.length > 0)
        log(
          `diagnose: WARNING the agent made ${run.run.commits.length} commit(s); it should only look, and they are dropped`,
        );
      const output: DiagnoseOutput | undefined = run.run.output;
      return {
        stage: "diagnose",
        outcome: verdict.outcome,
        run: {
          branch: integration,
          headSha: head,
          // the repos the environment was built from; the ticket's own repo is the head SHA
          refShas: run.environment.shas,
          envUpMs: run.environment.upMs,
          durationMs: run.run.durationMs,
          ...agentFacts(deps, options, given.prompt, run.run),
          output: output ?? { error: run.run.error },
        },
        // a repo is only named when the outcome is "diagnosed"
        ...(verdict.outcome === "diagnosed" && output
          ? {
              diagnosis: {
                failingRepo: output.failingRepo,
                evidence: output.evidence,
                failingTests: output.failingTests,
              },
            }
          : {}),
      };
    } finally {
      git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
