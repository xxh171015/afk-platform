import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRunner,
  changedFiles,
  checkContractCopies,
  checkProtectedPaths,
  classifyAgentRun,
  classifyDiagnoseRun,
  classifyReviewRun,
  combineReviewRuns,
  type DiagnoseOutput,
  DiagnoseOutputSchema,
  type DockerCli,
  type Environment,
  EnvironmentError,
  type EnvironmentRepo,
  type GateCache,
  type GateOutcome,
  type GateSandbox,
  git,
  gitOrThrow,
  hasRef,
  ImplementOutputSchema,
  isAncestor,
  mergeCandidate,
  projectOf,
  promptFor,
  ReviewOutputSchema,
  reclaimEnvironments,
  renderContext,
  reviewFindings,
  runE2e,
  runGate,
  type SandboxPlacement,
  stampTrailers,
  startEnvironment,
  type TestCounts,
  writePrompt,
} from "@afk/pipeline";
import { type Bundle, REVIEW_AXES, type ReviewAxis } from "@afk/shared";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { fetchContracts } from "./contracts.ts";
import { type Credentials, withCredentials } from "./credentials.ts";
import { cutIntegrationBranch, fetchDomain } from "./domain.ts";
import type { EnvironmentLimiter } from "./environments.ts";
import type { PushFn } from "./push.ts";
import { sanitizeRawLine } from "./raw-log.ts";
import type { RepoStore } from "./repos.ts";
import { retrieveResult, type Slot, type SlotManager } from "./slots.ts";
import type { SnapshotStore } from "./snapshots.ts";

// Runs one stage of one ticket and returns the facts for the API: what the worker is for. Which stage comes next,
// and whether the ticket is blocked, is the API's decision (docs/specs/m1-platform.md「谁决定下一步」).

export interface ExecutorDeps {
  slots: SlotManager;
  repos: RepoStore;
  snapshots: SnapshotStore;
  push: PushFn;
  credentials?: Credentials; // tokens for the code host; without them git uses whatever it is already set up with
  api: Pick<WorkerApi, "prePush">; // supplied by the worker loop
  gateCache: GateCache;
  // What an integration environment needs: docker, and the limit on how many a worker runs at once.
  docker?: DockerCli;
  environments?: EnvironmentLimiter;
  makeAgentRunner(slotDir: string): AgentRunner;
  makeGateSandbox(slotDir: string): GateSandbox;
  tmpRoot?: string;
  model?: string; // the worker's own model: what a project that sets none gets
  skillsSha?: string; // the skills version the worker checked at start-up; recorded on every agent Run
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

// What a Run records about the agent that ran: its model and the skills it ran with. Gates run no agent and record neither.
function agentFacts(
  deps: ExecutorDeps,
  options: { model?: string },
  prompt: string,
) {
  return {
    prompt,
    ...(options.model ? { model: options.model } : {}),
    ...(deps.skillsSha ? { skillsSha: deps.skillsSha } : {}),
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

// The label of what a stage works on (its gate branch is named after it): a ticket, or the overall fix of a spec.
const subjectLabel = (bundle: Bundle) => {
  if (bundle.ticket) return bundle.ticket.displayId;
  if (bundle.job.stage === "update-branch")
    return `${bundle.spec.displayId}-update`;
  return `${bundle.spec.displayId}-final`;
};
const successful = new Set(["done", "passed", "pass", "merged"]);
export const isSuccess = (body: StageOutcomeBody) =>
  successful.has(body.outcome);

export async function executeStage(
  rawDeps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  // the repos a stage reads besides its own are fetched with tokens of their own
  const deps = await withCredentials(rawDeps, bundle.repo.url, [
    ...bundle.contracts.map((c) => c.url),
    ...bundle.refs.map((r) => r.url),
    ...bundle.environment.map((r) => r.url),
    ...(bundle.domain ? [bundle.domain.url] : []),
  ]);
  if (!bundle.integrationBranch)
    throw new InfrastructureError(
      "the spec has no integration branch for this repo",
    );
  const mainDir = deps.repos.ensure(
    bundle.repo.name,
    bundle.repo.url,
    bundle.repo.defaultBranch,
  );
  try {
    cutIntegrationBranch(deps.repos, deps.push, mainDir, bundle, context.log);
  } catch (error) {
    throw new InfrastructureError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.name,
    repoUrl: bundle.repo.url,
    ref: bundle.agentBranch,
    integration: bundle.integrationBranch as string,
    defaultBranch: bundle.repo.defaultBranch,
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
    const ref = `refs/heads/${bundle.agentBranch}`;
    // The lease is on what origin has, which the main clone may not have fetched.
    const onOrigin = git(mainDir, ["ls-remote", "origin", ref])
      .stdout.split("\t")[0]
      ?.trim();
    replaced =
      onOrigin || (hasRef(mainDir, ref) ? tip(mainDir, ref) : undefined);
    if (hasRef(mainDir, ref)) gitOrThrow(mainDir, ["update-ref", "-d", ref]);
    if (replaced)
      context.log(`restart: dropped ${bundle.agentBranch} (was ${replaced})`);
  }
  bringBranches(slot, mainDir, [integration, bundle.agentBranch]);
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
    case "update-branch":
      return context.job.type === "agent-run"
        ? agentChange(deps, context, mainDir, slot)
        : merge(deps, context, mainDir, slot);
    case "e2e":
      return e2e(deps, context, mainDir, slot);
    case "diagnose":
      return diagnose(deps, context, mainDir, slot);
    default:
      throw new InfrastructureError(`unknown stage ${bundle.job.stage}`);
  }
}

const tip = (dir: string, ref: string) => gitOrThrow(dir, ["rev-parse", ref]);
const exists = hasRef;

function renderFor(
  deps: ExecutorDeps,
  context: StageContext,
  baseSha: string,
  ctxRoot: string,
) {
  const { bundle } = context;
  const dir = join(ctxRoot, "context");
  const domainFiles = fetchDomain(deps.repos, bundle.domain, bundle.repo.name);
  renderContext({
    dir,
    bundle,
    run: {
      runId: runIdOf(bundle),
      baseSha,
      branch: bundle.agentBranch,
    },
    ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
    ...(bundle.review ? { review: bundle.review } : {}),
    ...(bundle.contracts.length
      ? { contracts: fetchContracts(deps.repos, bundle.contracts) }
      : {}),
    ...(domainFiles ? { domain: domainFiles } : {}),
  });
  return dir;
}

// Snapshots of repos at the SHA the bundle names (the head of the default branch when it names none): the ones
// the ticket refs, to be mounted read-only at /refs/<name>, or the ones an integration environment is built from.
// The SHAs go on the Run.
function snapshotRefs(
  deps: ExecutorDeps,
  bundle: Bundle,
  from: Bundle["refs"] = bundle.refs,
) {
  const refs: { name: string; dir: string }[] = [];
  const refShas: Record<string, string> = {};
  for (const ref of from) {
    const clone = deps.repos.ensure(ref.name, ref.url, ref.defaultBranch);
    const sha = ref.sha ?? tip(clone, ref.defaultBranch);
    refs.push({
      name: ref.name,
      dir: deps.snapshots.ensure(ref.name, clone, sha),
    });
    refShas[ref.name] = sha;
  }
  return { refs, refShas };
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
    | "update-branch"
    | "final-fix";
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  const baseSha = branchBase(mainDir, integration, agent);
  const before = exists(mainDir, agent) ? tip(mainDir, agent) : baseSha;
  // implement owns every commit of the branch, those an interrupted run left in it included, unless an earlier
  // run already stamped them (and maybe published them): those are not rewritten. A fix owns its own commits.
  const stampFrom =
    stage === "implement" &&
    !/^Run: /m.test(
      git(mainDir, ["log", "--format=%B", `${baseSha}..${before}`]).stdout,
    )
      ? baseSha
      : before;
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(deps, context, baseSha, tmp);
    const inEnvironment =
      bundle.ticket?.type === "integration" && bundle.environment.length > 0;
    const given = writePrompt(
      tmp,
      promptFor(stage, { integration: inEnvironment }),
    );
    const { refs, refShas } = snapshotRefs(deps, bundle);
    log(`${stage}: running the agent on ${agent}`);
    const options = runOptions(deps, context);
    // An integration ticket's agent works in its integration environment: it writes the e2e against real services,
    // and a fix reproduces the failure there. The environment is gone again when the run is over.
    const runAgent = (placement?: SandboxPlacement) =>
      deps.makeAgentRunner(slot.dir).run({
        stage,
        branch: agent,
        baseBranch: integration,
        promptFile: given.promptFile,
        ctxDir,
        refs,
        schema: ImplementOutputSchema,
        ...(placement ? { placement } : {}),
        ...options,
        signal: context.signal,
      });
    const run = inEnvironment
      ? await withEnvironment(deps, context, stage, (environment) =>
          runAgent({ network: environment.network, env: environment.env }),
        )
      : await runAgent();
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the agent run");
    // Commits the branch already carries (salvaged from an interrupted run, or kept by a continue-retry) are the
    // ticket's work: an agent that finds it complete adds none, and that is done, not no-commits.
    const inherited =
      stage === "implement" && before !== baseSha && run.commits.length === 0;
    const verdict = classifyAgentRun(
      inherited ? { ...run, commits: [before] } : run,
    );
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
      ...agentFacts(deps, options, given.prompt),
      ...(refs.length ? { refShas } : {}),
      output: run.output ?? { error: run.error },
    };
    if (verdict.outcome !== "done")
      return { stage, outcome: verdict.outcome, run: facts };

    // Take the commits back from the slot, stamp them, and publish the branch.
    const taken = retrieveResult({
      slotClone: slot.dir,
      mainClone: mainDir,
      ref: agent,
      integration,
      defaultBranch: bundle.repo.defaultBranch,
      log,
    });
    if (!taken.fetched)
      throw new InfrastructureError(
        `could not take ${agent} back: ${taken.error ?? "no such branch in the slot"}`,
      );
    const stamped = stampTrailers({
      repoDir: mainDir,
      branch: agent,
      before: stampFrom,
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
      `${stampFrom}..${agent}`,
    ])
      .split("\n")
      .filter(Boolean);
    return { stage, outcome: "done", run: facts };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// What one axis of a review came to on its own: pass, fix, or the failure that stopped it.
function axisResult(run: Parameters<typeof classifyReviewRun>[0]): string {
  const verdict = classifyReviewRun(run);
  return verdict.kind === "outcome" ? verdict.outcome : "invalid-output";
}

async function review(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = bundle.agentBranch;
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
  // The two axes are two agent runs in two sandboxes at once. A branch can be checked out in one sandbox only, so each
  // axis gets a branch of its own at the same commit, which is gone again afterwards. A review only reads.
  const reviewed =
    stage === "final-review"
      ? tip(mainDir, bundle.integrationBranch as string)
      : tip(mainDir, agent);
  const branches = new Map(
    REVIEW_AXES.map((axis) => [axis, `review-${axis}/${subjectLabel(bundle)}`]),
  );
  for (const branch of branches.values())
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, reviewed]);
  try {
    bringBranches(slot, mainDir, [...branches.values()]);
    const ctxDir = renderFor(deps, context, baseSha, tmp);
    const { refs, refShas } = snapshotRefs(deps, bundle);
    const options = runOptions(deps, context);
    const runs = await Promise.all(
      REVIEW_AXES.map(async (axis) => {
        const given = writePrompt(join(tmp, axis), promptFor(stage, { axis }));
        const run = await deps.makeAgentRunner(slot.dir).run({
          stage,
          branch: branches.get(axis) as string,
          baseBranch: bundle.integrationBranch as string,
          promptFile: given.promptFile,
          ctxDir,
          refs,
          schema: ReviewOutputSchema,
          ...options,
          signal: context.signal,
        });
        return { axis, given, run };
      }),
    );
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the review");
    const byAxis = Object.fromEntries(
      runs.map((r) => [r.axis, r.run]),
    ) as Record<ReviewAxis, (typeof runs)[number]["run"]>;
    const { classification: verdict } = combineReviewRuns(byAxis);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error);
    log(`${stage}: ${verdict.outcome}`);
    for (const { axis, run } of runs)
      if (run.commits.length > 0)
        log(
          `review: WARNING the ${axis} review made ${run.commits.length} commit(s); it should only read`,
        );
    const factsOf = ({ axis, given, run }: (typeof runs)[number]) => ({
      axis,
      run: {
        // what this axis came to on its own; the stage's outcome is the two put together
        result: axisResult(run),
        branch: agent,
        baseSha,
        commits: run.commits,
        durationMs: run.durationMs,
        ...agentFacts(deps, options, given.prompt),
        ...(refs.length ? { refShas } : {}),
        output: run.output ?? { error: run.error },
      },
      findings: run.output ? reviewFindings(run.output) : [],
    });
    const [first, ...others] = runs.map(factsOf);
    return {
      stage,
      outcome: verdict.outcome,
      // the Standards run is the job's own Run; the Spec run is recorded beside it
      run: { ...first?.run, axis: first?.axis },
      findings: first?.findings ?? [],
      extraRuns: others.map((r) => ({
        run: { ...r.run, axis: r.axis },
        findings: r.findings,
      })),
    };
  } finally {
    for (const branch of branches.values())
      git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
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
  const agent = bundle.agentBranch;
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

  // A contract ticket writes the contract itself; only the tickets that consume one keep copies of it.
  const copies =
    bundle.ticket?.type === "contract"
      ? []
      : checkContractCopies({
          repoDir: mainDir,
          repo: bundle.repo.name,
          ref: agent,
          base: baseSha,
          contracts: fetchContracts(deps.repos, bundle.contracts),
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
  const outcome = await runGate({
    repoDir: mainDir,
    sandbox: deps.makeGateSandbox(slot.dir),
    signal: context.signal,
    ref: agent,
    commitSha: tip(mainDir, agent),
    configSha: tip(mainDir, integration),
    ...(baseline ? { baseline } : {}),
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
      bundle.repo.name,
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
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  const integrationRef = `refs/heads/${integration}`;
  const stage = bundle.job.stage;
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
  const candidate = mergeCandidate(
    mainDir,
    integration,
    incoming,
    stage === "update-branch"
      ? `Merge ${incoming} into ${integration}\n\nSpec: ${bundle.spec.displayId}${bundle.run ? `\nRun: ${bundle.run.displayId}` : ""}`
      : `Merge ${incoming} into ${integration}${bundle.ticket ? `\n\nTicket: ${bundle.ticket.displayId}` : ""}`,
  );
  if (candidate.conflict) {
    log(`merge: conflict in ${candidate.files.join(", ")}`);
    return {
      stage,
      outcome: "conflict",
      run: {
        output: {
          failureLog: `# merge conflict\n\n${incoming} cannot be merged into ${integration}:\n${candidate.files.map((f) => `- ${f}`).join("\n")}\n`,
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

// A fresh integration environment, built from snapshots of the repos the ticket names (the heads of their integration
// branches, the default branch where the spec has not merged anything), in the order the ticket names them; `use`
// runs in it, and it is taken down again whatever `use` does. An environment that cannot be made fails the job (the
// API tries again, and blocks the ticket after three). Whoever starts a sandbox in it closes the sandbox before
// `use` returns: only then can compose take the network down.
async function withEnvironment<T>(
  deps: ExecutorDeps,
  context: StageContext,
  label: string,
  use: (environment: Environment) => Promise<T>,
): Promise<T> {
  const { bundle, log } = context;
  const { docker, environments } = deps;
  if (!docker || !environments)
    throw new InfrastructureError(
      "this worker has no integration environments",
    );
  const { refs, refShas } = snapshotRefs(deps, bundle, bundle.environment);
  const repos: EnvironmentRepo[] = refs.map((ref) => ({
    name: ref.name,
    dir: ref.dir,
    sha: refShas[ref.name] as string,
  }));

  const runId = runIdOf(bundle);
  const project = projectOf(runId);
  const release = await environments
    .acquire(bundle.limits.maxIntegrationEnvironments, context.signal)
    .catch((error) => {
      throw new JobLostError(error.message);
    });
  environments.projects.add(project);
  let environment: Environment | undefined;
  try {
    // Environments a worker that was killed left behind go first: nothing else will remove them.
    await reclaimEnvironments({
      docker,
      keep: environments.projects,
      log,
    });
    try {
      environment = await startEnvironment({
        docker,
        runId,
        repos,
        signal: context.signal,
        log,
      });
    } catch (error) {
      if (context.signal.aborted)
        throw new JobLostError(
          "the lease was lost while the environment came up",
        );
      if (error instanceof EnvironmentError)
        throw new InfrastructureError(error.message);
      throw error;
    }
    log(
      `${label}: environment ${environment.project} is up after ${environment.upMs} ms`,
    );
    return await use(environment);
  } finally {
    await environment?.stop();
    environments.projects.delete(project);
    release();
  }
}

// The last stage of an integration ticket: its repo at the head of the integration branch, in a fresh sandbox on the
// network of a fresh integration environment, running the repo's e2e. A deterministic step, not an agent run: the
// JUnit report is the verdict. An e2e that fails is a result.
async function e2e(
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
        sandbox: deps.makeGateSandbox(slot.dir),
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

// After a failed e2e: an agent in a fresh integration environment, on the repo at the head of its integration
// branch, finds out which repo is at fault. It only diagnoses: whatever it commits is thrown away with its branch.
async function diagnose(
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
    const ctxDir = renderFor(deps, context, head, tmp);
    const given = writePrompt(tmp, promptFor("diagnose"));
    const { refs } = snapshotRefs(deps, bundle);
    const options = runOptions(deps, context);
    // on a branch of its own that is gone again afterwards, like the e2e's
    const branch = `diagnose/${subjectLabel(bundle)}`;
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, head]);
    try {
      bringBranches(slot, mainDir, [branch]);
      const run = await withEnvironment(
        deps,
        context,
        "diagnose",
        async (environment) => ({
          environment,
          run: await deps.makeAgentRunner(slot.dir).run({
            stage: "diagnose",
            branch,
            baseBranch: integration,
            promptFile: given.promptFile,
            ctxDir,
            refs,
            schema: DiagnoseOutputSchema,
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
        throw new InfrastructureError(verdict.error);
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
          ...agentFacts(deps, options, given.prompt),
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
