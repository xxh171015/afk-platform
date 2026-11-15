import {
  git,
  gitOrThrow,
  readGateConfig,
  reviewSources,
  runReview,
} from "@afk/pipeline";
import { listedDecisionsForReview, modelFor } from "@afk/shared";
import { fetchContracts } from "../contracts.ts";
import { fetchDomain } from "../domain.ts";
import { sanitizeRawLine } from "../raw-log.ts";
import type { Slot } from "../slots.ts";
import {
  agentFacts,
  billedFacts,
  branchBase,
  bringBranches,
  type ExecutorDeps,
  InfrastructureError,
  JobLostError,
  publishedTip,
  publishLocalAhead,
  runIdOf,
  type StageContext,
  type StageOutcomeBody,
  snapshotRefs,
  subjectLabel,
  tip,
} from "./common.ts";

export async function review(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = bundle.agentBranch;
  const stage = bundle.job.stage as "review" | "final-review";
  if (stage === "review") {
    await publishLocalAhead(deps, context, mainDir, agent);
  }
  // A ticket is reviewed against where its branch left the integration branch; a whole spec against where the
  // integration branch left the default branch.
  const baseSha =
    stage === "final-review"
      ? gitOrThrow(mainDir, [
          "merge-base",
          bundle.repo.defaultBranch,
          bundle.integrationBranch as string,
        ])
      : branchBase(mainDir, bundle.integrationBranch as string, agent);
  const reviewed =
    stage === "final-review"
      ? tip(mainDir, bundle.integrationBranch as string)
      : await publishedTip(mainDir, agent, context.signal);
  // The slot needs the reviewed commit before runReview can point each axis's branch at it.
  const carrier = `review-sha/${subjectLabel(bundle)}`;
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${carrier}`, reviewed]);
  try {
    bringBranches(slot, mainDir, [carrier]);
    const domainFiles = await fetchDomain(
      deps.repos,
      bundle.domain,
      bundle.repo.name,
    );
    const contracts = bundle.contracts.length
      ? await fetchContracts(deps.repos, bundle.contracts)
      : [];
    const { refs, refShas } = await snapshotRefs(deps, bundle);
    const integration = bundle.integrationBranch;
    const specModel = modelFor({
      stage,
      axis: "spec",
      stageModels: bundle.stageModels,
      defaultModel: bundle.model,
      workerModel: deps.model,
    });
    const standardsModel = modelFor({
      stage,
      axis: "standards",
      stageModels: bundle.stageModels,
      defaultModel: bundle.model,
      workerModel: deps.model,
    });
    const assembled = await runReview({
      stage,
      ticketReview: bundle.ticketReview,
      repoDir: slot.dir,
      reviewedSha: reviewed,
      baseBranch: bundle.integrationBranch as string,
      subjectLabel: subjectLabel(bundle),
      context: {
        bundle,
        run: { runId: runIdOf(bundle), baseSha, branch: agent },
        ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
        ...(bundle.failedCases?.length
          ? { failedCases: bundle.failedCases }
          : {}),
        ...(bundle.review ? { review: bundle.review } : {}),
        ...(bundle.contracts.length ? { contracts } : {}),
        ...(domainFiles ? { domain: domainFiles } : {}),
        ...(integration
          ? { gate: readGateConfig(mainDir, tip(mainDir, integration)) }
          : {}),
      },
      runner: deps.makeAgentRunner(slot.dir, runIdOf(bundle)),
      idleSeconds: bundle.limits.runIdleSeconds,
      wallClockMs: bundle.limits.runWallclockSeconds * 1000,
      models: {
        ...(specModel ? { spec: specModel } : {}),
        ...(standardsModel ? { standards: standardsModel } : {}),
      },
      ...(refs.length ? { refs } : {}),
      listedDecisions: listedDecisionsForReview(
        bundle.decisionLog,
        stage === "final-review" ? "spec" : "ticket",
      ),
      signal: context.signal,
      onRawLine: (line) =>
        context.logRaw(sanitizeRawLine(line, deps.secrets ?? [])),
      ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the review");
    if (assembled.classification.kind === "infrastructure-failure") {
      const [first, ...others] = assembled.axes;
      throw new InfrastructureError(
        assembled.classification.error,
        first ? { ...billedFacts(first.run), axis: first.axis } : undefined,
        others.map((r) => ({ ...billedFacts(r.run), axis: r.axis })),
      );
    }
    log(`${stage}: ${assembled.classification.outcome}`);
    for (const { axis, run } of assembled.axes)
      if (run.commits.length > 0)
        log(
          `review: WARNING the ${axis} review made ${run.commits.length} commit(s); it should only read`,
        );
    const factsOf = (row: (typeof assembled.axes)[number]) => {
      const sources = reviewSources(row.run.output);
      return {
        axis: row.axis,
        run: {
          // what this axis came to on its own; the stage's outcome is the two put together
          result: row.result,
          branch: agent,
          baseSha,
          commits: row.run.commits,
          durationMs: row.run.durationMs,
          ...agentFacts(
            deps,
            { ...(row.model ? { model: row.model } : {}) },
            row.prompt,
            row.run,
          ),
          ...(refs.length ? { refShas } : {}),
          output: row.run.output ?? { error: row.run.error },
          ...(sources ? { sources } : {}),
        },
        findings: row.findings,
      };
    };
    const [first, ...others] = assembled.axes.map(factsOf);
    return {
      stage,
      outcome: assembled.classification.outcome,
      // the first axis is the job's own Run; any other axis is recorded beside it
      run: { ...first?.run, axis: first?.axis },
      findings: first?.findings ?? [],
      extraRuns: others.map((r) => ({
        run: { ...r.run, axis: r.axis },
        findings: r.findings,
      })),
    };
  } finally {
    git(mainDir, ["update-ref", "-d", `refs/heads/${carrier}`]);
    git(slot.dir, ["update-ref", "-d", `refs/heads/${carrier}`]);
  }
}
