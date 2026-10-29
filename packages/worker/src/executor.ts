import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRunner,
  changedFiles,
  checkProtectedPaths,
  classifyAgentRun,
  classifyReviewRun,
  type GateCache,
  type GateOutcome,
  type GateSandbox,
  git,
  gitOrThrow,
  hasRef,
  ImplementOutputSchema,
  isAncestor,
  mergeCandidate,
  promptFor,
  ReviewOutputSchema,
  readContract,
  renderContext,
  reviewFindings,
  runGate,
  stampTrailers,
  type TestCounts,
} from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { type Credentials, withCredentials } from "./credentials.ts";
import type { PushFn } from "./push.ts";
import { sanitizeRawLine } from "./raw-log.ts";
import type { RepoStore } from "./repos.ts";
import { retrieveResult, type Slot, type SlotManager } from "./slots.ts";

// Runs one stage of one ticket and returns the facts for the API: what the worker is for. Which stage comes next,
// and whether the ticket is blocked, is the API's decision (docs/specs/m1-platform.md「谁决定下一步」).

export interface ExecutorDeps {
  slots: SlotManager;
  repos: RepoStore;
  push: PushFn;
  credentials?: Credentials; // tokens for the code host; without them git uses whatever it is already set up with
  api: Pick<WorkerApi, "prePush">; // supplied by the worker loop
  gateCache: GateCache;
  makeAgentRunner(slotDir: string): AgentRunner;
  makeGateSandbox(slotDir: string): GateSandbox;
  tmpRoot?: string;
  model?: string; // the worker's own model: what a project that sets none gets
  secrets?: readonly string[]; // kept out of the raw event lines that are uploaded
}

export interface StageContext {
  job: ClaimedJob;
  bundle: Bundle;
  signal: AbortSignal;
  log: (line: string) => void;
  logRaw: (line: string) => void; // goes to the Run's log only, not to the worker's own output
}

// What a run is asked for, from the project's say (the bundle) and the worker's own defaults.
function runOptions(deps: ExecutorDeps, context: StageContext) {
  const { bundle } = context;
  const model = bundle.model ?? deps.model;
  return {
    idleSeconds: bundle.limits.runIdleSeconds,
    wallClockMs: bundle.limits.runWallclockSeconds * 1000,
    ...(model ? { model } : {}),
    onRawLine: (line: string) =>
      context.logRaw(sanitizeRawLine(line, deps.secrets ?? [])),
  };
}

// A problem with the worker's own environment, not with the ticket: the job fails and is dispatched again.
export class InfrastructureError extends Error {}
// Nothing to run on right now: every slot is taken. The job is left alone and comes back when its lease runs out.
export class NoFreeSlotError extends Error {}
// The lease is gone; whatever was done must not be reported.
export class JobLostError extends Error {}

export type StageOutcomeBody = Record<string, unknown> & {
  stage: string;
  outcome: string;
};

// The Run is created when the job is claimed, so a bundle without one means the API and the worker disagree.
const runIdOf = (bundle: Bundle): string => {
  if (!bundle.run) throw new InfrastructureError("the bundle has no run");
  return bundle.run.displayId;
};

// The branch a stage works on: a ticket's own, or the one the overall fix of a spec is made on.
const subjectLabel = (bundle: Bundle) =>
  bundle.ticket?.displayId ?? `${bundle.spec.displayId}-final`;
const agentRef = (bundle: Bundle) => `agent/${subjectLabel(bundle)}`;
const successful = new Set(["done", "passed", "pass", "merged"]);
export const isSuccess = (body: StageOutcomeBody) =>
  successful.has(body.outcome);

export async function executeStage(
  rawDeps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const deps = await withCredentials(rawDeps, bundle.repo.url);
  if (!bundle.integrationBranch)
    throw new InfrastructureError(
      "the spec has no integration branch for this repo",
    );
  const mainDir = deps.repos.ensure(
    bundle.repo.role,
    bundle.repo.url,
    bundle.repo.defaultBranch,
  );
  ensureIntegrationBranch(deps, mainDir, bundle);

  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.role,
    ref: agentRef(bundle),
  });
  if (!slot) throw new NoFreeSlotError("no free slot");
  let body: StageOutcomeBody | undefined;
  try {
    body = await runStage(deps, context, mainDir, slot);
    return body;
  } finally {
    // Any stage that ran to an answer leaves a clean slot, whatever the answer; a clone is kept only when the stage broke.
    await slot.release(body ? "success" : "failure");
  }
}

// The integration branch is made from the default branch the first time any stage of the spec needs it.
function ensureIntegrationBranch(
  deps: ExecutorDeps,
  mainDir: string,
  bundle: Bundle,
) {
  const branch = bundle.integrationBranch as string;
  if (deps.repos.has(mainDir, `refs/heads/${branch}`)) return;
  const base = gitOrThrow(mainDir, ["rev-parse", bundle.repo.defaultBranch]);
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, base]);
  const pushed = deps.push({
    repoDir: mainDir,
    source: `refs/heads/${branch}`,
    target: `refs/heads/${branch}`,
    expectedOld: "", // it must not exist on the remote yet
  });
  if (!pushed.ok)
    throw new InfrastructureError(
      `could not create ${branch}: ${pushed.error}`,
    );
}

// Branches a slot needs to find in its clone, fetched from the main clone.
function bringBranches(slot: Slot, mainDir: string, refs: string[]) {
  for (const ref of refs) {
    if (
      git(mainDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`])
        .code !== 0
    )
      continue;
    gitOrThrow(slot.dir, [
      "fetch",
      "--quiet",
      "--no-tags",
      mainDir,
      `+refs/heads/${ref}:refs/heads/${ref}`,
    ]);
  }
}

async function runStage(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const integration = bundle.integrationBranch as string;
  // A restart-retry: the old ticket branch goes, and the implement run starts again from the integration branch.
  // What origin still has under that name is replaced at the push, under a lease on the tip it had.
  let replaced: string | undefined;
  if (bundle.job.stage === "implement" && bundle.ticket?.restart) {
    const ref = `refs/heads/${agentRef(bundle)}`;
    // The lease is on what origin has, which the main clone may not have fetched.
    const onOrigin = git(mainDir, ["ls-remote", "origin", ref])
      .stdout.split("\t")[0]
      ?.trim();
    replaced =
      onOrigin || (hasRef(mainDir, ref) ? tip(mainDir, ref) : undefined);
    if (hasRef(mainDir, ref)) gitOrThrow(mainDir, ["update-ref", "-d", ref]);
    if (replaced)
      context.log(`restart: dropped ${agentRef(bundle)} (was ${replaced})`);
  }
  bringBranches(slot, mainDir, [integration, agentRef(bundle)]);
  switch (bundle.job.stage) {
    case "implement":
    case "gate-fix":
    case "review-fix":
    case "merge-fix":
      return agentChange(deps, context, mainDir, slot, replaced);
    case "final-fix":
      return agentChange(deps, context, mainDir, slot);
    case "review":
    case "final-review":
      return review(deps, context, mainDir, slot);
    case "gate":
      return gate(deps, context, mainDir, slot);
    case "merge":
    case "final-merge":
      return merge(deps, context, mainDir, slot);
    default:
      throw new InfrastructureError(`unknown stage ${bundle.job.stage}`);
  }
}

const tip = (dir: string, ref: string) => gitOrThrow(dir, ["rev-parse", ref]);
const exists = hasRef;

function renderFor(
  context: StageContext,
  mainDir: string,
  baseSha: string,
  ctxRoot: string,
) {
  const { bundle } = context;
  const dir = join(ctxRoot, "context");
  renderContext({
    dir,
    bundle,
    run: {
      runId: runIdOf(bundle),
      baseSha,
      branch: agentRef(bundle),
    },
    ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
    ...(bundle.review ? { review: bundle.review } : {}),
    ...(bundle.contract
      ? { contract: readContract(mainDir, bundle.contract) }
      : {}),
  });
  return dir;
}

// The commit the ticket branch started from: where it left the integration branch.
function branchBase(dir: string, integration: string, agent: string): string {
  return exists(dir, agent)
    ? gitOrThrow(dir, ["merge-base", integration, agent])
    : tip(dir, integration);
}

async function agentChange(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  replaced?: string, // the tip of the ticket branch that a restart threw away
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const stage = bundle.job.stage as
    | "implement"
    | "gate-fix"
    | "review-fix"
    | "merge-fix"
    | "final-fix";
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
  const baseSha = branchBase(mainDir, integration, agent);
  const before = exists(mainDir, agent) ? tip(mainDir, agent) : baseSha;
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(context, mainDir, baseSha, tmp);
    log(`${stage}: running the agent on ${agent}`);
    const options = runOptions(deps, context);
    const run = await deps.makeAgentRunner(slot.dir).run({
      stage,
      branch: agent,
      baseBranch: integration,
      promptFile: promptFor(stage),
      ctxDir,
      schema: ImplementOutputSchema,
      ...options,
      signal: context.signal,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the agent run");
    const verdict = classifyAgentRun(run);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error);
    log(
      `${stage}: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    );

    const facts: Record<string, unknown> = {
      branch: agent,
      baseSha,
      commits: run.commits,
      durationMs: run.durationMs,
      ...(options.model ? { model: options.model } : {}),
      output: run.output ?? { error: run.error },
    };
    if (verdict.outcome !== "done")
      return { stage, outcome: verdict.outcome, run: facts };

    // Take the commits back from the slot, stamp them, and publish the branch.
    const taken = retrieveResult({
      slotClone: slot.dir,
      mainClone: mainDir,
      ref: agent,
      log,
    });
    if (!taken.fetched)
      throw new InfrastructureError(
        `could not take ${agent} back: ${taken.error ?? "no such branch in the slot"}`,
      );
    const stamped = stampTrailers({
      repoDir: mainDir,
      branch: agent,
      before,
      exclude: integration,
      ids: {
        spec: bundle.spec.displayId,
        ...(bundle.ticket ? { ticket: bundle.ticket.displayId } : {}),
        run: runIdOf(bundle),
      },
    });
    if (stamped.error)
      throw new InfrastructureError(`stamping failed: ${stamped.error}`);
    // Still the holder? (This also renews the lease.) A worker that lost its lease must not publish anything.
    if (
      context.signal.aborted ||
      (await deps.api.prePush(context.job)) === "lost"
    ) {
      throw new JobLostError("the lease was lost before the push");
    }
    const pushed = deps.push({
      repoDir: mainDir,
      source: `refs/heads/${agent}`,
      target: `refs/heads/${agent}`,
      ...(replaced ? { expectedOld: replaced } : {}),
    });
    if (!pushed.ok)
      throw new InfrastructureError(`push failed: ${pushed.error}`);
    facts.headSha = tip(mainDir, agent);
    facts.commits = gitOrThrow(mainDir, [
      "rev-list",
      "--reverse",
      `${before}..${agent}`,
    ])
      .split("\n")
      .filter(Boolean);
    return { stage, outcome: "done", run: facts };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function review(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = agentRef(bundle);
  const stage = bundle.job.stage as "review" | "final-review";
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
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(context, mainDir, baseSha, tmp);
    const options = runOptions(deps, context);
    const run = await deps.makeAgentRunner(slot.dir).run({
      stage,
      branch: agent,
      baseBranch: bundle.integrationBranch as string,
      promptFile: promptFor(stage),
      ctxDir,
      schema: ReviewOutputSchema,
      ...options,
      signal: context.signal,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the review");
    const verdict = classifyReviewRun(run);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error);
    log(`${stage}: ${verdict.outcome}`);
    if (run.commits.length > 0)
      log(
        `review: WARNING the review made ${run.commits.length} commit(s); it should only read`,
      );
    return {
      stage,
      outcome: verdict.outcome,
      run: {
        branch: agent,
        baseSha,
        commits: run.commits,
        durationMs: run.durationMs,
        ...(options.model ? { model: options.model } : {}),
        output: run.output ?? { error: run.error },
      },
      findings: run.output ? reviewFindings(run.output) : [],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function gateFacts(outcome: GateOutcome) {
  return {
    commitSha: outcome.commitSha,
    configSha: outcome.configSha,
    commandResults: outcome.steps,
    ...(outcome.counts
      ? {
          testsTotal: outcome.counts.tests,
          testsSkipped: outcome.counts.skipped,
        }
      : {}),
    ...(outcome.testCases ? { testCases: outcome.testCases } : {}),
  };
}

function logGate(log: (line: string) => void, outcome: GateOutcome) {
  for (const step of outcome.steps)
    log(`gate: ${step.name} exit ${step.exitCode} (${step.ms} ms)`);
  for (const [name, text] of Object.entries(outcome.stepLogs))
    log(`--- ${name} ---\n${text}`);
}

async function gate(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
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
      run: { branch: agent, baseSha, output: { unapproved: check.unapproved } },
    };
  }

  // The gate configuration comes from the integration branch, not from the ticket's branch.
  const outcome = await runGate({
    repoDir: mainDir,
    sandbox: deps.makeGateSandbox(slot.dir),
    signal: context.signal,
    ref: agent,
    commitSha: tip(mainDir, agent),
    configSha: tip(mainDir, integration),
    ...(bundle.gateBaseline ? { baseline: bundle.gateBaseline } : {}),
    cache: deps.gateCache,
  });
  if (context.signal.aborted)
    throw new JobLostError("the lease was lost during the gate");
  logGate(log, outcome);
  return {
    stage: "gate",
    outcome: outcome.pass ? "passed" : "failed",
    run: {
      branch: agent,
      baseSha,
      headSha: outcome.commitSha,
      output: { failureLog: outcome.failureLog, reasons: outcome.reasons },
    },
    gate: gateFacts(outcome),
  };
}

const MAX_MERGE_ATTEMPTS = 3;

// If the integration branch moved while the candidate was being gated, the push is refused by its lease. The
// answer is not to fail but to fetch and begin again: a new candidate on the new tip, gated again.
async function merge(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
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
    deps.repos.ensure(
      bundle.repo.role,
      bundle.repo.url,
      bundle.repo.defaultBranch,
    );
  }
}

// The gate on one commit, run on a branch of its own that is gone again afterwards. The baseline, when there is one,
// is what the counts are held to.
async function gateCommit(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  commit: { sha: string; configSha: string; baseline?: TestCounts },
  lostMessage: string,
): Promise<GateOutcome> {
  const gateBranch = `gate/${subjectLabel(context.bundle)}`;
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${gateBranch}`, commit.sha]);
  try {
    bringBranches(slot, mainDir, [gateBranch]);
    const outcome = await runGate({
      repoDir: mainDir,
      sandbox: deps.makeGateSandbox(slot.dir),
      signal: context.signal,
      ref: gateBranch,
      commitSha: commit.sha,
      configSha: commit.configSha,
      ...(commit.baseline ? { baseline: commit.baseline } : {}),
      cache: deps.gateCache,
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

async function mergeOnce(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody | { integrationMoved: string }> {
  const { bundle, log, job } = context;
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
  const integrationRef = `refs/heads/${integration}`;
  const stage = bundle.job.stage as "merge" | "final-merge";

  // Already merged (a previous attempt got as far as the push): say so instead of merging twice. What the first
  // attempt measured never arrived, so the branch is measured as it is now, and the Run records its head: without
  // that the next gate would be held to an older merge's counts.
  if (isAncestor(mainDir, agent, integration)) {
    log(`merge: ${agent} is already part of ${integration}`);
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
  if (!bundle.ticket) {
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
  const candidate = mergeCandidate(
    mainDir,
    integration,
    agent,
    `Merge ${agent} into ${integration}${bundle.ticket ? `\n\nTicket: ${bundle.ticket.displayId}` : ""}`,
  );
  if (candidate.conflict) {
    log(`merge: conflict in ${candidate.files.join(", ")}`);
    return {
      stage,
      outcome: "conflict",
      run: {
        output: {
          failureLog: `# merge conflict\n\n${agent} cannot be merged into ${integration}:\n${candidate.files.map((f) => `- ${f}`).join("\n")}\n`,
        },
      },
    };
  }

  // The candidate is gated on a branch of its own; only a passing candidate moves the integration branch.
  const outcome = await gateCommit(
    deps,
    context,
    mainDir,
    slot,
    {
      sha: candidate.candidate,
      configSha: oldTip,
      ...(bundle.gateBaseline ? { baseline: bundle.gateBaseline } : {}),
    },
    "the lease was lost during the candidate gate",
  );
  if (!outcome.pass) {
    return {
      stage,
      outcome: "gate-failed",
      run: {
        output: { failureLog: outcome.failureLog, reasons: outcome.reasons },
      },
      gate: gateFacts(outcome),
    };
  }
  // Still the holder? This check renews the lease as well.
  if ((await deps.api.prePush(job)) === "lost")
    throw new JobLostError("the lease was lost before the push");
  const pushed = deps.push({
    repoDir: mainDir,
    source: candidate.candidate,
    target: integrationRef,
    expectedOld: oldTip,
  });
  if (!pushed.ok) return { integrationMoved: pushed.error };
  gitOrThrow(mainDir, ["update-ref", integrationRef, candidate.candidate]);
  log(`merge: ${integration} is now ${candidate.candidate}`);
  return {
    stage,
    outcome: "merged",
    headSha: candidate.candidate,
    // recorded on the Run, so the next gate can be measured against what this merge measured
    run: { headSha: candidate.candidate },
    gate: gateFacts(outcome),
  };
}
