import {
  changedFiles,
  checkContractCopies,
  checkProtectedPaths,
  hasRef,
  isAncestor,
} from "@afk/pipeline";
import { fetchContracts } from "../contracts.ts";
import type { Slot } from "../slots.ts";
import {
  branchBase,
  type ExecutorDeps,
  exists,
  gateFacts,
  gateFailureOutput,
  gateOutcomeOf,
  gateRecords,
  InfrastructureError,
  JobLostError,
  logGate,
  publishedTip,
  publishLocalAhead,
  runGateStep,
  runIdOf,
  type StageContext,
  type StageOutcomeBody,
  tip,
} from "./common.ts";

export async function gate(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  await publishLocalAhead(deps, context, mainDir, agent);
  const commitSha = await publishedTip(mainDir, agent, context.signal);
  if (!exists(mainDir, agent))
    throw new InfrastructureError(`${agent} is not there to gate`);
  const baseSha = branchBase(mainDir, integration, agent);

  const changed = changedFiles(mainDir, baseSha, agent);
  const check = checkProtectedPaths({
    changed,
    protectedPaths: bundle.protectedPaths,
    approved: bundle.allowedProtectedPaths,
  });
  if (check.unapproved.length > 0) {
    log(
      `gate: protected paths changed without approval: ${check.unapproved.join(", ")}`,
    );
    return {
      stage: "gate",
      outcome: "protected-path-changed",
      run: {
        branch: agent,
        baseSha,
        output: { unapproved: check.unapproved },
      },
    };
  }

  // A contract ticket writes the contract itself; only the tickets that consume one keep copies of it.
  const copies =
    bundle.ticket?.type === "contract"
      ? []
      : checkContractCopies({
          repoDir: mainDir,
          repo: bundle.repo.name,
          ref: agent,
          base: baseSha,
          contracts: await fetchContracts(deps.repos, bundle.contracts),
        });
  if (copies.length > 0) {
    const detail = copies.map((c) => c.detail).join("\n");
    log(`gate: contract copies are wrong: ${detail}`);
    return {
      stage: "gate",
      outcome: "contract-copy-mismatch",
      run: {
        branch: agent,
        baseSha,
        output: { detail, mismatches: copies },
      },
    };
  }

  // The ticket's branch is held to the newest baseline it already contains. Merges that landed on the integration
  // branch after it branched are not its to answer for; the merge stage gates the combination against the newest.
  const baseline = bundle.gateBaselines.find(
    (b) => hasRef(mainDir, b.sha) && isAncestor(mainDir, b.sha, agent),
  );
  if (!baseline && bundle.gateBaseline)
    log(
      "gate: no earlier merge is part of this branch yet, so the test count is not compared here",
    );

  // The gate configuration comes from the integration branch, not from the ticket's branch.
  const outcome = await runGateStep({
    repoDir: mainDir,
    sandbox: deps.makeGateSandbox(slot.dir, runIdOf(bundle)),
    signal: context.signal,
    ref: agent,
    commitSha,
    configSha: tip(mainDir, integration),
    ...(baseline
      ? {
          baseline: {
            tests: baseline.tests,
            skipped: baseline.skipped,
            ...(baseline.names?.length ? { names: baseline.names } : {}),
          },
        }
      : {}),
    ...(bundle.approvedRemovedTests?.length
      ? { approvedRemoved: bundle.approvedRemovedTests }
      : {}),
    records: gateRecords(deps, context),
  });
  if (context.signal.aborted)
    throw new JobLostError("the lease was lost during the gate");
  logGate(log, outcome);
  return {
    stage: "gate",
    outcome: gateOutcomeOf(outcome),
    run: {
      branch: agent,
      baseSha,
      headSha: outcome.commitSha,
      output: gateFailureOutput(outcome),
    },
    gate: gateFacts(outcome),
  };
}
