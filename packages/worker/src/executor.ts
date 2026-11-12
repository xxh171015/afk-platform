import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRunner,
  AUTHOR,
  changedFiles,
  checkContractCopies,
  checkProtectedPaths,
  classifyAgentRun,
  classifyDiagnoseRun,
  classifyLocateRun,
  classifyReviewRun,
  combineReviewRuns,
  type DiagnoseOutput,
  DiagnoseOutputSchema,
  type DockerCli,
  type Environment,
  EnvironmentError,
  type EnvironmentRepo,
  failedCasesOf,
  type GateBaseline,
  type GateConfig,
  type GateOutcome,
  type GateRecords,
  type GateSandbox,
  GateSetupError,
  type GeneratedGroup,
  generatedCommandsNote,
  generatedGroupsFor,
  generatedOnlyConflicts,
  git,
  gitOrThrow,
  hasRef,
  ImplementOutputSchema,
  isAncestor,
  type LocateOutput,
  LocateOutputSchema,
  mergeCandidate,
  mergeGateCompare,
  mergeTakingOurs,
  projectOf,
  promptFor,
  type RunGateInput,
  readGateConfig,
  reclaimEnvironments,
  renderContext,
  reviewFindings,
  reviewOutputSchemaFor,
  reviewSources,
  runE2e,
  runGate,
  type SandboxPlacement,
  type SandboxSession,
  stampTrailers,
  startEnvironment,
  type TestName,
  writePrompt,
} from "@afk/pipeline";
import {
  type Bundle,
  classifyPushError,
  formatPushFailure,
  isNetworkPushError,
  listedDecisionsForReview,
  modelFor,
  type PushFailureTips,
  type ReviewAxis,
  reviewAxesFor,
  unrecoverableJobError,
} from "@afk/shared";
import {
  alignTicketBranch,
  originSha,
  type TicketAlign,
} from "./align-ticket-branch.ts";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { fetchContracts } from "./contracts.ts";
import { type Credentials, withCredentials } from "./credentials.ts";
import { cutIntegrationBranch, fetchDomain } from "./domain.ts";
import type { EnvironmentLimiter } from "./environments.ts";
import { blameLocateFiles } from "./locate.ts";
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
  api: Pick<WorkerApi, "prePush" | "gateResult">; // supplied by the worker loop
  // What an integration environment needs: docker, and the limit on how many a worker runs at once.
  docker?: DockerCli;
  environments?: EnvironmentLimiter;
  makeAgentRunner(slotDir: string, runId?: string): AgentRunner;
  makeGateSandbox(slotDir: string, runId?: string): GateSandbox;
  tmpRoot?: string;
  model?: string; // the worker's own model: what a project that sets none gets
  skillsSha?: string; // the skills version the worker checked at start-up; recorded on every agent Run
  secrets?: readonly string[]; // kept out of the raw event lines that are uploaded
  // A push that hit the network waits this long before retrying; tests replace it so they do not wait out 10–180 s.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StageContext {
  job: ClaimedJob;
  bundle: Bundle;
  signal: AbortSignal;
  log: (line: string) => void;
  logRaw: (line: string) => void; // goes to the Run's log only, not to the worker's own output
}

// What a run is asked for, from the project's say (the bundle) and the worker's own defaults.
function runOptions(
  deps: ExecutorDeps,
  context: StageContext,
  axis?: ReviewAxis,
) {
  const { bundle } = context;
  const model = modelFor({
    stage: bundle.job.stage,
    axis,
    stageModels: bundle.stageModels,
    defaultModel: bundle.model,
    workerModel: deps.model,
  });
  return {
    idleSeconds: bundle.limits.runIdleSeconds,
    wallClockMs: bundle.limits.runWallclockSeconds * 1000,
    ...(model ? { model } : {}),
    onRawLine: (line: string) =>
      context.logRaw(sanitizeRawLine(line, deps.secrets ?? [])),
  };
}

// Usage, API duration and CLI version from the Cursor result line, to keep on a Run after the agent.
function billedFacts(
  run: {
    tokenUsage?: unknown;
    durationApiMs?: number;
    cursorCliVersion?: string;
  } = {},
) {
  return {
    ...(run.tokenUsage !== undefined ? { tokenUsage: run.tokenUsage } : {}),
    ...(run.durationApiMs !== undefined
      ? { durationApiMs: run.durationApiMs }
      : {}),
    ...(run.cursorCliVersion ? { cursorCliVersion: run.cursorCliVersion } : {}),
  };
}

type BilledFacts = ReturnType<typeof billedFacts> & { axis?: ReviewAxis };

// What a Run records about the agent that ran: model, skills, prompt, and the Cursor result-line facts.
function agentFacts(
  deps: ExecutorDeps,
  options: { model?: string },
  prompt: string,
  run?: {
    tokenUsage?: unknown;
    durationApiMs?: number;
    cursorCliVersion?: string;
  },
) {
  return {
    prompt,
    ...(options.model ? { model: options.model } : {}),
    ...(deps.skillsSha ? { skillsSha: deps.skillsSha } : {}),
    ...billedFacts(run),
  };
}

// A problem with the worker's own environment, not with the ticket: the job fails and is dispatched again,
// unless the error is one that will not recover by running it again (Cursor auth, a bad model, a spent quota,
// a failed integration image build). Those are rewritten here to the human sentence the brief shows.
export class InfrastructureError extends Error {
  readonly run?: BilledFacts;
  readonly extraRuns?: BilledFacts[];
  constructor(message: string, run?: BilledFacts, extraRuns?: BilledFacts[]) {
    super(unrecoverableJobError(message) ?? message);
    this.run = run;
    this.extraRuns = extraRuns;
  }
}
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
  if (bundle.job.stage === "locate-bug") return locateBug(rawDeps, context);
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

const SKIP_TICKET_ALIGN = new Set(["e2e", "diagnose", "final-review"]);

function orphanRunFields(align: TicketAlign): {
  orphanRef?: string;
  orphanSha?: string;
} {
  return align.orphan
    ? { orphanRef: align.orphan.ref, orphanSha: align.orphan.sha }
    : {};
}

function assertRemoteUnchanged(
  repoDir: string,
  branch: string,
  expectedOld: string,
  run?: ReturnType<typeof billedFacts>,
): void {
  const now = originSha(repoDir, branch) ?? "";
  if (now !== expectedOld) {
    throwPushFailure(
      "stale info",
      {
        remoteTip: now,
        startedFrom: expectedOld,
      },
      run,
    );
  }
}

async function publishLocalAhead(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  agent: string,
): Promise<void> {
  const local = hasRef(mainDir, `refs/heads/${agent}`)
    ? tip(mainDir, agent)
    : undefined;
  const remote = originSha(mainDir, agent);
  if (
    !local ||
    !remote ||
    local === remote ||
    !isAncestor(mainDir, remote, local)
  )
    return;
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
    expectedOld: remote,
  });
  if (!pushed.ok) {
    throwPushFailure(pushed.error, {
      remoteTip: originSha(mainDir, agent) ?? "",
      startedFrom: remote,
    });
  }
}

function publishedTip(mainDir: string, agent: string): string {
  const remote = originSha(mainDir, agent);
  const local = hasRef(mainDir, `refs/heads/${agent}`)
    ? tip(mainDir, agent)
    : undefined;
  if (remote && local && remote !== local) {
    throwPushFailure("stale info", {
      remoteTip: remote,
      startedFrom: local,
    });
  }
  const sha = remote ?? local;
  if (!sha)
    throw new InfrastructureError(`${agent} is not on origin or locally`);
  return sha;
}

async function runStage(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const integration = bundle.integrationBranch as string;
  const restart =
    bundle.job.stage === "implement" && bundle.ticket?.restart === true;
  const align = SKIP_TICKET_ALIGN.has(bundle.job.stage)
    ? { expectedOld: "" }
    : alignTicketBranch(mainDir, bundle.agentBranch, { restart });
  if (restart)
    context.log(
      `restart: dropped ${bundle.agentBranch}${align.remoteTip ? ` (origin was ${align.remoteTip})` : ""}`,
    );
  if (align.orphan)
    context.log(
      `align: ${bundle.agentBranch} follows origin ${align.remoteTip}; kept ${align.orphan.sha} at ${align.orphan.ref}`,
    );
  bringBranches(slot, mainDir, [integration, bundle.agentBranch]);
  switch (bundle.job.stage) {
    case "implement":
    case "gate-fix":
    case "review-fix":
    case "merge-fix":
    case "final-fix":
      return agentChange(deps, context, mainDir, slot, align);
    case "review":
    case "final-review":
      return review(deps, context, mainDir, slot, align);
    case "gate":
      return gate(deps, context, mainDir, slot, align);
    case "merge":
    case "final-merge":
      return merge(deps, context, mainDir, slot, align);
    case "update-branch":
      return context.job.type === "agent-run"
        ? agentChange(deps, context, mainDir, slot, align)
        : merge(deps, context, mainDir, slot, align);
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
const originTip = originSha;

function throwPushFailure(
  error: string,
  tips: PushFailureTips,
  run?: ReturnType<typeof billedFacts>,
): never {
  const kind = classifyPushError(error);
  if (kind === "branch-moved" || kind === "host-permission") {
    throw new InfrastructureError(
      formatPushFailure(error, {
        remoteTip: tips.remoteTip ?? "",
        startedFrom: tips.startedFrom ?? "",
      }),
      run,
    );
  }
  throw new InfrastructureError(`push failed: ${error}`, run);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function renderFor(
  deps: ExecutorDeps,
  context: StageContext,
  baseSha: string,
  ctxRoot: string,
  mainDir: string,
) {
  const { bundle } = context;
  const dir = join(ctxRoot, "context");
  const domainFiles = fetchDomain(deps.repos, bundle.domain, bundle.repo.name);
  const integration = bundle.integrationBranch;
  renderContext({
    dir,
    bundle,
    run: {
      runId: runIdOf(bundle),
      baseSha,
      branch: bundle.agentBranch,
    },
    ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
    ...(bundle.failedCases?.length ? { failedCases: bundle.failedCases } : {}),
    ...(bundle.review ? { review: bundle.review } : {}),
    ...(bundle.contracts.length
      ? { contracts: fetchContracts(deps.repos, bundle.contracts) }
      : {}),
    ...(domainFiles ? { domain: domainFiles } : {}),
    ...(integration
      ? { gate: readGateConfig(mainDir, tip(mainDir, integration)) }
      : {}),
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
  align: TicketAlign,
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
  // Trailers only on commits origin does not already have. implement still owns unstamped salvaged
  // commits when this branch has never been on origin.
  const stampFrom =
    align.remoteTip ??
    (stage === "implement" &&
    !/^Run: /m.test(
      git(mainDir, ["log", "--format=%B", `${baseSha}..${before}`]).stdout,
    )
      ? baseSha
      : before);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(deps, context, baseSha, tmp, mainDir);
    const inEnvironment =
      bundle.ticket?.type === "integration" && bundle.environment.length > 0;
    const given = writePrompt(
      tmp,
      promptFor(stage, { integration: inEnvironment }),
    );
    const { refs, refShas } = snapshotRefs(deps, bundle);
    log(`${stage}: running the agent on ${agent}`);
    const options = runOptions(deps, context);
    assertRemoteUnchanged(mainDir, agent, align.expectedOld);
    // An integration ticket's agent works in its integration environment: it writes the e2e against real services,
    // and a fix reproduces the failure there. The environment is gone again when the run is over.
    const runAgent = (placement?: SandboxPlacement) =>
      deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
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
      throw new InfrastructureError(verdict.error, billedFacts(run));
    log(
      `${stage}: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    );

    const billed = billedFacts(run);
    const facts: Record<string, unknown> = {
      branch: agent,
      baseSha,
      commits: run.commits,
      durationMs: run.durationMs,
      ...agentFacts(deps, options, given.prompt, run),
      ...(refs.length ? { refShas } : {}),
      output: run.output ?? { error: run.error },
      ...orphanRunFields(align),
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
        billed,
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
      throw new InfrastructureError(
        `stamping failed: ${stamped.error}`,
        billed,
      );
    const request = {
      repoDir: mainDir,
      source: `refs/heads/${agent}`,
      target: `refs/heads/${agent}`,
      expectedOld: align.expectedOld,
    };
    // Network blips: wait 10, 30, 90, 180 s and push again from this run, so a flake does not re-run the agent.
    // Each attempt re-checks the job lease first: a worker that lost it must not publish anything.
    const waitSeconds = [10, 30, 90, 180];
    const wait = deps.sleep ?? sleep;
    let pushed: ReturnType<PushFn> = { ok: false, error: "" };
    for (let i = 0; i < waitSeconds.length; i++) {
      if (
        context.signal.aborted ||
        (await deps.api.prePush(context.job)) === "lost"
      ) {
        throw new JobLostError("the lease was lost before the push");
      }
      assertRemoteUnchanged(mainDir, agent, align.expectedOld, billed);
      pushed = deps.push(request);
      if (pushed.ok) break;
      if (!isNetworkPushError(pushed.error) || i === waitSeconds.length - 1)
        break;
      await wait(waitSeconds[i] * 1000, context.signal);
    }
    if (!pushed.ok)
      throwPushFailure(
        pushed.error,
        {
          remoteTip: originTip(mainDir, request.target),
          startedFrom: align.expectedOld,
        },
        billed,
      );
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
  align: TicketAlign,
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
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  // Ticket-level review is Spec-only by default; final-review (and ticketReview: both) still run both axes.
  // A branch can be checked out in one sandbox only, so each axis gets a branch of its own at the same commit,
  // which is gone again afterwards. A review only reads.
  const reviewed =
    stage === "final-review"
      ? tip(mainDir, bundle.integrationBranch as string)
      : publishedTip(mainDir, agent);
  const axes = reviewAxesFor(stage, bundle.ticketReview);
  const branches = new Map(
    axes.map((axis) => [axis, `review-${axis}/${subjectLabel(bundle)}`]),
  );
  for (const branch of branches.values())
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, reviewed]);
  try {
    bringBranches(slot, mainDir, [...branches.values()]);
    const ctxDir = renderFor(deps, context, baseSha, tmp, mainDir);
    const { refs, refShas } = snapshotRefs(deps, bundle);
    const runs = await Promise.all(
      axes.map(async (axis) => {
        const given = writePrompt(join(tmp, axis), promptFor(stage, { axis }));
        const options = runOptions(deps, context, axis);
        const run = await deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
          stage,
          branch: branches.get(axis) as string,
          baseBranch: bundle.integrationBranch as string,
          promptFile: given.promptFile,
          ctxDir,
          refs,
          schema: reviewOutputSchemaFor(axis),
          ...options,
          signal: context.signal,
        });
        return { axis, given, run, options };
      }),
    );
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the review");
    const byAxis = Object.fromEntries(
      runs.map((r) => [r.axis, r.run]),
    ) as Partial<Record<ReviewAxis, (typeof runs)[number]["run"]>>;
    let { classification: verdict } = combineReviewRuns(byAxis);
    if (
      verdict.kind === "outcome" &&
      (verdict.outcome === "pass" || verdict.outcome === "fix") &&
      byAxis.spec
    ) {
      const listed = listedDecisionsForReview(
        bundle.decisionLog,
        stage === "final-review" ? "spec" : "ticket",
      );
      const rulings = classifyReviewRun(byAxis.spec, listed);
      if (rulings.kind === "outcome" && rulings.outcome === "invalid-output") {
        verdict = rulings;
      }
    }
    if (verdict.kind === "infrastructure-failure") {
      const [first, ...others] = runs;
      throw new InfrastructureError(
        verdict.error,
        first ? { ...billedFacts(first.run), axis: first.axis } : undefined,
        others.map((r) => ({ ...billedFacts(r.run), axis: r.axis })),
      );
    }
    log(`${stage}: ${verdict.outcome}`);
    for (const { axis, run } of runs)
      if (run.commits.length > 0)
        log(
          `review: WARNING the ${axis} review made ${run.commits.length} commit(s); it should only read`,
        );
    const factsOf = ({ axis, given, run, options }: (typeof runs)[number]) => {
      const sources = reviewSources(run.output);
      return {
        axis,
        run: {
          // what this axis came to on its own; the stage's outcome is the two put together
          result: axisResult(run),
          branch: agent,
          baseSha,
          commits: run.commits,
          durationMs: run.durationMs,
          ...agentFacts(deps, options, given.prompt, run),
          ...(refs.length ? { refShas } : {}),
          output: run.output ?? { error: run.error },
          ...(sources ? { sources } : {}),
        },
        findings: run.output ? reviewFindings(run.output) : [],
      };
    };
    const [first, ...others] = runs.map(factsOf);
    return {
      stage,
      outcome: verdict.outcome,
      // the first axis is the job's own Run; any other axis is recorded beside it
      run: { ...first?.run, axis: first?.axis, ...orphanRunFields(align) },
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
  };
}

function gateFailureOutput(outcome: GateOutcome) {
  const failedCases = failedCasesOf(outcome.testCases);
  return {
    failureLog: outcome.failureLog,
    reasons: outcome.reasons,
    ...(failedCases ? { failedCases } : {}),
    ...(outcome.removedTests ? { removedTests: outcome.removedTests } : {}),
  };
}

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

function gateOutcomeOf(
  outcome: GateOutcome,
): "passed" | "failed" | "tests-removed" {
  if (outcome.pass) return "passed";
  if (outcome.removedTests && outcome.removedTests.length > 0)
    return "tests-removed";
  return "failed";
}

function logGate(log: (line: string) => void, outcome: GateOutcome) {
  if (outcome.reusedFrom)
    log(
      `gate: reused the result of ${outcome.reusedFrom}: the same tree under the same gates.yaml`,
    );
  for (const step of outcome.steps)
    log(`gate: ${step.name} exit ${step.exitCode} (${step.ms} ms)`);
  for (const [name, text] of Object.entries(outcome.stepLogs))
    log(`--- ${name} ---\n${text}`);
}

// Earlier gates of the job's repo, as the platform stored them.
function gateRecords(deps: ExecutorDeps, context: StageContext): GateRecords {
  return {
    findPassed: (tree, configBlob) =>
      deps.api.gateResult(context.job, { tree, configBlob }),
  };
}

// A gate whose setup failed (dependencies would not install, a database would not start) says nothing about the
// change: the job fails and is dispatched again, instead of an agent being sent to fix the code.
async function runGateStep(input: RunGateInput): Promise<GateOutcome> {
  try {
    return await runGate(input);
  } catch (error) {
    if (error instanceof GateSetupError)
      throw new InfrastructureError(error.message);
    throw error;
  }
}

async function gate(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  align: TicketAlign,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  await publishLocalAhead(deps, context, mainDir, agent);
  const commitSha = publishedTip(mainDir, agent);
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
        ...orphanRunFields(align),
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
        ...orphanRunFields(align),
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
      ...orphanRunFields(align),
    },
    gate: gateFacts(outcome),
  };
}

const MAX_MERGE_ATTEMPTS = 3;

// If the integration branch moved while the candidate was being gated, --force-with-lease refuses the push. The
// answer is not to fail but to fetch and begin again: a new candidate on the new tip, gated again.
async function merge(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  align: TicketAlign,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  let ticketAlign = align;
  for (let attempt = 1; ; attempt++) {
    const outcome = await mergeOnce(deps, context, mainDir, slot, ticketAlign);
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
    ticketAlign = alignTicketBranch(mainDir, bundle.agentBranch);
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
      const result = await session.exec(group.run, {
        timeoutSeconds: GENERATE_TIMEOUT_SECONDS,
      });
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
  align: TicketAlign,
): Promise<StageOutcomeBody | { integrationMoved: string }> {
  const { bundle, log, job } = context;
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  const integrationRef = `refs/heads/${integration}`;
  const stage = bundle.job.stage;
  if (exists(mainDir, agent) || originSha(mainDir, agent)) {
    await publishLocalAhead(deps, context, mainDir, agent);
    if (exists(mainDir, agent) || originSha(mainDir, agent))
      publishedTip(mainDir, agent);
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
      run: { headSha: head, ...orphanRunFields(align) },
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
  const pushed = deps.push({
    repoDir: mainDir,
    source: candidateSha,
    target: integrationRef,
    expectedOld: oldTip,
  });
  if (!pushed.ok) {
    if (classifyPushError(pushed.error) === "host-permission") {
      throwPushFailure(pushed.error, {
        remoteTip: originTip(mainDir, integrationRef),
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
      ...orphanRunFields(align),
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
    const ctxDir = renderFor(deps, context, head, tmp, mainDir);
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
          run: await deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
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

// Locate: every project default branch in one sandbox (workspace + /refs), no
// compose. The agent names one repo; blame of those files yields the original spec.
async function locateBug(
  rawDeps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const deps = await withCredentials(rawDeps, bundle.repo.url, [
    ...bundle.refs.map((r) => r.url),
    ...(bundle.domain ? [bundle.domain.url] : []),
  ]);
  const defaultBranch = bundle.repo.defaultBranch;
  const mainDir = deps.repos.ensure(
    bundle.repo.name,
    bundle.repo.url,
    defaultBranch,
  );
  const head = tip(mainDir, defaultBranch);
  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.name,
    repoUrl: bundle.repo.url,
    ref: bundle.agentBranch,
    defaultBranch,
  });
  if (!slot) throw new NoFreeSlotError("no free slot");
  let body: StageOutcomeBody | undefined;
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(deps, context, head, tmp, mainDir);
    const given = writePrompt(tmp, promptFor("locate-bug"));
    const { refs, refShas } = snapshotRefs(deps, bundle);
    const options = runOptions(deps, context);
    const branch = bundle.agentBranch;
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, head]);
    try {
      bringBranches(slot, mainDir, [branch]);
      context.log(`locate-bug: running the agent on ${defaultBranch}`);
      const run = await deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
        stage: "locate-bug",
        branch,
        baseBranch: defaultBranch,
        promptFile: given.promptFile,
        ctxDir,
        refs,
        schema: LocateOutputSchema,
        ...options,
        signal: context.signal,
      });
      if (context.signal.aborted)
        throw new JobLostError("the lease was lost during locate");
      const verdict = classifyLocateRun(run);
      if (verdict.kind === "infrastructure-failure")
        throw new InfrastructureError(verdict.error, billedFacts(run));
      context.log(
        `locate-bug: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
      );
      if (run.commits.length > 0)
        context.log(
          `locate-bug: WARNING the agent made ${run.commits.length} commit(s); it should only look, and they are dropped`,
        );
      const output: LocateOutput | undefined = run.output;
      const locate = output
        ? {
            repo: output.repo,
            files: output.files,
            evidence: output.evidence,
            reproduction: output.reproduction,
            commits: blamedLocateCommits(deps, bundle, output),
          }
        : undefined;
      body = {
        stage: "locate-bug",
        outcome: verdict.outcome,
        ...(locate ? { locate } : {}),
        run: {
          branch: defaultBranch,
          headSha: head,
          refShas,
          durationMs: run.durationMs,
          ...agentFacts(deps, options, given.prompt, run),
          output: output ?? { error: run.error },
        },
      };
      return body;
    } finally {
      git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await slot.release(body ? "success" : "failure");
  }
}

function blamedLocateCommits(
  deps: ExecutorDeps,
  bundle: Bundle,
  output: LocateOutput,
) {
  if (output.files.length === 0) return [];
  const named =
    output.repo === bundle.repo.name
      ? bundle.repo
      : bundle.refs.find((ref) => ref.name === output.repo);
  if (!named) return [];
  const clone = deps.repos.ensure(named.name, named.url, named.defaultBranch);
  return blameLocateFiles(clone, output.files, named.defaultBranch);
}
