import {
  AUTHOR,
  changedFiles,
  checkProtectedPaths,
  type GateBaseline,
  type GateConfig,
  type GateOutcome,
  GateSetupError,
  type GeneratedGroup,
  generatedCommandsNote,
  generatedGroupsFor,
  generatedOnlyConflicts,
  generatedRunCommand,
  git,
  gitOrThrow,
  isAncestor,
  mergeCandidate,
  mergeGateCompare,
  mergeTakingOurs,
  readGateConfig,
  type SandboxSession,
  type TestName,
} from "@afk/pipeline";
import { type Bundle, classifyPushError } from "@afk/shared";
import {
  alignTicketBranch,
  originSha,
  type TicketAlign,
} from "../align-ticket-branch.ts";
import type { Slot } from "../slots.ts";
import {
  bringBranches,
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
  subjectLabel,
  throwPushFailure,
  tip,
  tipAfterFailedPush,
} from "./common.ts";

function namesAt(bundle: Bundle, sha: string): TestName[] | undefined {
  const hit = bundle.gateBaselines.find((b) => b.sha === sha);
  return hit?.names;
}

function mergeNameSets(
  mainDir: string,
  integration: string,
  incoming: string,
  bundle: Bundle,
): { base: TestName[]; ours: TestName[]; theirs: TestName[] } | undefined {
  const found = git(mainDir, ["merge-base", integration, incoming]);
  if (found.code !== 0) return undefined;
  const baseSha = found.stdout.trim();
  const oursSha = tip(mainDir, integration);
  const theirsSha = tip(mainDir, incoming);
  const base = namesAt(bundle, baseSha);
  const ours = namesAt(bundle, oursSha) ?? bundle.gateBaseline?.names;
  const theirs =
    namesAt(bundle, theirsSha) ?? bundle.ticketGateNames ?? undefined;
  if (!base?.length || !ours?.length || !theirs?.length) return undefined;
  return { base, ours, theirs };
}

const MAX_MERGE_ATTEMPTS = 3;

// If the integration branch moved while the candidate was being gated, --force-with-lease refuses the push. The
// answer is not to fail but to fetch and begin again: a new candidate on the new tip, gated again.
export async function merge(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  align: TicketAlign,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  let ticketAlign = align;
  for (let attempt = 1; ; attempt++) {
    const outcome = await mergeOnce(deps, context, mainDir, slot);
    if (!("integrationMoved" in outcome)) return outcome;
    if (attempt === MAX_MERGE_ATTEMPTS) {
      throw new InfrastructureError(
        `could not advance ${bundle.integrationBranch}: it kept moving (${outcome.integrationMoved})`,
      );
    }
    context.log(
      `${bundle.job.stage}: the integration branch moved, fetching and trying again (${outcome.integrationMoved})`,
    );
    await deps.repos.ensure(
      bundle.repo.name,
      bundle.repo.url,
      bundle.repo.defaultBranch,
    );
    ticketAlign = await alignTicketBranch(mainDir, bundle.agentBranch, {
      signal: context.signal,
    });
    context.align = ticketAlign;
  }
}

// The gate on one commit, run on a branch of its own that is gone again afterwards. The baseline, when there is one,
// is what the counts are held to.
async function gateCommit(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  commit: {
    sha: string;
    configSha: string;
    baseline?: GateBaseline;
    mergeNames?: { base: TestName[]; ours: TestName[]; theirs: TestName[] };
    approvedRemoved?: TestName[];
  },
  lostMessage: string,
): Promise<GateOutcome> {
  const gateBranch = `gate/${subjectLabel(context.bundle)}`;
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${gateBranch}`, commit.sha]);
  try {
    bringBranches(slot, mainDir, [gateBranch]);
    const outcome = await runGateStep({
      repoDir: mainDir,
      sandbox: deps.makeGateSandbox(slot.dir, runIdOf(context.bundle)),
      signal: context.signal,
      ref: gateBranch,
      commitSha: commit.sha,
      configSha: commit.configSha,
      ...(commit.baseline ? { baseline: commit.baseline } : {}),
      ...(commit.mergeNames ? { mergeNames: commit.mergeNames } : {}),
      ...(commit.approvedRemoved?.length
        ? { approvedRemoved: commit.approvedRemoved }
        : {}),
      records: gateRecords(deps, context),
    });
    if (context.signal.aborted) throw new JobLostError(lostMessage);
    logGate(context.log, outcome);
    return outcome;
  } finally {
    git(mainDir, ["update-ref", "-d", `refs/heads/${gateBranch}`]);
  }
}

// The gate on a branch head that is already merged, for its test counts. It cannot undo the merge, so a head that
// fails is logged and reported without measurements (the next ticket's own gate will say if something is broken).
// The configuration is read from the head's first parent: what the branch was before the merge.
async function measureMergedHead(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  head: string,
): Promise<GateOutcome | undefined> {
  const firstParent = git(mainDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${head}^1`,
  ]);
  let outcome: GateOutcome;
  try {
    outcome = await gateCommit(
      deps,
      context,
      mainDir,
      slot,
      {
        sha: head,
        configSha: firstParent.code === 0 ? firstParent.stdout.trim() : head,
      },
      "the lease was lost during the gate of the merged head",
    );
  } catch (error) {
    // Measuring is a courtesy to the next gate: a sandbox that will not start must not fail a merge that landed.
    if (error instanceof JobLostError) throw error;
    context.log(
      `merge: the merged head could not be measured (${error instanceof Error ? error.message : error}); reporting the merge without its measurements`,
    );
    return undefined;
  }
  if (outcome.pass) return outcome;
  context.log(
    "merge: the merged head does not pass the gate; reporting the merge without its measurements",
  );
  return undefined;
}

const GENERATE_TIMEOUT_SECONDS = 600;

function treeShaFrom(output: string): string | undefined {
  return output
    .trim()
    .split("\n")
    .findLast((line) => /^[0-9a-f]{40,64}$/.test(line));
}

function regenerateMessage(bundle: Bundle): string {
  const lines = [
    "Regenerate declared files",
    "",
    `Spec: ${bundle.spec.displayId}`,
  ];
  if (bundle.ticket) lines.push(`Ticket: ${bundle.ticket.displayId}`);
  if (bundle.run) lines.push(`Run: ${bundle.run.displayId}`);
  return lines.join("\n");
}

async function regenerateGeneratedConflicts(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  input: {
    integration: string;
    incoming: string;
    files: string[];
    groups: GeneratedGroup[];
    config: GateConfig;
    message: string;
  },
): Promise<
  { ok: true; candidate: string } | { ok: false; failureLog: string }
> {
  const { bundle, log } = context;
  const upstreamSha =
    bundle.job.stage === "update-branch"
      ? tip(mainDir, input.incoming)
      : tip(mainDir, input.integration);
  const ours = mergeTakingOurs(
    mainDir,
    input.integration,
    input.incoming,
    input.files,
    input.message,
  );
  const regenRef = `gate/regen/${subjectLabel(bundle)}`;
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${regenRef}`, ours.candidate]);
  bringBranches(slot, mainDir, [regenRef]);
  const sandbox = deps.makeGateSandbox(slot.dir, runIdOf(bundle));
  let session: SandboxSession | undefined;
  const logs: string[] = [];
  try {
    session = await sandbox.open(regenRef);
    if (input.config.setup) {
      const setup = await session.exec(input.config.setup, {
        timeoutSeconds: GENERATE_TIMEOUT_SECONDS,
      });
      logs.push(`# setup\n${setup.output}`);
      if (setup.exitCode !== 0)
        throw new GateSetupError(setup.exitCode, setup.output);
    }
    for (const group of input.groups) {
      log(`merge: regenerating ${group.paths.join(", ")}`);
      const result = await session.exec(
        generatedRunCommand(group.run, upstreamSha),
        {
          timeoutSeconds: GENERATE_TIMEOUT_SECONDS,
        },
      );
      logs.push(`# ${group.run}\n${result.output}`);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          failureLog: `# regenerating declared files failed\n\n${logs.join("\n\n")}\n`,
        };
      }
    }
    const written = await session.exec("git add -A && git write-tree", {
      timeoutSeconds: 60,
    });
    const tree = treeShaFrom(written.output);
    if (written.exitCode !== 0 || !tree) {
      return {
        ok: false,
        failureLog: `# regenerating declared files failed\n\ncould not write a tree\n\n${logs.join("\n\n")}\n${written.output}\n`,
      };
    }
    // Same tree still gets a platform commit: the merge commit only carries Ticket, and
    // the spec wants Spec/Ticket/Run trailers on the regenerate commit.
    const candidate = gitOrThrow(
      slot.dir,
      [
        "commit-tree",
        tree,
        "-p",
        ours.candidate,
        "-m",
        regenerateMessage(bundle),
      ],
      AUTHOR,
    );
    gitOrThrow(slot.dir, ["update-ref", `refs/heads/${regenRef}`, candidate]);
    gitOrThrow(mainDir, [
      "-c",
      "transfer.fsckObjects=true",
      "fetch",
      "--quiet",
      "--no-tags",
      slot.dir,
      `+refs/heads/${regenRef}:refs/heads/${regenRef}`,
    ]);
    return { ok: true, candidate };
  } finally {
    await session?.close();
    git(mainDir, ["update-ref", "-d", `refs/heads/${regenRef}`]);
    git(slot.dir, ["update-ref", "-d", `refs/heads/${regenRef}`]);
  }
}

async function mergeOnce(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody | { integrationMoved: string }> {
  const { bundle, log, job } = context;
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  const integrationRef = `refs/heads/${integration}`;
  const stage = bundle.job.stage;
  const onOrigin = () => originSha(mainDir, agent, { signal: context.signal });
  if (exists(mainDir, agent) || (await onOrigin())) {
    await publishLocalAhead(deps, context, mainDir, agent);
    if (exists(mainDir, agent) || (await onOrigin()))
      await publishedTip(mainDir, agent, context.signal);
  }
  // A first update-branch has no temp branch yet: merge the default branch. After the merge agent, the temp exists
  // and is what gets merge-treed into the integration branch.
  const incoming =
    stage === "update-branch" && !exists(mainDir, agent)
      ? bundle.repo.defaultBranch
      : agent;

  // Already merged (a previous attempt got as far as the push): say so instead of merging twice. What the first
  // attempt measured never arrived, so the branch is measured as it is now, and the Run records its head: without
  // that the next gate would be held to an older merge's counts.
  if (isAncestor(mainDir, incoming, integration)) {
    log(`merge: ${incoming} is already part of ${integration}`);
    const head = tip(mainDir, integration);
    const measured = await measureMergedHead(
      deps,
      context,
      mainDir,
      slot,
      head,
    );
    return {
      stage,
      outcome: "merged",
      headSha: head,
      run: { headSha: head },
      ...(measured ? { gate: gateFacts(measured) } : {}),
    };
  }

  const oldTip = tip(mainDir, integration);
  if (!bundle.ticket && stage !== "update-branch") {
    // The overall fix has no gate of its own before this point, so the protected paths are checked here.
    const touched = checkProtectedPaths({
      changed: changedFiles(mainDir, oldTip, agent),
      protectedPaths: bundle.protectedPaths,
      approved: [],
    });
    if (touched.unapproved.length > 0) {
      log(
        `${stage}: the fix changes protected paths: ${touched.unapproved.join(", ")}`,
      );
      return {
        stage,
        outcome: "gate-failed",
        run: {
          output: {
            failureLog: `# the overall fix changed protected paths\n\n${touched.unapproved.map((f) => `- ${f}`).join("\n")}\n`,
          },
        },
      };
    }
  }
  const mergeMessage =
    stage === "update-branch"
      ? `Merge ${incoming} into ${integration}\n\nSpec: ${bundle.spec.displayId}${bundle.run ? `\nRun: ${bundle.run.displayId}` : ""}`
      : `Merge ${incoming} into ${integration}${bundle.ticket ? `\n\nTicket: ${bundle.ticket.displayId}` : ""}`;
  const candidate = mergeCandidate(
    mainDir,
    integration,
    incoming,
    mergeMessage,
  );
  let candidateSha: string;
  let generatedOnlyConflict: boolean | undefined;
  let conflictFiles: string[] | undefined;
  if (candidate.conflict) {
    log(`merge: conflict in ${candidate.files.join(", ")}`);
    const config = readGateConfig(mainDir, oldTip);
    const generated = config.generated ?? [];
    const groups = generatedGroupsFor(candidate.files, generated);
    const note = generatedCommandsNote(groups);
    if (generatedOnlyConflicts(candidate.files, generated)) {
      const resolved = await regenerateGeneratedConflicts(
        deps,
        context,
        mainDir,
        slot,
        {
          integration,
          incoming,
          files: candidate.files,
          groups,
          config,
          message: mergeMessage,
        },
      );
      if (!resolved.ok) {
        return {
          stage,
          outcome: "conflict",
          run: {
            output: {
              failureLog: resolved.failureLog,
              generatedOnlyConflict: true,
              conflictFiles: candidate.files,
            },
          },
        };
      }
      candidateSha = resolved.candidate;
      generatedOnlyConflict = true;
      conflictFiles = candidate.files;
    } else {
      return {
        stage,
        outcome: "conflict",
        run: {
          output: {
            failureLog: `# merge conflict\n\n${incoming} cannot be merged into ${integration}:\n${candidate.files.map((f) => `- ${f}`).join("\n")}\n${note}`,
            generatedOnlyConflict: false,
            conflictFiles: candidate.files,
          },
        },
      };
    }
  } else {
    candidateSha = candidate.candidate;
  }

  // The candidate is gated on a branch of its own; only a passing candidate moves the integration branch.
  const mergeNames = mergeNameSets(mainDir, integration, incoming, bundle);
  const outcome = await gateCommit(
    deps,
    context,
    mainDir,
    slot,
    {
      sha: candidateSha,
      configSha: oldTip,
      ...mergeGateCompare(bundle.gateBaseline ?? undefined, mergeNames),
      ...(bundle.approvedRemovedTests?.length
        ? { approvedRemoved: bundle.approvedRemovedTests }
        : {}),
    },
    "the lease was lost during the candidate gate",
  );
  if (!outcome.pass) {
    return {
      stage,
      outcome:
        gateOutcomeOf(outcome) === "tests-removed"
          ? "tests-removed"
          : "gate-failed",
      run: {
        output: gateFailureOutput(outcome),
      },
      gate: gateFacts(outcome),
    };
  }
  // Still the holder? This check renews the lease as well.
  if ((await deps.api.prePush(job)) === "lost")
    throw new JobLostError("the lease was lost before the push");
  const pushed = await deps.push({
    repoDir: mainDir,
    source: candidateSha,
    target: integrationRef,
    expectedOld: oldTip,
  });
  if (!pushed.ok) {
    if (classifyPushError(pushed.error) === "host-permission") {
      throwPushFailure(pushed.error, {
        remoteTip: await tipAfterFailedPush(
          mainDir,
          integrationRef,
          context.signal,
        ),
        startedFrom: oldTip,
      });
    }
    return { integrationMoved: pushed.error };
  }
  gitOrThrow(mainDir, ["update-ref", integrationRef, candidateSha]);
  log(`merge: ${integration} is now ${candidateSha}`);
  return {
    stage,
    outcome: "merged",
    headSha: candidateSha,
    // recorded on the Run, so the next gate can be measured against what this merge measured
    run: {
      headSha: candidateSha,
      ...(generatedOnlyConflict
        ? {
            output: {
              generatedOnlyConflict: true,
              conflictFiles,
            },
          }
        : {}),
    },
    gate: gateFacts(outcome),
  };
}
